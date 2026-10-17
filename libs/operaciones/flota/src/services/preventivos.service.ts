import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { calcularAlertas, type ReglaAlerta, type UltimoPreventivo } from '../catalog/alertas';
import type { EjecutadoPor, Prisma, TipoServicioPreventivo } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { LECTURA_DE_TIPO, LecturasService, type ActorLectura } from './lecturas.service';

export interface PreventivoEntrada {
  /** A o B; solo en las unidades de servicio. */
  tipoServicio?: TipoServicioPreventivo | null;
  /** Día en que se hizo (`AAAA-MM-DD`). */
  fecha: string;
  /** Horómetro (servicio) o kilometraje (transporte) al hacerlo; las auxiliares no lo llevan. */
  valor?: number | null;
  ejecutadoPor: EjecutadoPor;
  /** Obligatorio si lo hizo un tercero. */
  proveedorMantenimientoId?: string | null;
  /** Quien lo hizo; por omisión, quien lo registra. */
  responsableId?: string | null;
  observaciones?: string | null;
  checklistArchivoId?: string | null;
}

const fechaDia = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Mantenimientos preventivos de las unidades y sus alertas (MAN-002). Mantenimiento registra el preventivo A TRAVÉS de este servicio
 * (contrato 4.3): aquí queda el registro, la lectura de ese momento y el contador reiniciado; nadie más escribe esas tablas.
 */
@Injectable()
export class PreventivosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lecturas: LecturasService,
    private readonly bus: EventBus,
  ) {}

  async registrar(
    unidadId: string,
    e: PreventivoEntrada,
    actor: ActorLectura,
    tx?: Prisma.TransactionClient,
  ) {
    return tx
      ? this.registrarEnTx(tx, unidadId, e, actor)
      : this.prisma.$transaction((t) => this.registrarEnTx(t, unidadId, e, actor));
  }

  private async registrarEnTx(
    tx: Prisma.TransactionClient,
    unidadId: string,
    e: PreventivoEntrada,
    actor: ActorLectura,
  ) {
    const unidad = await tx.unidad.findUnique({ where: { id: unidadId } });
    if (!unidad) throw new NotFoundException('La unidad no existe');
    if (!unidad.activa) {
      throw new BadRequestException({
        message: 'La unidad está dada de baja',
        code: 'unidad_inactiva',
      });
    }

    const tipoServicio = e.tipoServicio ?? null;
    if (unidad.tipo === 'servicio' && !tipoServicio) {
      throw new BadRequestException({
        message: 'Indique el tipo de servicio (A o B) del mantenimiento',
        code: 'tipo_servicio_requerido',
      });
    }
    if (unidad.tipo !== 'servicio' && tipoServicio) {
      throw new BadRequestException({
        message: 'Solo las unidades de servicio tienen mantenimiento de tipo A o B',
        code: 'tipo_servicio_no_aplica',
      });
    }
    const tipoLectura = LECTURA_DE_TIPO[unidad.tipo];
    const valor = e.valor ?? null;
    // Una unidad que nunca tuvo lectura (p. ej. una cisterna sin horómetro) se controla solo por tiempo: no la exige.
    const tuvoLectura =
      tipoLectura !== null &&
      (await tx.unidadLectura.count({
        where: { unidadId, tipo: tipoLectura, anulacion: { is: null } },
      })) > 0;
    if (tipoLectura && valor === null && tuvoLectura) {
      throw new BadRequestException({
        message:
          tipoLectura === 'horometro'
            ? 'Indique las horas del horómetro al hacer el mantenimiento'
            : 'Indique el kilometraje al hacer el mantenimiento',
        code: 'lectura_requerida',
      });
    }
    if (!tipoLectura && valor !== null) {
      throw new BadRequestException({
        message:
          'Las unidades auxiliares se controlan por tiempo: no llevan horómetro ni kilometraje',
        code: 'unidad_sin_lectura',
      });
    }

    const fecha = fechaDia(e.fecha);
    const ahora = new Date();
    if (fecha.getTime() > ahora.getTime()) {
      throw new BadRequestException({
        message: 'La fecha del mantenimiento no puede ser futura',
        code: 'fecha_futura',
      });
    }
    if (e.ejecutadoPor === 'tercero') {
      const p = e.proveedorMantenimientoId
        ? await tx.proveedorMantenimiento.findUnique({ where: { id: e.proveedorMantenimientoId } })
        : null;
      if (!p?.activo) {
        throw new BadRequestException({
          message: 'Elija el proveedor que hizo el mantenimiento',
          code: 'proveedor_requerido',
        });
      }
    }
    const responsableId = e.responsableId ?? actor.id;
    const responsable = await tx.idUsuario.findUnique({ where: { id: responsableId } });
    if (!responsable?.activo) {
      throw new BadRequestException({
        message: 'El responsable del mantenimiento no es una cuenta activa',
        code: 'responsable_invalido',
      });
    }

    const id = uuidv7();
    let lecturaId: string | null = null;
    if (tipoLectura && valor !== null) {
      // Si la lectura es la más reciente (lo normal) queda con la hora actual; si es de un mantenimiento pasado, con el mediodía de su día.
      const vigente = await tx.unidadLectura.findFirst({
        where: { unidadId, tipo: tipoLectura, anulacion: { is: null } },
        orderBy: [{ leidaAt: 'desc' }, { createdAt: 'desc' }],
        select: { valor: true },
      });
      const alDia = !vigente || valor >= Number(vigente.valor);
      const medioDia = new Date(fecha.getTime() + 12 * 60 * 60 * 1000);
      const l = await this.lecturas.registrar(
        unidadId,
        {
          tipo: tipoLectura,
          valor,
          leidaAt: alDia || medioDia.getTime() > ahora.getTime() ? ahora : medioDia,
          fuente: 'mantenimiento',
        },
        actor,
        tx,
      );
      lecturaId = l.id;
    }
    const fila = await tx.unidadPreventivo.create({
      data: {
        id,
        unidadId,
        tipoServicio,
        fecha,
        lecturaId,
        ejecutadoPor: e.ejecutadoPor,
        proveedorMantenimientoId: e.ejecutadoPor === 'tercero' ? e.proveedorMantenimientoId : null,
        responsableId,
        origen: 'aplicacion',
        observaciones: e.observaciones?.trim() || null,
        checklistArchivoId: e.checklistArchivoId ?? null,
        createdBy: actor.id,
      },
    });
    await this.bus.publish(
      tx,
      createEvent({
        type: 'flota.unidad.preventivo_registrado',
        source: 'flota',
        subject: { type: 'flota_unidad', id: unidadId },
        data: {
          unidadId,
          codigo: unidad.codigo,
          preventivoId: id,
          tipoServicio,
          fecha: dia(fecha),
          valor,
          ejecutadoPor: e.ejecutadoPor,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
    return this.presentar(fila, valor);
  }

  /** Anula un mantenimiento preventivo mal registrado (la historia no se edita ni se borra); el contador se recalcula sin él. */
  async anular(preventivoId: string, motivo: string, actor: ActorLectura) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.unidadPreventivo.findUnique({
        where: { id: preventivoId },
        include: { anulacion: true, unidad: { select: { codigo: true } } },
      });
      if (!p) throw new NotFoundException('El mantenimiento no existe');
      if (p.anulacion) {
        throw new ConflictException({
          message: 'El mantenimiento ya está anulado',
          code: 'preventivo_ya_anulado',
        });
      }
      await tx.unidadPreventivoAnulacion.create({
        data: { preventivoId, anuladaPor: actor.id, motivo: motivo.trim() },
      });
      await this.bus.publish(
        tx,
        createEvent({
          type: 'flota.unidad.preventivo_anulado',
          source: 'flota',
          subject: { type: 'flota_unidad', id: p.unidadId },
          data: { unidadId: p.unidadId, codigo: p.unidad.codigo, preventivoId },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return { preventivoId, anulado: true };
    });
  }

  /** Historial de preventivos de una unidad, del más reciente al más antiguo. */
  async listar(unidadId: string) {
    const unidad = await this.prisma.unidad.findUnique({
      where: { id: unidadId },
      select: { id: true },
    });
    if (!unidad) throw new NotFoundException('La unidad no existe');
    const filas = await this.prisma.unidadPreventivo.findMany({
      where: { unidadId },
      include: {
        anulacion: true,
        lectura: true,
        proveedorMantenimiento: true,
        responsable: true,
        checklistArchivo: true,
      },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
    });
    return filas.map((f) => ({
      ...this.presentar(f, f.lectura ? Number(f.lectura.valor) : null),
      proveedor: f.proveedorMantenimiento
        ? { id: f.proveedorMantenimiento.id, nombre: f.proveedorMantenimiento.nombre }
        : null,
      responsable: f.responsable ? { id: f.responsable.id, nombre: f.responsable.nombre } : null,
      origen: f.origen,
      anulado: f.anulacion ? { at: f.anulacion.anuladaAt, motivo: f.anulacion.motivo } : null,
      checklistArchivo: f.checklistArchivo
        ? { id: f.checklistArchivo.id, nombre: f.checklistArchivo.nombreOriginal }
        : null,
    }));
  }

  /**
   * Alertas preventivas de las unidades activas (o de las indicadas), de la más urgente a la menos. Calculadas con las reglas de la
   * tabla `regla_preventiva`, la lectura vigente y el último preventivo de cada unidad.
   */
  async alertas(opciones: { unidadIds?: string[]; nivel?: 'rojo' | 'amarillo' | 'verde' } = {}) {
    const unidades = await this.prisma.unidad.findMany({
      where: { activa: true, ...(opciones.unidadIds ? { id: { in: opciones.unidadIds } } : {}) },
      select: { id: true, codigo: true, nombre: true, tipo: true },
      orderBy: { codigo: 'asc' },
    });
    const ids = unidades.map((u) => u.id);
    const [reglas, vigentes, preventivos] = await Promise.all([
      this.prisma.reglaPreventiva.findMany({ where: { activa: true } }),
      this.lecturas.vigentes(ids),
      this.prisma.unidadPreventivo.findMany({
        where: { unidadId: { in: ids }, anulacion: { is: null } },
        include: { lectura: { select: { valor: true } } },
        orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    const reglasAlerta: ReglaAlerta[] = reglas.map((r) => ({
      codigo: r.codigo,
      tipoUnidad: r.tipoUnidad,
      tipoServicio: r.tipoServicio,
      metrica: r.metrica,
      intervalo: r.intervalo,
      tolerancia: r.tolerancia,
      descripcion: r.descripcion,
    }));
    const ahora = new Date();
    const orden = { rojo: 0, amarillo: 1, verde: 2 } as const;
    const resultado = unidades.flatMap((u) => {
      const propios = preventivos.filter((p) => p.unidadId === u.id);
      const ultimo = (f: (p: (typeof propios)[number]) => boolean): UltimoPreventivo | null => {
        const p = propios.find(f);
        return p ? { fecha: p.fecha, valor: p.lectura ? Number(p.lectura.valor) : null } : null;
      };
      const lectura = LECTURA_DE_TIPO[u.tipo];
      const alertas = calcularAlertas(reglasAlerta, {
        tipo: u.tipo,
        lecturaVigente: lectura ? (vigentes.get(u.id)?.[lectura]?.valor ?? null) : null,
        ultimoA: ultimo((p) => p.tipoServicio === 'a'),
        ultimoB: ultimo((p) => p.tipoServicio === 'b'),
        ultimoCualquiera: ultimo(() => true),
        ahora,
      });
      return alertas.map((a) => ({ unidad: u, ...a }));
    });
    return resultado
      .filter((a) => !opciones.nivel || a.nivel === opciones.nivel)
      .sort((a, b) => orden[a.nivel] - orden[b.nivel] || a.restante - b.restante);
  }

  private presentar(
    f: {
      id: string;
      unidadId: string;
      tipoServicio: TipoServicioPreventivo | null;
      fecha: Date;
      lecturaId: string | null;
      ejecutadoPor: EjecutadoPor;
      observaciones: string | null;
    },
    valor: number | null,
  ) {
    return {
      id: f.id,
      unidadId: f.unidadId,
      tipoServicio: f.tipoServicio,
      fecha: dia(f.fecha),
      lecturaId: f.lecturaId,
      valor,
      ejecutadoPor: f.ejecutadoPor,
      observaciones: f.observaciones,
    };
  }
}
