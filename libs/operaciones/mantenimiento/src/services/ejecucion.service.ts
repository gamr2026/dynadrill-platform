import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { Permission } from '@dyn/authz';
import { EventBus } from '@dyn/messaging';
import { MovimientosService } from '@dyn/inventario';
import { uuidv7 } from '@dyn/utils';
import { ESTADO } from '../catalog/sembrar-catalogos';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { INCLUIR_SUBORDEN_DETALLE, vistaSuborden } from './suborden-vista';

/**
 * Un repuesto usado. Es **de catálogo** (artículo de Inventario y la bodega de la que sale) o **de texto** (número de parte y
 * descripción, cuando el repuesto no existe en el catálogo). Nunca las dos cosas: la base lo exige.
 */
export interface RepuestoEntrada {
  articuloId?: string | null;
  bodegaId?: string | null;
  numeroParte?: string | null;
  descripcion?: string | null;
  cantidad: number;
}

export interface AvanceEntrada {
  diagnostico?: string | null;
  actividadesCorrectivas?: string | null;
  horasTrabajo?: number | null;
  trabajosAdicionales?: string | null;
  /** Si viene, reemplaza la lista completa de repuestos de la sub-orden. */
  repuestos?: RepuestoEntrada[];
}

/** Estados en los que el operador todavía puede registrar avance. */
const EDITABLES: ReadonlySet<string> = new Set([
  ESTADO.pendiente,
  ESTADO.enDiagnostico,
  ESTADO.enEjecucion,
  ESTADO.correccionSolicitada,
]);

const INCLUIR = {
  ...INCLUIR_SUBORDEN_DETALLE,
  orden: { include: { reporte: { include: { unidad: true } } } },
} satisfies Prisma.SubordenInclude;

type SubordenConDatos = Prisma.SubordenGetPayload<{ include: typeof INCLUIR }>;

/**
 * Ejecución y cierre de una sub-orden (M2): el operador registra el avance (diagnóstico, actividades, horas y repuestos), la envía a
 * revisión, y el Jefe de Mantenimiento la aprueba o pide una corrección. Al aprobar, los repuestos del catálogo salen de bodega por
 * el kardex de Inventario. La derivación de la sub-orden operativa a Pumping y el retorno de la unidad a operación son de otro tramo.
 */
@Injectable()
export class EjecucionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly inventario: MovimientosService,
  ) {}

  async obtener(id: string) {
    return this.vista(await this.cargar(id));
  }

  /** Guarda el avance. La primera vez (o tras una corrección) la sub-orden pasa a «En ejecución». */
  async guardarAvance(id: string, avance: AvanceEntrada, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.cargar(id, tx);
      this.exigirResponsable(s, actor);
      this.exigirAsignable(s);
      if (!EDITABLES.has(s.estado.codigo)) {
        throw new ConflictException({
          message: `La sub-orden está «${s.estado.nombre}»: ya no se puede editar el avance`,
          code: 'SUBORDEN_NO_EDITABLE',
        });
      }
      const repuestos = avance.repuestos ? await this.validarRepuestos(tx, avance.repuestos) : null;
      const estadoId =
        s.estado.codigo === ESTADO.enEjecucion
          ? s.estadoId
          : await this.transicionar(tx, s, ESTADO.enEjecucion);

      await tx.suborden.update({
        where: { id },
        data: {
          estadoId,
          ...(avance.diagnostico !== undefined
            ? { diagnostico: avance.diagnostico?.trim() || null }
            : {}),
          ...(avance.actividadesCorrectivas !== undefined
            ? { actividadesCorrectivas: avance.actividadesCorrectivas?.trim() || null }
            : {}),
          ...(avance.horasTrabajo !== undefined ? { horasTrabajo: avance.horasTrabajo } : {}),
          ...(avance.trabajosAdicionales !== undefined
            ? { trabajosAdicionales: avance.trabajosAdicionales?.trim() || null }
            : {}),
          ...(s.ejecucionIniciadaAt ? {} : { ejecucionIniciadaAt: new Date() }),
          updatedBy: actor.id,
        },
      });
      if (repuestos) {
        await tx.subordenRepuesto.deleteMany({ where: { subordenId: id } });
        for (const r of repuestos) {
          await tx.subordenRepuesto.create({
            data: { id: uuidv7(), subordenId: id, ...r, createdBy: actor.id, updatedBy: actor.id },
          });
        }
      }
    });
    return this.obtener(id);
  }

  /** El operador termina y envía la sub-orden al Jefe de Mantenimiento. */
  async enviarARevision(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.cargar(id, tx);
      this.exigirResponsable(s, actor);
      this.exigirAsignable(s);
      if (!s.actividadesCorrectivas?.trim()) {
        throw new BadRequestException({
          message: 'Registre las actividades correctivas antes de enviar a revisión',
          code: 'ACTIVIDADES_REQUERIDAS',
        });
      }
      const estadoId = await this.transicionar(tx, s, ESTADO.enRevisionCierre);
      await tx.suborden.update({
        where: { id },
        data: { estadoId, ejecucionTerminadaAt: new Date(), updatedBy: actor.id },
      });
      await this.publicar(tx, s, 'enviada_a_revision', actor);
    });
    return this.obtener(id);
  }

  /**
   * El Jefe aprueba el cierre. Primero salen de bodega los repuestos del catálogo (Inventario rechaza lo que no alcanza, y entonces no
   * cambia nada); después se cierra la sub-orden y cada renglón queda enlazado a su salida. Si el cierre se interrumpe entre una cosa y
   * la otra, se puede repetir: Inventario no duplica una salida ya registrada.
   */
  async aprobarCierre(id: string, actor: AuthUser) {
    const s = await this.cargar(id);
    this.exigirAsignable(s);
    const cerradoId = await this.transicionar(this.prisma, s, ESTADO.cerrado);
    const codigo = `${s.orden.reporte.codigo}-${s.tipo.sufijo}`;

    const pendientes = s.repuestos.filter((r) => r.articuloId && !r.movimientoId);
    const salidas = pendientes.length
      ? await this.inventario.registrarSalidasDeMantenimiento(
          pendientes.map((r) => ({
            subordenRepuestoId: r.id,
            articuloId: r.articuloId as string,
            bodegaId: r.bodegaId as string,
            cantidad: Number(r.cantidad),
            observacion: `Repuesto usado en la sub-orden ${codigo}`,
          })),
          actor,
        )
      : new Map<string, string>();

    await this.prisma.$transaction(async (tx) => {
      const cerrada = await tx.suborden.updateMany({
        where: { id, estadoId: s.estadoId },
        data: {
          estadoId: cerradoId,
          cierreAprobadoAt: new Date(),
          cierreAprobadoPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cerrada.count === 0) {
        throw new ConflictException({
          message: 'La sub-orden cambió mientras se aprobaba: revísela e inténtelo de nuevo',
          code: 'SUBORDEN_CAMBIO',
        });
      }
      for (const [repuestoId, movimientoId] of salidas) {
        await tx.subordenRepuesto.update({ where: { id: repuestoId }, data: { movimientoId } });
      }
      await this.publicar(tx, s, 'cerrada', actor);
    });
    return this.obtener(id);
  }

  /** El Jefe devuelve la sub-orden al operador, con la nota de lo que debe corregir. */
  async solicitarCorreccion(id: string, nota: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.cargar(id, tx);
      this.exigirAsignable(s);
      const estadoId = await this.transicionar(tx, s, ESTADO.correccionSolicitada, nota);
      await tx.suborden.update({
        where: { id },
        data: { estadoId, notaCorreccion: nota.trim(), updatedBy: actor.id },
      });
      await this.publicar(tx, s, 'correccion_solicitada', actor);
    });
    return this.obtener(id);
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────────

  private async cargar(id: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const s = await db.suborden.findUnique({ where: { id }, include: INCLUIR });
    if (!s) throw new NotFoundException('La sub-orden no existe');
    return s;
  }

  /** Quien tiene el permiso de gestión (Jefe, administradores) actúa sobre cualquiera; el operador, solo sobre la suya. */
  private exigirResponsable(s: SubordenConDatos, actor: AuthUser) {
    if (actor.permissions.includes(Permission.MANTENIMIENTO_GESTIONAR)) return;
    if (s.asignadaA !== actor.id) {
      throw new ForbiddenException('Esta sub-orden está asignada a otra persona');
    }
  }

  /** La sub-orden operativa no la ejecuta Mantenimiento: la atiende Pumping. */
  private exigirAsignable(s: SubordenConDatos) {
    if (!s.tipo.asignable) {
      throw new ConflictException({
        message: 'La sub-orden operativa la atiende Pumping, no Mantenimiento',
        code: 'SUBORDEN_OPERATIVA',
      });
    }
  }

  /** Estado destino si la máquina de estados (tabla `transicion_suborden`) permite el paso; si no, rechaza. */
  private async transicionar(
    db: Prisma.TransactionClient | PrismaService,
    s: SubordenConDatos,
    destino: string,
    nota?: string | null,
  ): Promise<string> {
    const d = await db.estadoSuborden.findUniqueOrThrow({ where: { codigo: destino } });
    const t = await db.transicionSuborden.findFirst({
      where: {
        origenId: s.estadoId,
        destinoId: d.id,
        OR: [{ tipoId: null }, { tipoId: s.tipoId }],
      },
    });
    if (!t) {
      throw new ConflictException({
        message: `La sub-orden está «${s.estado.nombre}» y no puede pasar a «${d.nombre}»`,
        code: 'TRANSICION_INVALIDA',
      });
    }
    if (t.requiereNota && !nota?.trim()) {
      throw new BadRequestException({
        message: 'Escriba la nota que explica el motivo',
        code: 'NOTA_REQUERIDA',
      });
    }
    return d.id;
  }

  /** Cada renglón es de catálogo o de texto; el artículo debe estar activo y la bodega habilitada; sin repeticiones. */
  private async validarRepuestos(tx: Prisma.TransactionClient, repuestos: RepuestoEntrada[]) {
    const vistos = new Set<string>();
    const salida = [];
    for (const r of repuestos) {
      const cantidad = Math.round(Number(r.cantidad) * 100) / 100;
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        throw new BadRequestException({
          message: 'La cantidad de cada repuesto debe ser mayor que cero (hasta 2 decimales)',
          code: 'CANTIDAD_INVALIDA',
        });
      }
      const parte = r.numeroParte?.trim() || null;
      if (r.articuloId) {
        if (parte || r.descripcion?.trim()) {
          throw new BadRequestException({
            message: 'Un repuesto del catálogo no lleva número de parte ni descripción',
            code: 'REPUESTO_MIXTO',
          });
        }
        if (!r.bodegaId) {
          throw new BadRequestException({
            message: 'Elija la bodega de la que sale cada repuesto del catálogo',
            code: 'BODEGA_REQUERIDA',
          });
        }
        const [articulo, bodega] = await Promise.all([
          tx.invArticulo.findUnique({ where: { id: r.articuloId } }),
          tx.catBodega.findUnique({ where: { id: r.bodegaId } }),
        ]);
        if (!articulo || !articulo.activo) {
          throw new BadRequestException({
            message: 'El repuesto elegido no existe o está inactivo',
            code: 'REPUESTO_INVALIDO',
          });
        }
        if (!bodega || !bodega.habilitado) {
          throw new BadRequestException({
            message: `La bodega elegida para ${articulo.codigo} no existe o está deshabilitada`,
            code: 'BODEGA_INVALIDA',
          });
        }
        if (vistos.has(`a:${r.articuloId}`)) {
          throw new BadRequestException({
            message: `El repuesto ${articulo.codigo} está repetido: sume las cantidades en un solo renglón`,
            code: 'REPUESTO_REPETIDO',
          });
        }
        vistos.add(`a:${r.articuloId}`);
        salida.push({ articuloId: r.articuloId, bodegaId: r.bodegaId, cantidad });
      } else {
        if (r.bodegaId || !parte) {
          throw new BadRequestException({
            message: 'Elija un repuesto del catálogo o escriba su número de parte',
            code: 'REPUESTO_INVALIDO',
          });
        }
        if (vistos.has(`p:${parte}`)) {
          throw new BadRequestException({
            message: `El número de parte ${parte} está repetido: sume las cantidades en un solo renglón`,
            code: 'REPUESTO_REPETIDO',
          });
        }
        vistos.add(`p:${parte}`);
        salida.push({ numeroParte: parte, descripcion: r.descripcion?.trim() || null, cantidad });
      }
    }
    return salida;
  }

  /** Avisa del cambio de estado de la sub-orden (las plantillas de aviso son de M4). */
  private async publicar(
    tx: Prisma.TransactionClient,
    s: SubordenConDatos,
    hecho: 'enviada_a_revision' | 'cerrada' | 'correccion_solicitada',
    actor: AuthUser,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type: `operaciones.mantenimiento.suborden.${hecho}`,
        subject: { type: 'mantenimiento_suborden', id: s.id },
        actor: { userId: actor.id, role: actor.roleCode },
        data: {
          subordenId: s.id,
          ordenId: s.ordenId,
          unidadId: s.orden.reporte.unidadId,
          tipo: s.tipo.codigo,
          ...(hecho === 'correccion_solicitada' && s.asignadaA
            ? { asignados: [{ usuarioId: s.asignadaA, rolCodigo: 'operador_mantenimiento' }] }
            : {}),
        },
      }),
    );
  }

  private vista(s: SubordenConDatos) {
    const r = s.orden.reporte;
    return {
      ...vistaSuborden(s, r.codigo),
      reporte: { id: r.id, codigo: r.codigo },
      unidad: { id: r.unidad.id, codigo: r.unidad.codigo, nombre: r.unidad.nombre },
    };
  }
}
