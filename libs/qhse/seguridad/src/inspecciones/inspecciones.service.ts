import { BadRequestException, Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador, masMeses } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import { ResultadoInspeccion } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { InspeccionesConsultaService, codigoInspeccion } from './inspecciones-consulta.service';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface RegistrarInspeccionEntrada {
  tipoId: string;
  equipoCodigo: string;
  unidadId?: string | null;
  unidadCodigo?: string | null;
  fecha?: string | null;
  bumpTestRealizado?: boolean | null;
  observaciones?: string | null;
  ticketId?: string | null;
  resultados: Array<{ criterioId: string; cumple: boolean }>;
}

/**
 * Inspección de campo (HSE-SEGUIMIENTO-001): eslinga de cable, detector de gas y vehículo-grúa. Cualquier usuario autenticado la registra
 * (la hace el personal operativo). Se evalúan TODOS los criterios del tipo; si alguno falla la inspección queda **rechazada** y el equipo en
 * cuarentena hasta una inspección nueva aprobada. Una inspección rechazada de un tipo que lo pide (vehículo-grúa) origina un reporte de
 * unidad para Mantenimiento: evento `qhse.reporte_unidad.generado` (contrato 4.6). La vigencia es trimestral. Son historia: no se editan.
 */
@Injectable()
export class InspeccionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: InspeccionesConsultaService,
  ) {}

  /** Devuelve solo lo mínimo (quien inspecciona puede no tener permiso de ver la bandeja). */
  async registrar(e: RegistrarInspeccionEntrada, actor: AuthUser) {
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const tipo = await tx.inspeccionTipo.findUnique({
        where: { id: e.tipoId },
        include: { criterios: { where: { activo: true }, orderBy: { orden: 'asc' } } },
      });
      if (!tipo?.activo)
        throw new BadRequestException('El tipo de inspección no existe o está inactivo');
      const codigoEquipo = texto(e.equipoCodigo);
      if (!codigoEquipo)
        throw new BadRequestException('Indique el equipo que inspecciona (su número o código)');
      if (tipo.requiereUnidad && !e.unidadId)
        throw new BadRequestException('Este tipo de inspección es de una unidad: elija cuál');
      if (!tipo.requiereUnidad && e.unidadId)
        throw new BadRequestException('Este tipo de inspección no es de una unidad de Flota');
      if (tipo.requiereBumpTest && typeof e.bumpTestRealizado !== 'boolean')
        throw new BadRequestException('Indique si se hizo el bump test');
      if (!tipo.requiereBumpTest && e.bumpTestRealizado != null)
        throw new BadRequestException('Este tipo de inspección no lleva bump test');
      if (e.ticketId && !(await tx.ticketRef.count({ where: { ticketId: e.ticketId } })))
        throw new BadRequestException('QHSE no conoce ese ticket');

      // se evalúan todos los criterios del tipo, una sola vez cada uno
      const evaluados = new Map(e.resultados.map((r) => [r.criterioId, r.cumple]));
      const faltan = tipo.criterios.filter((c) => !evaluados.has(c.id));
      if (faltan.length)
        throw new BadRequestException(
          `Evalúe todos los criterios. Falta: ${faltan.map((f) => f.nombre).join('; ')}`,
        );
      if (evaluados.size !== tipo.criterios.length)
        throw new BadRequestException('Hay criterios que no son de este tipo de inspección');
      const fallas = tipo.criterios.filter((c) => evaluados.get(c.id) === false);
      const resultado = fallas.length
        ? ResultadoInspeccion.rechazado
        : ResultadoInspeccion.aprobado;

      // el equipo es del catálogo: se busca por tipo y código sin mayúsculas ni espacios y, si no existe, se da de alta aquí mismo
      const normalizado = codigoEquipo.replace(/\s+/g, '').toLowerCase();
      const existentes = await tx.equipo.findMany({ where: { tipoId: tipo.id }, select: { id: true, codigo: true, activo: true } });
      let equipo = existentes.find((q) => q.codigo.replace(/\s+/g, '').toLowerCase() === normalizado);
      if (equipo && !equipo.activo)
        throw new BadRequestException('Ese equipo está dado de baja: no se puede inspeccionar');
      if (!equipo) {
        equipo = await tx.equipo.create({
          data: { id: uuidv7(), tipoId: tipo.id, codigo: codigoEquipo, createdBy: actor.id, updatedBy: actor.id },
          select: { id: true, codigo: true, activo: true },
        });
      }

      const fecha = e.fecha ?? hoyEcuador();
      await tx.inspeccion.create({
        data: {
          id,
          tipoId: tipo.id,
          equipoId: equipo.id,
          unidadId: e.unidadId ?? null,
          unidadCodigo: e.unidadId ? (texto(e.unidadCodigo) ?? equipo.codigo) : null,
          inspectorId: actor.id,
          fecha: aFecha(fecha),
          resultado,
          bumpTestRealizado: tipo.requiereBumpTest ? (e.bumpTestRealizado as boolean) : null,
          vigenteHasta: aFecha(masMeses(fecha, 3)),
          observaciones: texto(e.observaciones),
          ticketId: e.ticketId ?? null,
          createdBy: actor.id,
        },
      });
      await tx.inspeccionResultado.createMany({
        data: tipo.criterios.map((c) => ({
          inspeccionId: id,
          criterioId: c.id,
          cumple: evaluados.get(c.id) as boolean,
        })),
      });
      await this.publicar(tx, 'qhse.inspeccion.registrada', id, actor);
      // rechazada: además el hecho que avisa al equipo HSE (el equipo queda en cuarentena)
      if (resultado === ResultadoInspeccion.rechazado)
        await this.publicar(tx, 'qhse.inspeccion.rechazada', id, actor);
      // vehículo-grúa rechazada: caso para Mantenimiento (la sesión de Mantenimiento consume este evento, contrato 4.6)
      if (resultado === ResultadoInspeccion.rechazado && tipo.generaCasoMantenimiento) {
        await this.publicarCasoMantenimiento(
          tx,
          id,
          fallas.map((f) => f.nombre),
          actor,
        );
      }
    });
    const i = await this.prisma.inspeccion.findUniqueOrThrow({
      where: { id },
      select: { numero: true, resultado: true },
    });
    return {
      id,
      codigo: codigoInspeccion(i.numero),
      resultado: i.resultado,
      enCuarentena: i.resultado === ResultadoInspeccion.rechazado,
    };
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async publicar(tx: Tx, tipo: string, inspeccionId: string, actor: AuthUser) {
    const i = await tx.inspeccion.findUniqueOrThrow({
      where: { id: inspeccionId },
      include: {
        tipo: { select: { codigo: true, nombre: true } },
        inspector: { select: { nombre: true } },
        equipo: { select: { codigo: true } },
        ticket: { select: { ticketNumero: true, pedidoCodigo: true } },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'inspeccion', id: inspeccionId },
        data: {
          inspeccionId,
          numero: i.numero,
          codigo: codigoInspeccion(i.numero),
          tipo: i.tipo.codigo,
          // texto para el aviso (no cambia: es lo que se inspeccionó y quién lo hizo)
          tipoNombre: i.tipo.nombre,
          equipoCodigo: i.equipo.codigo,
          unidadId: i.unidadId,
          resultado: i.resultado,
          fecha: i.fecha.toISOString().slice(0, 10),
          vigenteHasta: i.vigenteHasta.toISOString().slice(0, 10),
          ticketId: i.ticketId,
          inspector: i.inspector.nombre,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }

  /** `casoId` es el id de la inspección (la referencia que Mantenimiento guarda sin FK, D1); la novedad es el único texto que se copia. */
  private async publicarCasoMantenimiento(
    tx: Tx,
    inspeccionId: string,
    fallas: string[],
    actor: AuthUser,
  ) {
    const i = await tx.inspeccion.findUniqueOrThrow({ where: { id: inspeccionId } });
    const novedad = `Vehículo-grúa rechazado en la inspección ${codigoInspeccion(i.numero)}. Criterios que fallan: ${fallas.join('; ')}.${i.observaciones ? ` Observaciones: ${i.observaciones}` : ''}`;
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'qhse.reporte_unidad.generado',
        subject: { type: 'inspeccion', id: inspeccionId },
        data: {
          casoId: inspeccionId,
          unidadId: i.unidadId,
          unidadCodigo: i.unidadCodigo,
          novedad,
          inspeccionId,
          codigo: codigoInspeccion(i.numero),
          fecha: i.fecha.toISOString().slice(0, 10),
          ticketId: i.ticketId,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
