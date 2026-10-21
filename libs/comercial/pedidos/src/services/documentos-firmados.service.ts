import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { DirectorioPort } from '../directorio/directorio.port';
import { CargarDocumentoFirmadoDto } from '../dto/prefacturas.dto';
import { PrismaService } from '../prisma/prisma.service';

const resultado = {
  firma_detectada: 'firma_detectada',
  no_detectada: 'firma_no_detectada',
  no_concluyente: 'no_concluyente',
} as const;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Versión firmada del monitoreo de un día o de la mezcla química de un ticket, que carga Facturación. Solo se guarda el archivo y el
 * resultado de la lectura automática de la firma (una ayuda: el indicador dice si se detectó una firma, no certifica nada). La versión
 * anterior se conserva como historia; vale la última.
 */
@Injectable()
export class DocumentosFirmadosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directorio: DirectorioPort,
  ) {}

  async listar(pedidoId: string) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true },
    });
    if (!pedido) throw new NotFoundException('El pedido no existe');
    const filas = await this.prisma.documentoRespaldoFirmado.findMany({
      where: { pedidoId, reemplazadoPorId: null },
      include: { archivo: true },
      orderBy: { createdAt: 'asc' },
    });
    return filas.map((f) => ({
      id: f.id,
      tipo: f.tipo,
      documentoTicketId: f.documentoTicketId,
      fecha: f.fecha ? f.fecha.toISOString().slice(0, 10) : null,
      archivoId: f.archivoId,
      archivoNombre: f.archivo.nombreOriginal,
      verificacion: f.verificacion,
      verificacionConfianza:
        f.verificacionConfianza === null ? null : Number(f.verificacionConfianza),
      cargadoAt: f.createdAt,
    }));
  }

  async cargar(pedidoId: string, dto: CargarDocumentoFirmadoDto, actor: AuthUser, token: string) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true, ticketOperativo: { select: { origen: true } } },
    });
    if (!pedido) throw new NotFoundException('El pedido no existe');
    if (pedido.estado === 'borrador' || pedido.estado === 'anulado') {
      throw new ConflictException('Este pedido no admite documentos firmados');
    }
    if (pedido.ticketOperativo?.origen !== 'pumping') {
      throw new ConflictException('El pedido no tiene un ticket de Pumping con estos documentos');
    }
    if (dto.tipo === 'monitoreo') {
      if (!dto.fecha || !FECHA.test(dto.fecha)) {
        throw new BadRequestException('Indique el día del monitoreo (yyyy-MM-dd)');
      }
    } else if (dto.fecha) {
      throw new BadRequestException('La mezcla química no lleva fecha');
    }
    const archivo = await this.directorio.archivo(dto.archivoId, token);
    if (!archivo) throw new BadRequestException('El archivo indicado no existe');
    if (archivo.modulo !== 'documento_respaldo_firmado') {
      throw new BadRequestException('El archivo no se subió como documento firmado');
    }
    if (archivo.subidoPor !== actor.id) {
      throw new BadRequestException('Solo se puede registrar un archivo que usted mismo subió');
    }
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const vigente = await tx.documentoRespaldoFirmado.findFirst({
        where: { pedidoId, documentoTicketId: dto.documentoTicketId, reemplazadoPorId: null },
        select: { id: true },
      });
      await tx.documentoRespaldoFirmado.create({
        data: {
          id,
          pedidoId,
          tipo: dto.tipo,
          documentoTicketId: dto.documentoTicketId,
          fecha: dto.fecha ? new Date(`${dto.fecha}T00:00:00.000Z`) : null,
          archivoId: archivo.id,
          registradoPor: actor.id,
        },
      });
      if (vigente) {
        await tx.documentoRespaldoFirmado.update({
          where: { id: vigente.id },
          data: { reemplazadoPorId: id },
        });
      }
    });
    // la lectura de la firma tarda unos segundos: no retrasa ni condiciona la carga
    void this.verificar(id, archivo.id, token);
    return this.listar(pedidoId);
  }

  /** Vuelve a leer la firma de un documento ya cargado. */
  async verificarDeNuevo(pedidoId: string, id: string, token: string) {
    const f = await this.prisma.documentoRespaldoFirmado.findFirst({ where: { id, pedidoId } });
    if (!f) throw new NotFoundException('El documento firmado no existe en este pedido');
    await this.verificar(f.id, f.archivoId, token);
    return this.listar(pedidoId);
  }

  private async verificar(id: string, archivoId: string, token: string): Promise<void> {
    try {
      const v = await this.directorio.verificarFirma(archivoId, {}, token);
      await this.prisma.documentoRespaldoFirmado.update({
        where: { id },
        data: v
          ? {
              verificacion: resultado[v.resultado],
              verificacionConfianza: v.confianza,
              verificacionAt: new Date(),
            }
          : { verificacionAt: new Date() },
      });
    } catch {
      // la lectura es una ayuda: nunca interrumpe la carga
    }
  }
}
