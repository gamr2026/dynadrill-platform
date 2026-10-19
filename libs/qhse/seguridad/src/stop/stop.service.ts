import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import { EstadoItemStop, EstadoStop } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { StopConsultaService, codigoStop } from './stop-consulta.service';

export const MODULO_ARCHIVO_STOP_FOTO = 'qhse_stop_foto';
const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface RegistrarStopEntrada {
  fecha?: string | null;
  observadoId?: string | null;
  campoId?: string | null;
  operadoraId?: string | null;
  lugar?: string | null;
  contacto?: string | null;
  ticketId?: string | null;
  fotoArchivoId?: string | null;
  accionesQueObserva?: string | null;
  accionesAccion?: string | null;
  condicionesQueObserva?: string | null;
  condicionesAccion?: string | null;
  /** Solo los ítems que el observador marcó. */
  items: Array<{ itemId: string; estado: EstadoItemStop }>;
}

/**
 * Tarjeta de observación STOP (DYN-SGI-RE-008). Cualquier trabajador la registra (el observador es quien tiene la sesión, no se captura);
 * QHSE la deriva a Mantenimiento o a otro departamento, o la resuelve, y cierra las derivadas. Eventos `qhse.stop.registrada|derivada|
 * resuelta|cerrada` (con ids, para reportería y avisos).
 */
@Injectable()
export class StopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: StopConsultaService,
  ) {}

  /** Devuelve solo lo mínimo: quien registra puede no tener permiso de ver la bandeja. */
  async registrar(e: RegistrarStopEntrada, actor: AuthUser) {
    // un ítem repetido cuenta una sola vez: queda la primera marca
    const items = e.items.filter((i, k) => e.items.findIndex((x) => x.itemId === i.itemId) === k);
    if (!items.length)
      throw new BadRequestException('Marque al menos un ítem como seguro o inseguro');
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const validos = await tx.stopItem.count({
        where: { id: { in: items.map((i) => i.itemId) }, activo: true },
      });
      if (validos !== items.length)
        throw new BadRequestException('Uno de los ítems no existe o está inactivo');
      if (e.observadoId) {
        if (e.observadoId === actor.id)
          throw new BadRequestException(
            'Usted es quien observa: no puede registrarse como la persona observada',
          );
        if (!(await tx.idUsuario.count({ where: { id: e.observadoId } })))
          throw new BadRequestException('La persona observada no existe');
      }
      if (e.campoId && !(await tx.catCampo.count({ where: { id: e.campoId } })))
        throw new BadRequestException('El campo no existe');
      if (e.operadoraId && !(await tx.catCliente.count({ where: { id: e.operadoraId } })))
        throw new BadRequestException('La operadora no existe');
      if (e.ticketId && !(await tx.ticketRef.count({ where: { ticketId: e.ticketId } })))
        throw new BadRequestException('QHSE no conoce ese ticket');
      if (e.fotoArchivoId) await this.exigirFoto(tx, e.fotoArchivoId);
      await tx.stopTarjeta.create({
        data: {
          id,
          observadorId: actor.id,
          observadoId: e.observadoId ?? null,
          fecha: aFecha(e.fecha ?? hoyEcuador()),
          campoId: e.campoId ?? null,
          operadoraId: e.operadoraId ?? null,
          lugar: texto(e.lugar),
          contacto: texto(e.contacto),
          ticketId: e.ticketId ?? null,
          fotoArchivoId: e.fotoArchivoId ?? null,
          accionesQueObserva: texto(e.accionesQueObserva),
          accionesAccion: texto(e.accionesAccion),
          condicionesQueObserva: texto(e.condicionesQueObserva),
          condicionesAccion: texto(e.condicionesAccion),
          createdBy: actor.id,
        },
      });
      await tx.stopTarjetaItem.createMany({
        data: items.map((i) => ({ tarjetaId: id, itemId: i.itemId, estado: i.estado })),
      });
      await this.historia(tx, id, null, EstadoStop.abierto, actor);
      await this.publicar(tx, 'qhse.stop.registrada', id, actor);
      // con ítems inseguros se publica además el hecho que avisa al Técnico HSE (la tarjeta solo con ítems seguros no necesita atención)
      if (items.some((i) => i.estado === EstadoItemStop.inseguro))
        await this.publicar(tx, 'qhse.stop.con_hallazgos', id, actor);
    });
    const t = await this.prisma.stopTarjeta.findUniqueOrThrow({
      where: { id },
      select: { numero: true, estado: true },
    });
    return { id, codigo: codigoStop(t.numero), estado: t.estado };
  }

  /** QHSE deriva la tarjeta a Mantenimiento o a otro departamento (con su observación). */
  async derivar(
    id: string,
    destino: 'mantenimiento' | 'otro',
    observacion: string,
    actor: AuthUser,
  ) {
    return this.atender(
      id,
      destino === 'mantenimiento' ? EstadoStop.derivado_mantenimiento : EstadoStop.derivado_otro,
      observacion,
      actor,
      'qhse.stop.derivada',
    );
  }

  /** QHSE la resuelve por sí misma (queda terminada). */
  async resolver(id: string, observacion: string, actor: AuthUser) {
    return this.atender(id, EstadoStop.resuelto_qhse, observacion, actor, 'qhse.stop.resuelta');
  }

  /** Cierra una tarjeta derivada (cuando el otro departamento ya actuó). */
  async cerrar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.encontrar(tx, id);
      if (t.estado !== EstadoStop.derivado_mantenimiento && t.estado !== EstadoStop.derivado_otro)
        throw new ConflictException('Solo se cierra una tarjeta que ya fue derivada');
      const cambio = await tx.stopTarjeta.updateMany({
        where: { id, estado: t.estado },
        data: {
          estado: EstadoStop.cerrado,
          cerradoPor: actor.id,
          cerradoAt: new Date(),
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La tarjeta cambió; recargue e intente de nuevo');
      await this.historia(tx, id, t.estado, EstadoStop.cerrado, actor);
      await this.publicar(tx, 'qhse.stop.cerrada', id, actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async atender(
    id: string,
    nuevo: EstadoStop,
    observacion: string,
    actor: AuthUser,
    evento: string,
  ) {
    const obs = texto(observacion);
    if (!obs) throw new BadRequestException('Escriba qué se hizo o a quién se derivó');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.encontrar(tx, id);
      if (t.estado !== EstadoStop.abierto)
        throw new ConflictException('La tarjeta ya fue atendida');
      const cambio = await tx.stopTarjeta.updateMany({
        where: { id, estado: EstadoStop.abierto },
        data: {
          estado: nuevo,
          atendidoPor: actor.id,
          atendidoAt: new Date(),
          atendidoObservacion: obs,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La tarjeta cambió; recargue e intente de nuevo');
      await this.historia(tx, id, EstadoStop.abierto, nuevo, actor, obs);
      await this.publicar(tx, evento, id, actor, obs);
    });
    return this.consulta.detalle(id);
  }

  private async encontrar(tx: Tx, id: string) {
    const t = await tx.stopTarjeta.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('La tarjeta STOP no existe');
    return t;
  }

  private async exigirFoto(tx: Tx, archivoId: string): Promise<void> {
    const a = await tx.archivoRef.findUnique({
      where: { id: archivoId },
      select: { eliminadoAt: true, modulo: { select: { codigo: true } } },
    });
    if (!a || a.eliminadoAt) throw new BadRequestException('La foto no existe');
    if (a.modulo.codigo !== MODULO_ARCHIVO_STOP_FOTO)
      throw new BadRequestException(
        'La foto no se subió como foto de una tarjeta STOP: súbala de nuevo desde esta pantalla',
      );
  }

  private async historia(
    tx: Tx,
    tarjetaId: string,
    anterior: EstadoStop | null,
    nuevo: EstadoStop,
    actor: AuthUser,
    observacion?: string,
  ) {
    await tx.stopHistorial.create({
      data: {
        id: uuidv7(),
        tarjetaId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        actorId: actor.id,
        observacion: observacion ?? null,
      },
    });
  }

  private async publicar(
    tx: Tx,
    tipo: string,
    tarjetaId: string,
    actor: AuthUser,
    observacion?: string,
  ) {
    const t = await tx.stopTarjeta.findUniqueOrThrow({
      where: { id: tarjetaId },
      include: {
        observador: { select: { nombre: true } },
        campo: { select: { nombre: true } },
        items: { select: { estado: true } },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'stop_tarjeta', id: tarjetaId },
        data: {
          tarjetaId,
          numero: t.numero,
          codigo: codigoStop(t.numero),
          estado: t.estado,
          fecha: t.fecha.toISOString().slice(0, 10),
          ticketId: t.ticketId,
          inseguros: t.items.filter((i) => i.estado === EstadoItemStop.inseguro).length,
          // texto para el aviso (no cambia: quién observó y dónde al momento de registrar)
          observador: t.observador.nombre,
          campo: t.campo?.nombre ?? null,
          lugar: t.lugar,
          ...(observacion ? { observacion } : {}),
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
