import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { DerramesConsultaService, escalaAEmergencia } from '../derrames/derrames-consulta.service';
import { texto } from '../epi/epi-tipos';
import { EstadoEmergencia } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { codigoEmergencia } from './emergencias-consulta.service';
import { EmergenciasConsultaService } from './emergencias-consulta.service';
import { EmergenciasEventosService } from './emergencias-eventos.service';

export interface ActivarEmergenciaEntrada {
  tipoId: string;
  descripcion: string;
  ubicacion?: string | null;
  /** Servicio durante el que ocurre (debe ser un ticket que QHSE conoce); si escala de una SWA o un derrame, hereda el suyo. */
  ticketId?: string | null;
  /** Escalada desde una SWA que no esté cerrada. */
  origenSwaId?: string | null;
  /** Escalada desde un derrame mayor o en cuerpo de agua (el que escala a emergencia, HSE-MASTER-001). */
  origenDerrameId?: string | null;
}

/**
 * Emergencias / MEDEVAC (HSE-TRIAGE-001). «Cualquier trabajador (detector inicial)» activa la emergencia; el equipo HSE la gestiona. Puede
 * activarse directa o por escalada desde una SWA o un derrame mayor. Las reglas del ciclo las garantiza además la base (trigger
 * `emergencia_validar`).
 */
@Injectable()
export class EmergenciasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EmergenciasEventosService,
    private readonly derrames: DerramesConsultaService,
    private readonly consulta: EmergenciasConsultaService,
  ) {}

  /** Activa la emergencia. Devuelve lo mínimo: quien la activa puede no tener permiso de ver. */
  async activar(entrada: ActivarEmergenciaEntrada, actor: AuthUser) {
    const descripcion = texto(entrada.descripcion);
    if (!descripcion) throw new BadRequestException('Describa qué ocurrió');
    if (entrada.origenSwaId && entrada.origenDerrameId)
      throw new BadRequestException(
        'Una emergencia escala de una SWA o de un derrame, no de los dos',
      );
    const id = uuidv7();
    let numero = 0;
    await this.prisma.$transaction(async (tx) => {
      const tipo = await tx.emergenciaTipo.findUnique({ where: { id: entrada.tipoId } });
      if (!tipo?.activo)
        throw new BadRequestException('El tipo de emergencia no existe o está inactivo');
      let ticketId = entrada.ticketId ?? null;
      let origen: string | null = null;

      if (entrada.origenSwaId) {
        const swa = await tx.swa.findUnique({ where: { id: entrada.origenSwaId } });
        if (!swa) throw new BadRequestException('La SWA de origen no existe');
        if (swa.estado === 'cerrado')
          throw new ConflictException('Una SWA cerrada ya no escala a emergencia');
        const previa = await tx.emergencia.findFirst({ where: { swaId: swa.id } });
        if (previa)
          throw new ConflictException(
            `Esa SWA ya escaló a la emergencia ${codigoEmergencia(previa.numero)}`,
          );
        ticketId = ticketId ?? swa.ticketId;
        origen = `SWA-${String(swa.numero).padStart(6, '0')}`;
      }
      if (entrada.origenDerrameId) {
        const derrame = await tx.derrame.findUnique({
          where: { id: entrada.origenDerrameId },
          include: { ubicacion: true, banda: true },
        });
        if (!derrame) throw new BadRequestException('El derrame de origen no existe');
        const reglas = this.derrames.reglas(derrame, await this.derrames.bandasActivas(tx));
        if (!escalaAEmergencia(reglas))
          throw new ConflictException(
            'Ese derrame no escala a emergencia: solo el mayor o el que está en un cuerpo de agua',
          );
        const previa = await tx.emergencia.findFirst({ where: { derrameId: derrame.id } });
        if (previa)
          throw new ConflictException(
            `Ese derrame ya escaló a la emergencia ${codigoEmergencia(previa.numero)}`,
          );
        ticketId = ticketId ?? derrame.ticketId;
        origen = `DER-${String(derrame.numero).padStart(6, '0')}`;
      }
      if (ticketId && !(await tx.ticketRef.count({ where: { ticketId } })))
        throw new BadRequestException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');

      const creada = await tx.emergencia.create({
        data: {
          id,
          tipoId: tipo.id,
          descripcion,
          ubicacion: texto(entrada.ubicacion),
          ticketId,
          swaId: entrada.origenSwaId ?? null,
          derrameId: entrada.origenDerrameId ?? null,
          activadoPor: actor.id,
          createdBy: actor.id,
        },
        select: { numero: true },
      });
      numero = creada.numero;
      await tx.emergenciaHistorial.create({
        data: {
          id: uuidv7(),
          emergenciaId: id,
          estadoNuevo: EstadoEmergencia.activa,
          actorId: actor.id,
        },
      });
      await this.eventos.linea(
        tx,
        id,
        origen
          ? `Emergencia activada (${tipo.nombre}), escalada desde ${origen}`
          : `Emergencia activada (${tipo.nombre})`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.activada', id, actor);
    });
    return { id, codigo: codigoEmergencia(numero), estado: 'activa' };
  }

  /** Agrega una línea al cronómetro del evento (mientras la emergencia no esté cerrada). */
  async agregarLinea(id: string, textoLinea: string, actor: AuthUser) {
    const t = texto(textoLinea);
    if (!t) throw new BadRequestException('Escriba qué ocurrió');
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.emergencia.findUnique({ where: { id }, select: { estado: true } });
      if (!e) throw new NotFoundException('La emergencia no existe');
      if (e.estado === EstadoEmergencia.cerrada)
        throw new ConflictException('Una emergencia cerrada ya no recibe líneas del cronómetro');
      await this.eventos.linea(tx, id, t, actor, false);
    });
    return this.consulta.detalle(id);
  }
}
