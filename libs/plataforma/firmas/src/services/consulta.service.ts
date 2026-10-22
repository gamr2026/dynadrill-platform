import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  FirmaResponse,
  FirmasDeDocumentoResponse,
  VerificacionResponse,
} from '../dto/consulta.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

const INCLUIR = {
  rolFirmante: { select: { id: true, codigo: true, descripcion: true } },
  firmante: { select: { id: true, nombre: true } },
  archivo: { select: { id: true, nombreOriginal: true, sha256: true } },
  verificaciones: {
    orderBy: { verificadaAt: 'desc' },
    take: 1,
    include: { solicitante: { select: { id: true, nombre: true } } },
  },
} satisfies Prisma.FirmaInclude;

type FirmaConRelaciones = Prisma.FirmaGetPayload<{ include: typeof INCLUIR }>;

/** Consulta de la evidencia de firma. Solo lee: la historia es inmutable y la escribe únicamente el registrador. */
@Injectable()
export class ConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Todas las firmas de un documento, la más reciente primero; en cada papel solo la más reciente es la vigente. */
  async deDocumento(
    documentoTipo: string,
    documentoId: string,
  ): Promise<FirmasDeDocumentoResponse> {
    const tipo = await this.prisma.documentoTipo.findUnique({
      where: { codigo: documentoTipo },
      select: { id: true },
    });
    if (!tipo)
      throw new NotFoundException(
        `El documento «${documentoTipo}» no está en el catálogo de firmas`,
      );
    const filas = await this.prisma.firma.findMany({
      where: { documentoTipoId: tipo.id, documentoId },
      include: INCLUIR,
      // el id (UUIDv7) desempata las firmas del mismo instante de forma estable
      orderBy: [{ firmadaAt: 'desc' }, { id: 'desc' }],
    });
    const vistos = new Set<string>();
    const firmas = filas.map((f) => {
      const vigente = !vistos.has(f.rolFirmante.id);
      vistos.add(f.rolFirmante.id);
      return aRespuesta(f, vigente);
    });
    return { documentoTipo, documentoId, firmas };
  }
}

function aRespuesta(f: FirmaConRelaciones, vigente: boolean): FirmaResponse {
  const v = f.verificaciones[0];
  const verificacion: VerificacionResponse | null = v
    ? {
        id: v.id,
        resultado: v.resultado,
        confianza: Number(v.confianza),
        nombreCoincide: v.nombreCoincide,
        verificadaAt: v.verificadaAt.toISOString(),
        solicitadaPor: v.solicitante,
      }
    : null;
  return {
    id: f.id,
    rolFirmante: { codigo: f.rolFirmante.codigo, descripcion: f.rolFirmante.descripcion },
    firmante: f.firmante,
    firmadaAt: f.firmadaAt.toISOString(),
    metodo: f.metodo,
    vigente,
    hashDocumento: f.hashDocumento,
    archivo: f.archivo
      ? { id: f.archivo.id, nombre: f.archivo.nombreOriginal, sha256: f.archivo.sha256 }
      : null,
    verificacion,
  };
}
