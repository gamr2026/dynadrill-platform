import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { EstadoUsoHerramienta, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { exigirDentroDelServicio, exigirFecha } from './bitacora.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService } from './tickets.service';

const PASO = 'ejecucion_operativa';
const deDia = (f: string) => new Date(`${f}T00:00:00.000Z`);
const aDia = (d: Date) => d.toISOString().slice(0, 10);

export interface RegistroPicker {
  /** Venta: tipo de completación. */
  tipoCompletacionId?: string;
  /** Servicios: tipo de trabajo. */
  tipoTrabajoId?: string;
  tipoPickerId: string;
  presion: number;
  peso: number;
  /** Solo si hubo alguna novedad durante el uso de la herramienta. */
  observacion?: string;
}

/**
 * Uso diario de las herramientas en la ejecución: por herramienta y día, su estado de cobro (operación, stand by, daily charge o venta,
 * el que recibe Comercial) y, opcionalmente, el registro de completación (venta) o tipo de trabajo (servicios), picker, presión y peso.
 * Registrar de nuevo la misma herramienta y día reemplaza la fila. Va dentro de las fechas del servicio. El operador confirma al final
 * que el listado de uso está completo (requisito para finalizar la ejecución).
 */
@Injectable()
export class UsoHerramientasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  async listar(ticketId: string) {
    if (!(await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } })))
      throw new NotFoundException('El ticket no existe');
    const [usos, confirmado] = await Promise.all([
      this.prisma.usoHerramientaDia.findMany({
        where: { herramienta: { ticketId } },
        include: {
          herramienta: { include: { articulo: { select: { codigo: true, nombre: true } } } },
          tipoCompletacion: true,
          tipoTrabajo: true,
          tipoPicker: true,
        },
        orderBy: [{ fecha: 'asc' }, { herramientaId: 'asc' }],
      }),
      this.prisma.ticketRequisito.count({
        where: { ticketId, requisitoCodigo: REQ.listadoUsoConfirmado, estado: 'cumplido' },
      }),
    ]);
    return {
      listadoConfirmado: confirmado > 0,
      usos: usos.map((u) => ({
        id: u.id,
        herramientaId: u.herramientaId,
        codigo: u.herramienta.articulo.codigo,
        nombre: u.herramienta.articulo.nombre,
        fecha: aDia(u.fecha),
        estado: u.estado,
        tipoCompletacion: u.tipoCompletacion?.nombre ?? null,
        tipoTrabajo: u.tipoTrabajo?.nombre ?? null,
        tipoPicker: u.tipoPicker?.nombre ?? null,
        presion: u.presion === null ? null : Number(u.presion),
        peso: u.peso === null ? null : Number(u.peso),
        observacion: u.observacion,
      })),
    };
  }

  /** Registra (o reemplaza) el uso de una herramienta en un día. */
  async registrar(
    ticketId: string,
    herramientaId: string,
    fecha: string,
    estado: EstadoUsoHerramienta,
    picker: RegistroPicker | undefined,
    actor: AuthUser,
  ) {
    exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirOperador(tx, ticketId, actor);
      exigirDentroDelServicio(t, fecha);
      const h = await tx.ticketHerramienta.findFirst({ where: { id: herramientaId, ticketId } });
      if (!h) throw new NotFoundException('La herramienta no existe en este ticket');
      if (!h.recibidaAt) {
        throw new ConflictException(
          'La herramienta todavía no fue recibida: no se puede registrar su uso',
        );
      }
      if (h.devueltaAt || h.faltanteAt) {
        throw new ConflictException('La herramienta ya tiene su retorno registrado');
      }
      const datos = await this.datosDelPicker(tx, t.tipoOt, picker);
      const previo = await tx.usoHerramientaDia.findUnique({
        where: { herramientaId_fecha: { herramientaId, fecha: deDia(fecha) } },
      });
      const comunes = { estado, ...datos, updatedBy: actor.id };
      if (previo) await tx.usoHerramientaDia.update({ where: { id: previo.id }, data: comunes });
      else
        await tx.usoHerramientaDia.create({
          data: {
            id: uuidv7(),
            herramientaId,
            fecha: deDia(fecha),
            createdBy: actor.id,
            ...comunes,
          },
        });
      // cualquier cambio del listado obliga a confirmarlo de nuevo
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.listar(ticketId);
  }

  async quitar(ticketId: string, usoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      const u = await tx.usoHerramientaDia.findFirst({
        where: { id: usoId, herramienta: { ticketId } },
      });
      if (!u) throw new NotFoundException('El registro de uso no existe en este ticket');
      await tx.usoHerramientaDia.delete({ where: { id: usoId } });
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.listar(ticketId);
  }

  /** «El listado de uso está completo»: verificación previa a finalizar la ejecución (distinta del listado de la preparación). */
  async confirmarListado(ticketId: string, confirmado: boolean, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      const clave = { ticketId, codigo: REQ.listadoUsoConfirmado };
      if (confirmado) await this.requisitos.marcar(tx, clave, 'sistema', actor.id);
      else await this.requisitos.reabrir(tx, clave);
    });
    return this.listar(ticketId);
  }

  /** Completación en venta, tipo de trabajo en servicios; picker, presión y peso siempre que se registre el picker. */
  private async datosDelPicker(
    tx: Prisma.TransactionClient,
    tipoOt: 'venta' | 'servicio',
    p: RegistroPicker | undefined,
  ) {
    const vacio = {
      tipoCompletacionId: null,
      tipoTrabajoId: null,
      tipoPickerId: null,
      presion: null,
      peso: null,
      observacion: null,
    };
    if (!p) return vacio;
    const falta = (campo: string) => new BadRequestException(`Falta ${campo}.`);
    if (tipoOt === 'servicio') {
      if (!p.tipoTrabajoId) throw falta('el tipo de trabajo');
      if (p.tipoCompletacionId)
        throw new BadRequestException('La completación es de las órdenes de venta');
    } else {
      if (!p.tipoCompletacionId) throw falta('el tipo de completación');
      if (p.tipoTrabajoId)
        throw new BadRequestException('El tipo de trabajo es de las órdenes de servicios');
    }
    const [completacion, trabajo, pickerTipo] = await Promise.all([
      p.tipoCompletacionId
        ? tx.tipoCompletacion.findUnique({ where: { id: p.tipoCompletacionId } })
        : null,
      p.tipoTrabajoId ? tx.tipoTrabajo.findUnique({ where: { id: p.tipoTrabajoId } }) : null,
      tx.tipoPicker.findUnique({ where: { id: p.tipoPickerId } }),
    ]);
    if (p.tipoCompletacionId && !completacion?.activo)
      throw new BadRequestException('El tipo de completación no existe');
    if (p.tipoTrabajoId && !trabajo?.activo)
      throw new BadRequestException('El tipo de trabajo no existe');
    if (!pickerTipo?.activo) throw new BadRequestException('El tipo de picker no existe');
    return {
      tipoCompletacionId: p.tipoCompletacionId ?? null,
      tipoTrabajoId: p.tipoTrabajoId ?? null,
      tipoPickerId: p.tipoPickerId,
      presion: p.presion,
      peso: p.peso,
      observacion: p.observacion?.trim() || null,
    };
  }

  private async exigirOperador(tx: Prisma.TransactionClient, ticketId: string, actor: AuthUser) {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException(
        'El uso de las herramientas se registra en la Ejecución operativa',
      );
    }
    this.tickets.exigirActuar(t, actor);
    return t;
  }
}
