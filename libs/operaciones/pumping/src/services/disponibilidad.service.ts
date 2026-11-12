import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { hoyEnGuayaquil } from './jornadas.service';
import {
  evaluarDisponibilidad,
  ocupacionDeTicket,
  rangoDeServicio,
  ROLES_CONDUCTOR,
  ROLES_OPERADOR,
  ROLES_SUPERVISOR,
  type Ocupacion,
  type Rango,
} from './disponibilidad';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Nombre del cliente: el fiscal si existe, si no el comercial (no se importa de `tickets.service`, que depende de la asignación). */
const nombreCliente = (c: { nombreFiscal: string | null; nombreComercial: string } | null) =>
  c ? (c.nombreFiscal ?? c.nombreComercial) : null;

/**
 * Disponibilidad del personal de Pumping (supervisores, operadores y conductores) frente a un rango de días, para la pantalla de asignación,
 * como la de FCR. Es también quien consulta las ocupaciones para validar la asignación (`AsignacionService.ocupadasPor`): una sola regla
 * (`disponibilidad.ts`) y una sola consulta.
 */
@Injectable()
export class DisponibilidadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hoy en Ecuador, para saber cuándo se libera el personal. Aparte (y público) para que las pruebas fijen el día. */
  hoy(): string {
    return hoyEnGuayaquil();
  }

  /**
   * El personal activo con su estado frente al rango. Con `ticketId` y sin fechas se usa el servicio del ticket (que no cuenta como ocupación
   * de sí mismo); con `desde` (y `hasta`, o ese mismo día) se usa ese rango, con o sin ticket.
   */
  async personal(ticketId: string | null, desde?: string, hasta?: string) {
    const rango = await this.rangoDe(ticketId, desde, hasta);
    const personas = await this.prisma.idUsuario.findMany({
      where: {
        activo: true,
        rol: { codigo: { in: [...ROLES_SUPERVISOR, ...ROLES_OPERADOR, ...ROLES_CONDUCTOR] } },
      },
      select: { id: true, nombre: true, rol: { select: { codigo: true } } },
      orderBy: { nombre: 'asc' },
    });
    const ocupaciones = await this.ocupaciones(
      this.prisma,
      ticketId,
      personas.map((p) => p.id),
      this.hoy(),
    );
    const de = (roles: string[]) =>
      personas
        .filter((p) => roles.includes(p.rol.codigo))
        .map((p) => ({
          usuarioId: p.id,
          nombre: p.nombre,
          ...evaluarDisponibilidad(rango, ocupaciones.get(p.id) ?? []),
        }));
    return {
      desde: rango.desde,
      hasta: rango.hasta,
      supervisores: de(ROLES_SUPERVISOR),
      operadores: de(ROLES_OPERADOR),
      conductores: de(ROLES_CONDUCTOR),
    };
  }

  /** El rango pedido, o el del servicio del ticket si no se pidió uno. */
  private async rangoDe(ticketId: string | null, desde?: string, hasta?: string): Promise<Rango> {
    for (const f of [desde, hasta]) {
      if (f !== undefined && (!FECHA.test(f) || Number.isNaN(Date.parse(`${f}T00:00:00Z`)))) {
        throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD');
      }
    }
    if (hasta !== undefined && desde === undefined)
      throw new BadRequestException('Indique también la fecha inicial');
    const t = ticketId
      ? await this.prisma.ticket.findUnique({
          where: { id: ticketId },
          select: { fechaInicioServicio: true, fechaFinServicio: true },
        })
      : null;
    if (ticketId && !t) throw new NotFoundException('El ticket no existe');
    let rango: Rango;
    if (desde !== undefined) {
      rango = { desde, hasta: hasta ?? desde };
    } else {
      if (!t) throw new BadRequestException('Indique un rango (desde) o un ticket');
      rango = rangoDeServicio(t, this.hoy());
    }
    if (rango.hasta < rango.desde)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');
    return rango;
  }

  /**
   * Por persona, los tickets abiertos (de un paso no terminal: ni cerrados ni anulados) distintos de `ticketId` en los que está asignada.
   * Sin `usuarioIds`, de todas las personas asignadas.
   */
  async ocupaciones(
    db: Pick<Prisma.TransactionClient, 'ticketPersona'>,
    ticketId: string | null,
    usuarioIds: string[] | undefined,
    hoy: string,
  ): Promise<Map<string, Ocupacion[]>> {
    const filas = await db.ticketPersona.findMany({
      where: {
        ...(ticketId ? { ticketId: { not: ticketId } } : {}),
        ...(usuarioIds ? { usuarioId: { in: usuarioIds } } : {}),
        ticket: { paso: { terminal: false } },
      },
      select: {
        usuarioId: true,
        ticket: {
          select: {
            id: true,
            ticketNumero: true,
            pedidoCodigo: true,
            fechaInicioServicio: true,
            fechaFinServicio: true,
            cliente: { select: { nombreFiscal: true, nombreComercial: true } },
          },
        },
      },
    });
    const porPersona = new Map<string, Ocupacion[]>();
    for (const f of filas) {
      const lista = porPersona.get(f.usuarioId) ?? [];
      lista.push(ocupacionDeTicket({ ...f.ticket, cliente: nombreCliente(f.ticket.cliente) }, hoy));
      porPersona.set(f.usuarioId, lista);
    }
    return porPersona;
  }
}
