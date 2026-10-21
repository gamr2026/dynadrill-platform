import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { hashTexto } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { RequisitosService } from './requisitos.service';

/** Paso en el que los operadores aceptan los términos antes de salir. */
const PASO = 'traslado_salida';

/**
 * Términos y condiciones de uso de equipos. El texto es versionado y la aceptación es una constancia inmutable: la cuenta de cada
 * operador asignado la hace por sí misma (hora del servidor) y cumple el requisito `terminos_aceptados` de ese operador.
 */
@Injectable()
export class TerminosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  async vigente() {
    const v = await this.prisma.terminosVersion.findFirst({ where: { vigente: true } });
    if (!v) throw new NotFoundException('No hay una versión vigente de los términos y condiciones');
    return {
      codigo: v.codigo,
      titulo: v.titulo,
      texto: v.texto,
      textoHash: v.textoHash,
      /** `false` = borrador: QHSE todavía no validó el texto (D9). */
      validada: v.validadoAt !== null,
    };
  }

  /** Todas las versiones, la más reciente primero, con su estado de validación (para QHSE). */
  async versiones() {
    const filas = await this.prisma.terminosVersion.findMany({
      orderBy: { publicadoAt: 'desc' },
      include: { validador: { select: { nombre: true } } },
    });
    return filas.map((v) => ({
      codigo: v.codigo,
      titulo: v.titulo,
      texto: v.texto,
      textoHash: v.textoHash,
      vigente: v.vigente,
      publicadoAt: v.publicadoAt,
      validada: v.validadoAt !== null,
      validadoAt: v.validadoAt,
      validadoPor: v.validador?.nombre ?? null,
    }));
  }

  /** QHSE da por válido el texto de una versión tal como está (la v1 sembrada es un borrador de la demo). */
  async validar(codigo: string, actor: AuthUser) {
    const v = await this.prisma.terminosVersion.findUnique({ where: { codigo } });
    if (!v) throw new NotFoundException('La versión no existe');
    if (v.validadoAt) throw new ConflictException('Esa versión ya está validada');
    await this.prisma.terminosVersion.update({
      where: { codigo },
      data: { validadoAt: new Date(), validadoPor: actor.id },
    });
    return this.versiones();
  }

  /**
   * QHSE publica una versión nueva del texto: queda validada por quien la publica y pasa a ser la vigente (la anterior deja de serlo).
   * Las versiones ya aceptadas no se editan nunca: lo que se leyó queda como constancia.
   */
  async publicar(titulo: string, texto: string, actor: AuthUser) {
    const t = texto.trim();
    if (t.length < 50) throw new BadRequestException('El texto de los términos es demasiado corto');
    await this.prisma.$transaction(async (tx) => {
      const previas = await tx.terminosVersion.findMany({ select: { codigo: true } });
      const n =
        previas.reduce((m, p) => Math.max(m, Number(/-v(\d+)$/.exec(p.codigo)?.[1] ?? 0)), 0) + 1;
      await tx.terminosVersion.updateMany({ where: { vigente: true }, data: { vigente: false } });
      await tx.terminosVersion.create({
        data: {
          codigo: `PUMP-TyC-v${n}`,
          titulo: titulo.trim(),
          texto: t,
          textoHash: hashTexto(t),
          vigente: true,
          validadoAt: new Date(),
          validadoPor: actor.id,
        },
      });
    });
    return this.versiones();
  }

  /** Estado de cada operador asignado: aceptó la versión vigente (o alguna) o falta. */
  async deTicket(ticketId: string) {
    const [operadores, aceptaciones, vigente] = await Promise.all([
      this.prisma.ticketPersona.findMany({
        where: { ticketId, rol: 'operador' },
        include: { usuario: true },
        orderBy: { usuario: { nombre: 'asc' } },
      }),
      this.prisma.aceptacionTerminos.findMany({
        where: { ticketId },
        orderBy: { aceptadoAt: 'asc' },
      }),
      this.prisma.terminosVersion.findFirst({ where: { vigente: true }, select: { codigo: true } }),
    ]);
    return operadores.map((o) => {
      const a = aceptaciones.find((x) => x.usuarioId === o.usuarioId);
      return {
        usuarioId: o.usuarioId,
        nombre: o.usuario.nombre,
        aceptacion: a
          ? {
              versionCodigo: a.versionCodigo,
              aceptadoAt: a.aceptadoAt,
              esVigente: a.versionCodigo === vigente?.codigo,
            }
          : null,
      };
    });
  }

  /** La cuenta que acepta es la del operador (nadie acepta por otro). Es idempotente. */
  async aceptar(ticketId: string, actor: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { id: true, pasoCodigo: true },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      const persona = await tx.ticketPersona.findUnique({
        where: { ticketId_usuarioId: { ticketId, usuarioId: actor.id } },
      });
      if (!persona || persona.rol !== 'operador') {
        throw new ForbiddenException(
          'Solo un operador asignado a este ticket puede aceptar los términos',
        );
      }
      if (t.pasoCodigo !== PASO)
        throw new ConflictException('Los términos se aceptan en el paso de Traslado de salida');
      const version = await tx.terminosVersion.findFirst({ where: { vigente: true } });
      if (!version)
        throw new NotFoundException('No hay una versión vigente de los términos y condiciones');

      const existente = await tx.aceptacionTerminos.findUnique({
        where: {
          ticketId_usuarioId_versionCodigo: {
            ticketId,
            usuarioId: actor.id,
            versionCodigo: version.codigo,
          },
        },
      });
      const aceptacion =
        existente ??
        (await tx.aceptacionTerminos.create({
          data: { id: uuidv7(), ticketId, usuarioId: actor.id, versionCodigo: version.codigo },
        }));
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.terminos, usuarioId: actor.id },
        'sistema',
        actor.id,
      );
      return { versionCodigo: aceptacion.versionCodigo, aceptadoAt: aceptacion.aceptadoAt };
    });
  }
}
