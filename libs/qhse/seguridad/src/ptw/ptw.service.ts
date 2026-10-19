import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import { AccionPtw, FasePtw, TipoFirmaPtw } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PtwConsultaService } from './ptw-consulta.service';
import { codigoPtw, requisitosDeGabinete } from './ptw-documentos';
import { requisitosIperc } from './ptw-iperc';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Las tres confirmaciones de la formalización; al completarse el PTW pasa solo a aprobación y se publica `qhse.ptw.firmado`. */
const FORMALIZACION: TipoFirmaPtw[] = [
  TipoFirmaPtw.ptw_en_sitio,
  TipoFirmaPtw.acta_recibimiento,
  TipoFirmaPtw.barricadas,
];

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

/**
 * Permiso de Trabajo (HSE-SITIO-001): uno vigente por pedido y día de operación. Ciclo: gabinete → formalización → aprobación →
 * aprobado. Cada paso publica su evento por el outbox en la misma transacción: `qhse.ptw.abierto`, `.firmado` (formalización
 * completa), `.cerrado` (aprobado por QHSE) y `.anulado`. Las reglas de las fases las garantiza además la base (trigger `ptw_validar`).
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
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticketRef.findUnique({ where: { ticketId: entrada.ticketId } });
      if (!t)
        throw new NotFoundException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
      const existente = await tx.ptw.findFirst({
        where: { pedidoId: t.pedidoId, diaOperacion: dia, anuladoAt: null },
        select: { numero: true },
      });
      if (existente)
        throw new ConflictException(
          `Ya hay un PTW vigente (${codigoPtw(existente.numero)}) de este pedido para ese día; solo se permite uno por pedido y día`,
        );
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
    });
    return this.consulta.detalle(id);
  }

  /** Pasa de gabinete a formalización: fija los cuatro documentos que sirven para ese día (el ART vencido bloquea). */
  async validarDocumentos(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.vigente(tx, id);
      if (p.fase !== FasePtw.gabinete)
        throw new ConflictException('Los documentos de este PTW ya se validaron');
      const requisitos = await requisitosDeGabinete(tx, p.pedidoId, p.diaOperacion);
      const faltan = requisitos.filter((r) => r.documentoId === null);
      if (faltan.length)
        throw new ConflictException(
          `No se puede pasar a formalización. ${faltan.map((f) => f.falta).join('. ')}`,
        );
      // las matrices IPERC aprobadas y vigentes de las actividades que exige el tipo de servicio del ticket (una vencida bloquea)
      const iperc = await requisitosIperc(tx, p.ticketId, p.diaOperacion);
      const sinMatriz = iperc.filter((r) => r.matrizId === null);
      if (sinMatriz.length)
        throw new ConflictException(
          `No se puede pasar a formalización. ${sinMatriz.map((f) => f.falta).join('. ')}`,
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
          fase: FasePtw.formalizacion,
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

  /** Confirma «de una línea» el PTW firmado en sitio, el acta de recibimiento o las barricadas; con las tres pasa a aprobación. */
  async confirmar(id: string, tipo: TipoFirmaPtw, actor: AuthUser) {
    if (!FORMALIZACION.includes(tipo))
      throw new BadRequestException('Esa confirmación no es de la formalización');
    await this.prisma.$transaction(async (tx) => {
      const p = await this.vigente(tx, id);
      if (p.fase !== FasePtw.formalizacion)
        throw new ConflictException('Las confirmaciones se registran en la fase de formalización');
      if (await tx.ptwFirma.count({ where: { ptwId: id, tipo } }))
        throw new ConflictException('Esa confirmación ya está registrada');
      await tx.ptwFirma.create({ data: { id: uuidv7(), ptwId: id, tipo, usuarioId: actor.id } });
      const hechas = await tx.ptwFirma.count({ where: { ptwId: id, tipo: { in: FORMALIZACION } } });
      if (hechas < FORMALIZACION.length) return;
      // el cambio de fase lo gana una sola petición aunque dos confirmaciones lleguen a la vez
      const cambio = await tx.ptw.updateMany({
        where: { id, fase: FasePtw.formalizacion },
        data: { fase: FasePtw.aprobacion, updatedBy: actor.id },
      });
      if (cambio.count !== 1) return;
      await this.historia(tx, id, AccionPtw.firmado, actor);
      await this.publicar(tx, 'qhse.ptw.firmado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** La aprobación de QHSE: cierra el PTW del día. */
  async aprobar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.vigente(tx, id);
      if (p.fase !== FasePtw.aprobacion)
        throw new ConflictException('El PTW debe tener la formalización completa para aprobarlo');
      await tx.ptwFirma.create({
        data: { id: uuidv7(), ptwId: id, tipo: TipoFirmaPtw.aprobacion, usuarioId: actor.id },
      });
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
    await this.prisma.$transaction(async (tx) => {
      await this.vigente(tx, id);
      await tx.ptw.update({
        where: { id },
        data: {
          anuladoAt: new Date(),
          anuladoPor: actor.id,
          motivoAnulacion: m,
          updatedBy: actor.id,
        },
      });
      await this.historia(tx, id, AccionPtw.anulado, actor, m);
      await this.publicar(tx, 'qhse.ptw.anulado', id, actor, m);
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
    actor: AuthUser,
    motivo?: string,
  ) {
    await tx.ptwHistorial.create({
      data: { id: uuidv7(), ptwId, accion, actorId: actor.id, motivo: motivo ?? null },
    });
  }

  private async publicar(tx: Tx, tipo: string, ptwId: string, actor: AuthUser, motivo?: string) {
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
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
