import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { hoyEcuador } from '../comun/fechas';
import { VerificadorFirmas } from '../documentos/verificador-firmas';
import { texto, type Tx } from '../epi/epi-tipos';
import { TipoDocumentoDesecho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { DesechosConsultaService } from './desechos-consulta.service';
import { DesechosEventosService } from './desechos-eventos.service';

/** Código del módulo de archivos por el que se suben estos documentos (así se verifica el permiso de subida). */
export const MODULO_ARCHIVO_DESECHO = 'qhse_desecho_documento';

export interface CertificadoEntrada {
  archivoId: string;
  /** AAAA-MM-DD: la fecha que dice el certificado del gestor. */
  emitidoEl: string;
  referencia?: string | null;
}

/**
 * Documentos firmados de un desecho: el manifiesto firmado a mano y el certificado de disposición final, que cierra el ciclo. Al cargar
 * cada uno se lee la firma con el OCR de plataforma (D6) y se guarda solo el resultado: es una ayuda para revisar, nunca bloquea la carga.
 */
@Injectable()
export class DesechosDocumentosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DesechosEventosService,
    private readonly consulta: DesechosConsultaService,
    private readonly firmas: VerificadorFirmas,
  ) {}

  /** Carga el manifiesto firmado (evidencia de las tres firmas). */
  async cargarManifiestoFirmado(
    id: string,
    entrada: { archivoId: string; referencia?: string | null },
    actor: AuthUser,
    token?: string,
  ) {
    const documentoId = await this.prisma.$transaction(async (tx) => {
      await this.exigirConManifiesto(tx, id);
      if ((await tx.desechoFirma.count({ where: { manifiesto: { desechoId: id } } })) < 3)
        throw new ConflictException(
          'El manifiesto firmado se carga cuando el manifiesto tiene las tres firmas',
        );
      const docId = await this.insertar(
        tx,
        id,
        TipoDocumentoDesecho.manifiesto_firmado,
        entrada.archivoId,
        null,
        entrada.referencia,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.desecho.documento_cargado', id, actor, {
        tipoDocumento: TipoDocumentoDesecho.manifiesto_firmado,
      });
      return docId;
    });
    this.leerFirma(documentoId, entrada.archivoId, token);
    return this.consulta.detalle(id);
  }

  /** Registra el certificado de disposición final y pasa el desecho a dispuesto (exige las tres firmas del manifiesto). */
  async registrarCertificado(
    id: string,
    entrada: CertificadoEntrada,
    actor: AuthUser,
    token?: string,
  ) {
    const emitidoEl = this.fecha(entrada.emitidoEl);
    const documentoId = await this.prisma.$transaction(async (tx) => {
      const d = await this.exigirConManifiesto(tx, id);
      const manifiesto = await tx.desechoManifiesto.findUniqueOrThrow({
        where: { desechoId: id },
        select: { fecha: true, _count: { select: { firmas: true } } },
      });
      if (manifiesto._count.firmas < 3)
        throw new ConflictException(
          'El certificado se registra cuando el manifiesto tiene las tres firmas',
        );
      if (emitidoEl < manifiesto.fecha.toISOString().slice(0, 10))
        throw new BadRequestException('El certificado no puede ser anterior al manifiesto');
      const docId = await this.insertar(
        tx,
        id,
        TipoDocumentoDesecho.certificado_disposicion,
        entrada.archivoId,
        emitidoEl,
        entrada.referencia,
        actor,
      );
      const dispuesto = await tx.desechoEstado.findUniqueOrThrow({
        where: { codigo: 'dispuesto' },
      });
      const cambio = await tx.desecho.updateMany({
        where: { id, estadoId: d.estadoId },
        data: { estadoId: dispuesto.id, updatedBy: actor.id },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El desecho cambió; recargue e intente de nuevo');
      await tx.desechoHistorial.create({
        data: {
          id: uuidv7(),
          desechoId: id,
          estadoAnteriorId: d.estadoId,
          estadoNuevoId: dispuesto.id,
          actorId: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'qhse.desecho.dispuesto', id, actor, {
        certificadoEmitidoEl: emitidoEl,
      });
      return docId;
    });
    this.leerFirma(documentoId, entrada.archivoId, token);
    return this.consulta.detalle(id);
  }

  /** Vuelve a leer la firma de un documento ya cargado (ayuda para revisar; no certifica nada). */
  async verificarDeNuevo(desechoId: string, tipo: TipoDocumentoDesecho, token: string) {
    const doc = await this.prisma.desechoDocumento.findUnique({
      where: { desechoId_tipo: { desechoId, tipo } },
      select: { id: true, archivoId: true },
    });
    if (!doc) throw new NotFoundException('Ese documento no está cargado');
    await this.guardarLectura(doc.id, doc.archivoId, token);
    return this.consulta.detalle(desechoId);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private fecha(v: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
      throw new BadRequestException('La fecha de emisión debe ser AAAA-MM-DD');
    if (v > hoyEcuador())
      throw new BadRequestException('La fecha de emisión del certificado no puede ser futura');
    return v;
  }

  private async exigirConManifiesto(tx: Tx, id: string) {
    const d = await tx.desecho.findUnique({
      where: { id },
      select: { estadoId: true, estado: { select: { codigo: true } } },
    });
    if (!d) throw new NotFoundException('El desecho no existe');
    if (d.estado.codigo !== 'con_manifiesto')
      throw new ConflictException(
        'Los documentos se cargan con el desecho en estado con manifiesto',
      );
    return d;
  }

  private async insertar(
    tx: Tx,
    desechoId: string,
    tipo: TipoDocumentoDesecho,
    archivoId: string,
    emitidoEl: string | null,
    referencia: string | null | undefined,
    actor: AuthUser,
  ): Promise<string> {
    const archivo = await tx.archivoRef.findUnique({
      where: { id: archivoId },
      select: { eliminadoAt: true, modulo: { select: { codigo: true } } },
    });
    if (!archivo || archivo.eliminadoAt) throw new BadRequestException('El archivo no existe');
    if (archivo.modulo.codigo !== MODULO_ARCHIVO_DESECHO)
      throw new BadRequestException(
        'El archivo no se subió como documento de desechos: súbalo de nuevo desde esta pantalla',
      );
    if (await tx.desechoDocumento.count({ where: { desechoId, tipo } }))
      throw new ConflictException('Ese documento ya está cargado');
    if (await tx.desechoDocumento.count({ where: { archivoId } }))
      throw new ConflictException('Ese archivo ya se usó en otro documento');
    const id = uuidv7();
    await tx.desechoDocumento.create({
      data: {
        id,
        desechoId,
        tipo,
        archivoId,
        emitidoEl: emitidoEl ? new Date(`${emitidoEl}T00:00:00.000Z`) : null,
        referencia: texto(referencia),
        createdBy: actor.id,
      },
    });
    return id;
  }

  /** La lectura tarda unos segundos: se lanza aparte y no retrasa ni condiciona la carga. */
  private leerFirma(documentoId: string, archivoId: string, token?: string): void {
    if (token) void this.guardarLectura(documentoId, archivoId, token);
  }

  private async guardarLectura(documentoId: string, archivoId: string, token: string) {
    try {
      const v = await this.firmas.verificar(archivoId, token);
      const resultado = {
        firma_detectada: 'firma_detectada',
        no_detectada: 'firma_no_detectada',
        no_concluyente: 'no_concluyente',
      } as const;
      await this.prisma.desechoDocumento.update({
        where: { id: documentoId },
        data: v
          ? {
              verificacion: resultado[v.resultado],
              verificacionConfianza: v.confianza,
              verificacionAt: new Date(),
            }
          : { verificacionAt: new Date() },
      });
    } catch {
      // la lectura es una ayuda: nunca interrumpe la carga del documento
    }
  }
}
