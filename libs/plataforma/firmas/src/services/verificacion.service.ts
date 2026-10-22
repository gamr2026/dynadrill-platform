import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { VerificacionResponse } from '../dto/consulta.dto';
import { PrismaService } from '../prisma/prisma.service';
import { VerificadorFirmaPort } from '../puertos/verificador.port';

/**
 * Lee el archivo de una firma manuscrita en busca de la firma y guarda el resultado como un intento más (la evidencia no se
 * modifica). Es una ayuda para revisar: no certifica la autenticidad.
 */
@Injectable()
export class VerificacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verificador: VerificadorFirmaPort,
  ) {}

  async verificar(firmaId: string, actor: AuthUser): Promise<VerificacionResponse> {
    const firma = await this.prisma.firma.findUnique({
      where: { id: firmaId },
      select: { id: true, metodo: true, archivoId: true, firmante: { select: { nombre: true } } },
    });
    if (!firma) throw new NotFoundException('La firma no existe');
    if (firma.metodo !== 'manuscrita' || !firma.archivoId) {
      throw new ConflictException(
        'Solo se lee la firma de los documentos firmados a mano; la firma de una línea no tiene archivo y la electrónica se valida con el servicio de firmas electrónicas',
      );
    }
    // el servicio de lectura es lento y externo: se llama fuera de toda transacción
    const lectura = await this.verificador.leer(firma.archivoId, firma.firmante.nombre, actor);
    const v = await this.prisma.firmaVerificacion.create({
      data: {
        id: uuidv7(),
        firmaId: firma.id,
        resultado: lectura.resultado,
        confianza: lectura.confianza,
        nombreCoincide: lectura.nombreCoincide,
        solicitadaPor: actor.id,
      },
      include: { solicitante: { select: { id: true, nombre: true } } },
    });
    return {
      id: v.id,
      resultado: v.resultado,
      confianza: Number(v.confianza),
      nombreCoincide: v.nombreCoincide,
      verificadaAt: v.verificadaAt.toISOString(),
      solicitadaPor: v.solicitante,
    };
  }
}
