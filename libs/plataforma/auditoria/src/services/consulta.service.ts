import { BadRequestException, Injectable } from '@nestjs/common';
import { CLAVE_DE_SUJETO } from '../catalog/claves-dato';
import type {
  BuscarEventosQueryDto,
  ConsultaBaseDto,
  EventoAuditadoResponse,
  LineaDeTiempoQueryDto,
  PaginaDeEventosResponse,
} from '../dto/consulta.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

const LIMITE_POR_DEFECTO = 50;

const INCLUIR = {
  tipoEvento: { select: { codigo: true } },
  sujetoTipo: { select: { codigo: true } },
  actor: { select: { id: true, nombre: true } },
  actorRol: { select: { codigo: true, nombre: true } },
  datos: { select: { valor: true, claveDato: { select: { codigo: true } } } },
} satisfies Prisma.EventoAuditadoInclude;

type EventoConRelaciones = Prisma.EventoAuditadoGetPayload<{ include: typeof INCLUIR }>;

/** Consulta del registro de auditoría. Solo lee: la historia es inmutable y la escribe únicamente el proyector. */
@Injectable()
export class ConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hechos de una entidad en orden cronológico. Incluye los que la nombran en sus datos (los del ticket de un pedido, por
   * ejemplo), no solo los que la tienen como sujeto.
   */
  lineaDeTiempo(q: LineaDeTiempoQueryDto): Promise<PaginaDeEventosResponse> {
    const propios: Prisma.EventoAuditadoWhereInput = {
      sujetoTipo: { codigo: q.sujetoTipo },
      sujetoId: q.sujetoId,
    };
    const clave = CLAVE_DE_SUJETO[q.sujetoTipo];
    const donde: Prisma.EventoAuditadoWhereInput = clave
      ? {
          OR: [propios, { datos: { some: { claveDato: { codigo: clave }, valor: q.sujetoId } } }],
        }
      : propios;
    return this.pagina([donde, ...this.rango(q)], q, 'asc');
  }

  /** Búsqueda por actor, tipo, origen, sujeto, clave de negocio y fechas; lo más reciente primero. */
  buscar(q: BuscarEventosQueryDto): Promise<PaginaDeEventosResponse> {
    if (!q.clave !== !q.valor) {
      throw new BadRequestException(
        'Para buscar por una clave de negocio indique la clave y su valor.',
      );
    }
    if ((q.sujetoTipo === undefined) !== (q.sujetoId === undefined)) {
      throw new BadRequestException('Para buscar por entidad indique su tipo y su id.');
    }
    const filtros: Prisma.EventoAuditadoWhereInput[] = [
      ...(q.actorId ? [{ actorId: q.actorId }] : []),
      ...(q.tipo ? [{ tipoEvento: { codigo: q.tipo } }] : []),
      ...(q.origen ? [{ origen: q.origen }] : []),
      ...(q.sujetoTipo && q.sujetoId
        ? [{ sujetoTipo: { codigo: q.sujetoTipo }, sujetoId: q.sujetoId }]
        : []),
      ...(q.clave && q.valor
        ? [{ datos: { some: { claveDato: { codigo: q.clave }, valor: q.valor } } }]
        : []),
      ...this.rango(q),
    ];
    return this.pagina(filtros, q, 'desc');
  }

  private rango(q: ConsultaBaseDto): Prisma.EventoAuditadoWhereInput[] {
    const desde = q.desde ? new Date(q.desde) : undefined;
    const hasta = q.hasta ? new Date(q.hasta) : undefined;
    if (desde && hasta && desde > hasta) {
      throw new BadRequestException('La fecha «desde» no puede ser posterior a «hasta».');
    }
    return [
      ...(desde ? [{ ocurridoAt: { gte: desde } }] : []),
      ...(hasta ? [{ ocurridoAt: { lte: hasta } }] : []),
    ];
  }

  private async pagina(
    filtros: Prisma.EventoAuditadoWhereInput[],
    q: ConsultaBaseDto,
    orden: 'asc' | 'desc',
  ): Promise<PaginaDeEventosResponse> {
    const limite = q.limite ?? LIMITE_POR_DEFECTO;
    const pagina = q.pagina ?? 1;
    const where: Prisma.EventoAuditadoWhereInput = { AND: filtros };
    const [total, filas] = await Promise.all([
      this.prisma.eventoAuditado.count({ where }),
      this.prisma.eventoAuditado.findMany({
        where,
        include: INCLUIR,
        // el id (UUIDv7) desempata los hechos del mismo instante de forma estable
        orderBy: [{ ocurridoAt: orden }, { id: orden }],
        skip: (pagina - 1) * limite,
        take: limite,
      }),
    ]);
    return { total, pagina, limite, items: filas.map(aRespuesta) };
  }
}

function aRespuesta(f: EventoConRelaciones): EventoAuditadoResponse {
  return {
    id: f.id,
    tipo: f.tipoEvento.codigo,
    version: f.version,
    ocurridoAt: f.ocurridoAt.toISOString(),
    origen: f.origen,
    sujeto: { tipo: f.sujetoTipo.codigo, id: f.sujetoId },
    actor: f.actor ? { id: f.actor.id, nombre: f.actor.nombre, rol: f.actorRol ?? null } : null,
    correlacionId: f.correlacionId,
    causaId: f.causaId,
    datos: Object.fromEntries(f.datos.map((d) => [d.claveDato.codigo, d.valor])),
  };
}
