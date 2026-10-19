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
import { EstadoSwa } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { SwaConsultaService, codigoSwa } from './swa-consulta.service';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface ActivarSwaEntrada {
  tipoPeligroId: string;
  descripcion: string;
  ubicacion?: string | null;
  ticketId?: string | null;
}

/**
 * Stop Work Authority (HSE-SEGUIMIENTO-003). Cualquier trabajador la activa; el equipo HSE notifica a la cadena (Supervisor, Técnico y
 * Gerente HSE), evalúa (riesgo real o falsa alarma: bloqueada hasta notificar a todos), confirma el checklist de reinicio y reanuda.
 * **Una SWA sin cerrar bloquea el ticket** (D10, confirmado por Dynadrill): los eventos `qhse.swa.activado|evaluado|cerrado` llevan el
 * `ticketId` y cuántas SWA siguen abiertas en él (`swaActivasEnTicket`), para que Pumping y FCR bloqueen o liberen. Las reglas del
 * ciclo las garantiza además la base (trigger `swa_validar`).
 */
@Injectable()
export class SwaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: SwaConsultaService,
  ) {}

  /** Activa la SWA (cualquier usuario autenticado). Devuelve solo lo mínimo: quien la activa puede no tener permiso de ver. */
  async activar(entrada: ActivarSwaEntrada, actor: AuthUser) {
    const descripcion = texto(entrada.descripcion);
    if (!descripcion) throw new BadRequestException('Describa qué peligro detuvo el trabajo');
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const tipo = await tx.swaTipoPeligro.findUnique({ where: { id: entrada.tipoPeligroId } });
      if (!tipo?.activo)
        throw new BadRequestException('El tipo de peligro no existe o está inactivo');
      if (
        entrada.ticketId &&
        !(await tx.ticketRef.count({ where: { ticketId: entrada.ticketId } }))
      )
        throw new BadRequestException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
      await tx.swa.create({
        data: {
          id,
          ticketId: entrada.ticketId ?? null,
          tipoPeligroId: tipo.id,
          descripcion,
          ubicacion: texto(entrada.ubicacion),
          activadoPor: actor.id,
          createdBy: actor.id,
        },
      });
      await this.historia(tx, id, null, EstadoSwa.activo, actor);
      await this.publicar(tx, 'qhse.swa.activado', id, actor, true);
    });
    const s = await this.prisma.swa.findUniqueOrThrow({
      where: { id },
      select: { numero: true, estado: true },
    });
    return { id, codigo: codigoSwa(s.numero), estado: s.estado };
  }

  /** Registra que se notificó a un rol de la cadena (una vez por rol). */
  async notificar(id: string, rolCadenaId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.encontrar(tx, id);
      if (s.estado !== EstadoSwa.activo)
        throw new ConflictException('Las notificaciones se registran mientras la SWA está activa');
      const rol = await tx.swaRolCadena.findUnique({ where: { id: rolCadenaId } });
      if (!rol?.activo)
        throw new BadRequestException('Ese rol no forma parte de la cadena de notificación');
      if (await tx.swaNotificacion.count({ where: { swaId: id, rolCadenaId } }))
        throw new ConflictException('Ese rol ya está notificado');
      await tx.swaNotificacion.create({
        data: { id: uuidv7(), swaId: id, rolCadenaId, notificadoPor: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  /** Evalúa: riesgo real o falsa alarma. Bloqueada hasta notificar a todos los roles de la cadena. */
  async evaluar(
    id: string,
    entrada: { riesgoReal: boolean; nota?: string | null },
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.encontrar(tx, id);
      if (s.estado !== EstadoSwa.activo) throw new ConflictException('La SWA ya fue evaluada');
      const faltan = await this.rolesSinNotificar(tx, id);
      if (faltan.length)
        throw new ConflictException(
          `La evaluación queda bloqueada hasta notificar a todos los roles de la cadena. Falta notificar a: ${faltan.join(', ')}`,
        );
      const cambio = await tx.swa.updateMany({
        where: { id, estado: EstadoSwa.activo },
        data: {
          estado: EstadoSwa.evaluado,
          riesgoReal: entrada.riesgoReal,
          evaluacionNota: texto(entrada.nota),
          evaluadoPor: actor.id,
          evaluadoAt: new Date(),
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La SWA cambió; recargue e intente de nuevo');
      await this.historia(tx, id, EstadoSwa.activo, EstadoSwa.evaluado, actor);
      await this.publicar(tx, 'qhse.swa.evaluado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Confirma un criterio del checklist de reinicio (con la SWA evaluada). */
  async confirmarCriterio(id: string, criterioId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.encontrar(tx, id);
      if (s.estado !== EstadoSwa.evaluado)
        throw new ConflictException('El checklist de reinicio se confirma con la SWA evaluada');
      const c = await tx.swaCriterioReinicio.findUnique({ where: { id: criterioId } });
      if (!c?.activo)
        throw new BadRequestException('Ese criterio no forma parte del checklist de reinicio');
      if (await tx.swaReinicio.count({ where: { swaId: id, criterioId } }))
        throw new ConflictException('Ese criterio ya está confirmado');
      await tx.swaReinicio.create({
        data: { id: uuidv7(), swaId: id, criterioId, confirmadoPor: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  /** Reanuda el trabajo: cierra la SWA y libera el ticket (si no tiene otras abiertas). */
  async reanudar(id: string, entrada: { heroeSeguridad?: boolean }, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.encontrar(tx, id);
      if (s.estado !== EstadoSwa.evaluado)
        throw new ConflictException('Solo se reanuda una SWA evaluada');
      const faltan = await tx.swaCriterioReinicio.findMany({
        where: { activo: true, confirmaciones: { none: { swaId: id } } },
        select: { nombre: true },
      });
      if (faltan.length)
        throw new ConflictException(
          `Para reanudar confirme todo el checklist de reinicio. Falta: ${faltan.map((f) => f.nombre).join('; ')}`,
        );
      const cambio = await tx.swa.updateMany({
        where: { id, estado: EstadoSwa.evaluado },
        data: {
          estado: EstadoSwa.cerrado,
          reanudadoPor: actor.id,
          reanudadoAt: new Date(),
          heroeSeguridad: entrada.heroeSeguridad === true,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La SWA cambió; recargue e intente de nuevo');
      await this.historia(tx, id, EstadoSwa.evaluado, EstadoSwa.cerrado, actor);
      await this.publicar(tx, 'qhse.swa.cerrado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async encontrar(tx: Tx, id: string) {
    const s = await tx.swa.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('La SWA no existe');
    return s;
  }

  private async rolesSinNotificar(tx: Tx, swaId: string): Promise<string[]> {
    const faltan = await tx.swaRolCadena.findMany({
      where: { activo: true, notificaciones: { none: { swaId } } },
      include: { rol: { select: { nombre: true } } },
      orderBy: { orden: 'asc' },
    });
    return faltan.map((f) => f.rol.nombre);
  }

  private async historia(
    tx: Tx,
    swaId: string,
    anterior: EstadoSwa | null,
    nuevo: EstadoSwa,
    actor: AuthUser,
  ) {
    await tx.swaHistorial.create({
      data: {
        id: uuidv7(),
        swaId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        actorId: actor.id,
      },
    });
  }

  /** Quiénes deben enterarse al activar: el supervisor del ticket y todas las cuentas activas de los roles HSE de la cadena. */
  private async asignadosAlActivar(tx: Tx, supervisorId: string | null) {
    const cadena = await tx.swaRolCadena.findMany({
      where: { activo: true },
      include: { rol: { select: { id: true, codigo: true } } },
    });
    const asignados: Array<{ usuarioId: string; rolCodigo: string }> = [];
    for (const c of cadena) {
      if (c.rol.codigo === 'supervisor') {
        if (supervisorId) asignados.push({ usuarioId: supervisorId, rolCodigo: 'supervisor' });
        continue;
      }
      const personas = await tx.idUsuario.findMany({
        where: { rolId: c.rol.id, activo: true },
        select: { id: true },
      });
      for (const p of personas) asignados.push({ usuarioId: p.id, rolCodigo: c.rol.codigo });
    }
    return asignados;
  }

  private async publicar(tx: Tx, tipo: string, swaId: string, actor: AuthUser, conAvisos = false) {
    const s = await tx.swa.findUniqueOrThrow({
      where: { id: swaId },
      include: {
        tipoPeligro: { select: { codigo: true, nombre: true } },
        activador: { select: { nombre: true } },
        ticket: {
          select: {
            ticketNumero: true,
            pedidoId: true,
            pedidoCodigo: true,
            cliente: true,
            campo: true,
            pozo: true,
            supervisorId: true,
          },
        },
      },
    });
    const abiertas = s.ticketId ? await this.consulta.activasDeTicket(s.ticketId, tx) : 0;
    const asignados = conAvisos
      ? await this.asignadosAlActivar(tx, s.ticket?.supervisorId ?? null)
      : null;
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'swa', id: swaId },
        data: {
          swaId,
          numero: s.numero,
          codigo: codigoSwa(s.numero),
          estado: s.estado,
          ticketId: s.ticketId,
          ticketNumero: s.ticket?.ticketNumero ?? null,
          pedidoId: s.ticket?.pedidoId ?? null,
          pedidoCodigo: s.ticket?.pedidoCodigo ?? null,
          cliente: s.ticket?.cliente ?? null,
          campo: s.ticket?.campo ?? null,
          pozo: s.ticket?.pozo ?? null,
          tipoPeligro: s.tipoPeligro.codigo,
          // texto para el aviso (no cambia: es lo que se escribió al detener el trabajo)
          tipoPeligroNombre: s.tipoPeligro.nombre,
          descripcion: s.descripcion,
          ubicacion: s.ubicacion,
          activadoPor: s.activador.nombre,
          riesgoReal: s.riesgoReal,
          /** SWA sin cerrar en el ticket tras este hecho: mientras sea mayor que 0, el ticket está bloqueado. */
          swaActivasEnTicket: abiertas,
          sinSwaActivas: s.ticketId ? abiertas === 0 : null,
          ...(asignados ? { asignados } : {}),
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
