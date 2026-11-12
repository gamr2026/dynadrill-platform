import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { firmaDeUnaLinea } from '../comun/firma';
import { texto, type Tx } from '../epi/epi-tipos';
import { AccionPtw, FasePtw, TipoFirmaPtw } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { exigirTicketActivo } from '../comun/ticket-activo';
import { PtwConsultaService } from './ptw-consulta.service';
import { codigoPtw, requisitosDeGabinete } from './ptw-documentos';
import { requisitosIperc } from './ptw-iperc';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Quien actúa sobre el PTW: una cuenta autenticada o, cuando lo abre un evento, la cuenta que lo originó. */
type ActorPtw = Pick<AuthUser, 'id' | 'roleCode'>;
const enActor = (a: ActorPtw) => ({ userId: a.id, role: a.roleCode });

/**
 * Permiso de Trabajo (HSE-SITIO-001): uno vigente por pedido y día de operación. Ciclo (como la demo): gabinete → aprobación → aprobado.
 * Cada paso publica su evento por el outbox en la misma transacción: `qhse.ptw.abierto`, `.firmado` (la aprobación de QHSE), `.cerrado`
 * (aprobado por QHSE) y `.anulado`. Las reglas de las fases las garantiza además la base (trigger `ptw_validar`).
 */
@Injectable()
export class PtwService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: PtwConsultaService,
  ) {}

  /** Abre el PTW de un día de operación de un ticket. Nace en gabinete. */
  async abrir(entrada: { ticketId: string; diaOperacion: string }, actor: AuthUser) {
    const dia = this.dia(entrada.diaOperacion);
    const id = (await this.prisma.$transaction((tx) =>
      this.abrirEn(tx, entrada.ticketId, dia, actor, true),
    )) as string;
    return this.consulta.detalle(id);
  }

  /**
   * Abre el PTW del primer día de operación cuando el servicio llega a Pumping o se asigna su equipo (como la demo: el PTW nace con el servicio).
   * Lo abre a nombre de quien originó el evento. Si ese día ya tiene uno vigente no hace nada. Los días siguientes los abre QHSE desde el ticket.
   */
  async abrirDelPrimerDia(
    tx: Tx,
    ticketId: string,
    diaOperacion: string,
    actor: ActorPtw,
  ): Promise<string | null> {
    return this.abrirEn(tx, ticketId, this.dia(diaOperacion), actor, false);
  }

  /** Abre el PTW de un día de servicio (lo usa la tarea programada). Si ese día ya tiene uno vigente no hace nada y devuelve `null`. */
  async abrirDelDia(
    tx: Tx,
    ticketId: string,
    diaOperacion: string,
    actor: ActorPtw,
  ): Promise<string | null> {
    return this.abrirEn(tx, ticketId, this.dia(diaOperacion), actor, false);
  }

  /** Abre el PTW del día; `rechazarSiExiste` decide si un PTW vigente del mismo día es un error (API) o se ignora (evento). */
  private async abrirEn(
    tx: Tx,
    ticketId: string,
    dia: Date,
    actor: ActorPtw,
    rechazarSiExiste: boolean,
  ): Promise<string | null> {
    const t = await tx.ticketRef.findUnique({ where: { ticketId } });
    if (!t)
      throw new NotFoundException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
    // el pedido anulado no abre PTW: a mano es un 409; por evento o por la tarea programada simplemente no se abre
    if (t.anuladoAt) {
      if (!rechazarSiExiste) return null;
      await exigirTicketActivo(tx, ticketId);
    }
    const existente = await tx.ptw.findFirst({
      where: { pedidoId: t.pedidoId, diaOperacion: dia, anuladoAt: null },
      select: { numero: true },
    });
    if (existente) {
      if (!rechazarSiExiste) return null;
      throw new ConflictException(
        `Ya hay un PTW vigente (${codigoPtw(existente.numero)}) de este pedido para ese día; solo se permite uno por pedido y día`,
      );
    }
    const id = uuidv7();
    await tx.ptw.create({
      data: {
        id,
        ticketId: t.ticketId,
        pedidoId: t.pedidoId,
        diaOperacion: dia,
        createdBy: actor.id,
      },
    });
    await this.historia(tx, id, AccionPtw.abierto, actor);
    await this.publicar(tx, 'qhse.ptw.abierto', id, actor);
    return id;
  }

  /** Pasa de gabinete a aprobación: fija los cuatro documentos que sirven para ese día (el ART vencido bloquea). */
  async validarDocumentos(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.vigente(tx, id);
      if (p.fase !== FasePtw.gabinete)
        throw new ConflictException('Los documentos de este PTW ya se validaron');
      const requisitos = await requisitosDeGabinete(tx, p.pedidoId, p.diaOperacion);
      const faltan = requisitos.filter((r) => r.documentoId === null);
      if (faltan.length)
        throw new ConflictException(
          `No se puede pasar a aprobación. ${faltan.map((f) => f.falta).join('. ')}`,
        );
      // las matrices IPERC aprobadas y vigentes de las actividades que exige el tipo de servicio del ticket (una vencida bloquea)
      const iperc = await requisitosIperc(tx, p.ticketId, p.diaOperacion);
      const sinMatriz = iperc.filter((r) => r.matrizId === null);
      if (sinMatriz.length)
        throw new ConflictException(
          `No se puede pasar a aprobación. ${sinMatriz.map((f) => f.falta).join('. ')}`,
        );
      const por = (tipo: string) => requisitos.find((r) => r.tipo === tipo)?.documentoId as string;
      // se fijan las matrices usadas (la base exige que estén aprobadas, vigentes ese día y sean de una actividad exigida)
      if (iperc.length)
        await tx.ptwMatriz.createMany({
          data: iperc.map((r) => ({ ptwId: id, matrizId: r.matrizId as string })),
          skipDuplicates: true,
        });
      const cambio = await tx.ptw.updateMany({
        where: { id, fase: FasePtw.gabinete },
        data: {
          fase: FasePtw.aprobacion,
          documentoRecepcionId: por('formato_recepcion'),
          documentoArtId: por('art'),
          documentoPtId: por('pt'),
          documentoSfiId: por('sfi'),
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El PTW cambió; recargue e intente de nuevo');
      await this.historia(tx, id, AccionPtw.documentos_validados, actor);
    });
    return this.consulta.detalle(id);
  }

  /** La aprobación de QHSE: cierra el PTW del día. */
  async aprobar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.vigente(tx, id);
      if (p.fase !== FasePtw.aprobacion)
        throw new ConflictException('Valide los documentos del PTW antes de aprobarlo');
      const firmada = await tx.ptwFirma.create({
        data: { id: uuidv7(), ptwId: id, tipo: TipoFirmaPtw.aprobacion, usuarioId: actor.id },
      });
      await this.publicarFirma(tx, id, TipoFirmaPtw.aprobacion, actor, firmada.firmadoAt);
      const cambio = await tx.ptw.updateMany({
        where: { id, fase: FasePtw.aprobacion },
        data: { fase: FasePtw.aprobado, updatedBy: actor.id },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El PTW cambió; recargue e intente de nuevo');
      await this.historia(tx, id, AccionPtw.aprobado, actor);
      await this.publicar(tx, 'qhse.ptw.cerrado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Anula un PTW (aunque esté aprobado) con su motivo: el día queda libre para abrir otro y los documentos se pueden anular. */
  async anular(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo de la anulación');
    await this.prisma.$transaction((tx) => this.anularEn(tx, id, m, actor));
    return this.consulta.detalle(id);
  }

  /** La anulación dentro de una transacción ajena (también la usa el consumidor de `comercial.pedido.anulado` para cerrar los PTW sin aprobar). */
  async anularEn(tx: Tx, id: string, motivo: string, actor: ActorPtw): Promise<void> {
    await this.vigente(tx, id);
    await tx.ptw.update({
      where: { id },
      data: {
        anuladoAt: new Date(),
        anuladoPor: actor.id,
        motivoAnulacion: motivo,
        updatedBy: actor.id,
      },
    });
    await this.historia(tx, id, AccionPtw.anulado, actor, motivo);
    await this.publicar(tx, 'qhse.ptw.anulado', id, actor, motivo);
  }

  /**
   * Reintegra un PTW anulado: vuelve a ser el vigente de su día, con la fase y los documentos que tenía. Pide su motivo y deja la huella en el
   * historial (`reintegrado`); la anulación anterior no se borra. No se puede si el pedido ya tiene otro PTW vigente ese día (la tarea programada
   * pudo abrir uno nuevo: se anula primero) ni si alguno de los documentos que el PTW ya tenía fijados fue anulado.
   */
  async reintegrar(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo del reintegro');
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.ptw.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('El PTW no existe');
      if (!p.anuladoAt) throw new ConflictException('El PTW no está anulado');
      await exigirTicketActivo(tx, p.ticketId);
      const otro = await tx.ptw.findFirst({
        where: { pedidoId: p.pedidoId, diaOperacion: p.diaOperacion, anuladoAt: null },
        select: { numero: true },
      });
      if (otro)
        throw new ConflictException(
          `Ya hay un PTW vigente (${codigoPtw(otro.numero)}) de este pedido para ese día; anúlelo antes de reintegrar este`,
        );
      const documentos = [
        p.documentoRecepcionId,
        p.documentoArtId,
        p.documentoPtId,
        p.documentoSfiId,
      ].filter((d): d is string => !!d);
      if (
        documentos.length &&
        (await tx.documentoPedido.count({
          where: { id: { in: documentos }, anuladoAt: { not: null } },
        })) > 0
      )
        throw new ConflictException(
          'Alguno de los documentos de este PTW fue anulado: no se puede reintegrar, abra un PTW nuevo',
        );
      await tx.ptw.update({
        where: { id },
        data: { anuladoAt: null, anuladoPor: null, motivoAnulacion: null, updatedBy: actor.id },
      });
      await this.historia(tx, id, AccionPtw.reintegrado, actor, m);
      await this.publicar(tx, 'qhse.ptw.reintegrado', id, actor, m);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private dia(valor: string): Date {
    const f = FECHA.test(valor) ? new Date(`${valor}T00:00:00.000Z`) : null;
    if (!f || Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== valor)
      throw new BadRequestException('Indique el día de operación (AAAA-MM-DD)');
    return f;
  }

  private async vigente(tx: Tx, id: string) {
    const p = await tx.ptw.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('El PTW no existe');
    if (p.anuladoAt) throw new ConflictException('El PTW está anulado');
    return p;
  }

  private async historia(
    tx: Tx,
    ptwId: string,
    accion: AccionPtw,
    actor: ActorPtw,
    motivo?: string,
  ) {
    await tx.ptwHistorial.create({
      data: { id: uuidv7(), ptwId, accion, actorId: actor.id, motivo: motivo ?? null },
    });
  }

  /**
   * Evidencia de la aprobación (contrato 4.14): el evento `qhse.ptw.firmado` lleva al PTW y la prueba «de una línea». Firmas lo
   * registra; aquí la firma sigue guardada porque de ella depende el avance de fase.
   */
  private async publicarFirma(
    tx: Tx,
    ptwId: string,
    tipo: TipoFirmaPtw,
    actor: ActorPtw,
    firmadaAt: Date,
  ) {
    await this.publicar(
      tx,
      'qhse.ptw.firmado',
      ptwId,
      actor,
      undefined,
      firmaDeUnaLinea('qhse_ptw', ptwId, tipo, actor.id, firmadaAt),
    );
  }

  /**
   * Vuelve a publicar `qhse.ptw.cerrado` de cada PTW aprobado y vigente. Se usa una sola vez al desplegar la jornada por día: los PTW aprobados
   * antes de que Pumping guardara sus hechos por día no le llegaron. Pumping los guarda por su origen, así que repetirlos no duplica nada.
   */
  async reenviarAprobados(actor: ActorPtw): Promise<number> {
    const ids = await this.prisma.ptw.findMany({
      where: { fase: FasePtw.aprobado, anuladoAt: null },
      select: { id: true },
      orderBy: { diaOperacion: 'asc' },
    });
    for (const { id } of ids)
      await this.prisma.$transaction((tx) => this.publicar(tx, 'qhse.ptw.cerrado', id, actor));
    return ids.length;
  }

  private async publicar(
    tx: Tx,
    tipo: string,
    ptwId: string,
    actor: ActorPtw,
    motivo?: string,
    extra: Record<string, unknown> = {},
  ) {
    const p = await tx.ptw.findUniqueOrThrow({
      where: { id: ptwId },
      include: {
        ticket: {
          select: { ticketNumero: true, pedidoCodigo: true, cliente: true, supervisorId: true },
        },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'ptw', id: ptwId },
        data: {
          ptwId,
          numero: p.numero,
          codigo: codigoPtw(p.numero),
          ticketId: p.ticketId,
          ticketNumero: p.ticket.ticketNumero,
          pedidoId: p.pedidoId,
          pedidoCodigo: p.ticket.pedidoCodigo,
          cliente: p.ticket.cliente,
          diaOperacion: p.diaOperacion.toISOString().slice(0, 10),
          fase: p.fase,
          // al aprobar, el supervisor asignado recibe el aviso de que ya puede operar ese día
          ...(tipo === 'qhse.ptw.cerrado' && p.ticket.supervisorId
            ? { asignados: [{ usuarioId: p.ticket.supervisorId, rolCodigo: 'supervisor' }] }
            : {}),
          ...(motivo ? { motivo } : {}),
          ...extra,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
