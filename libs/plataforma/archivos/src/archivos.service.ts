import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Archivo, ModuloArchivo } from './generated/client';
import { PrismaService } from './prisma/prisma.service';
import {
  FileStoragePort,
  FirmaVerificadorPort,
  ParametrosVerificacion,
  VerificacionFirmaElectronica,
  ScannerPort,
  VerificacionFirma,
} from './ports';

/** Lo que llega del formulario multipart (multer, en memoria). */
export interface ArchivoSubido {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface ArchivoDto {
  id: string;
  modulo: string;
  nombre: string;
  mimeType: string;
  tamanoBytes: number;
  sha256: string;
  escaneado: boolean;
  subidoPor: string;
  createdAt: Date;
}

const aDto = (a: Archivo & { modulo: ModuloArchivo }): ArchivoDto => ({
  id: a.id,
  modulo: a.modulo.codigo,
  nombre: a.nombreOriginal,
  mimeType: a.mimeType,
  tamanoBytes: Number(a.tamanoBytes),
  sha256: a.sha256,
  escaneado: a.escaneo === 'limpio',
  subidoPor: a.subidoPor,
  createdAt: a.createdAt,
});

/** Firmas (primeros bytes) de los formatos más comunes: el contenido debe corresponder al tipo que declara el archivo. */
const FIRMAS: Record<string, number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'application/zip': [[0x50, 0x4b, 0x03, 0x04]],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    [0x50, 0x4b, 0x03, 0x04],
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [[0x50, 0x4b, 0x03, 0x04]],
};

const coincideFirma = (mime: string, contenido: Buffer): boolean => {
  const firmas = FIRMAS[mime];
  if (!firmas) return true;
  return firmas.some((f) => f.every((b, i) => contenido[i] === b));
};

/** Sin rutas ni caracteres de control; el nombre es solo una etiqueta, el contenido se guarda con una clave propia. */
const limpiarNombre = (n: string): string => {
  // eslint-disable-next-line no-control-regex
  const base =
    n
      .split(/[\\/]/)
      .pop()
      ?.replace(/[\u0000-\u001f]/g, '')
      .trim() ?? '';
  return (base || 'archivo').slice(0, 200);
};

/**
 * Registro y custodia de archivos. Valida permisos, tipo, tamaño y firma del contenido; lo analiza con el antivirus;
 * guarda el contenido en el almacenamiento de objetos y su registro (con huella SHA-256) en la base de datos.
 */
@Injectable()
export class ArchivosService {
  private readonly logger = new Logger(ArchivosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly almacen: FileStoragePort,
    private readonly escaner: ScannerPort,
    private readonly firmas: FirmaVerificadorPort,
    private readonly bus: EventBus,
  ) {}

  async subir(
    archivo: ArchivoSubido | undefined,
    moduloCodigo: string | undefined,
    actor: AuthUser,
  ): Promise<ArchivoDto> {
    if (!archivo) throw new BadRequestException('Falta el archivo (campo "archivo")');
    if (!moduloCodigo) throw new BadRequestException('Indique el módulo (campo "modulo")');
    const modulo = await this.prisma.moduloArchivo.findFirst({
      where: { codigo: moduloCodigo, activo: true },
    });
    if (!modulo) throw new BadRequestException(`El módulo "${moduloCodigo}" no admite archivos`);
    this.exigir(actor, modulo.permisoSubir);

    if (archivo.size === 0) throw new BadRequestException('El archivo está vacío');
    if (archivo.size > modulo.tamanoMaxMb * 1024 * 1024) {
      throw new PayloadTooLargeException(`El archivo supera el máximo de ${modulo.tamanoMaxMb} MB`);
    }
    if (!modulo.tiposMime.includes(archivo.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no admitido (${archivo.mimetype}). Admitidos: ${modulo.tiposMime.join(', ')}`,
      );
    }
    if (!coincideFirma(archivo.mimetype, archivo.buffer)) {
      throw new UnprocessableEntityException('El contenido del archivo no corresponde a su tipo');
    }

    let escaneo: 'limpio' | 'omitido';
    try {
      const r = await this.escaner.escanear(archivo.buffer);
      if (!r.limpio) {
        this.logger.warn(
          `Archivo rechazado por antivirus (${r.amenaza ?? 'amenaza'}) de ${actor.id}`,
        );
        throw new UnprocessableEntityException('El archivo fue rechazado por el antivirus');
      }
      escaneo = r.omitido ? 'omitido' : 'limpio';
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw e;
      this.logger.error(`Antivirus no disponible: ${(e as Error).message}`);
      throw new ServiceUnavailableException('No se pudo analizar el archivo; intente de nuevo');
    }

    const id = uuidv7();
    const hoy = new Date();
    const blobKey = `${modulo.codigo}/${hoy.getUTCFullYear()}/${String(hoy.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
    await this.almacen.guardar(blobKey, archivo.buffer, archivo.mimetype);
    try {
      const creado = await this.prisma.$transaction(async (tx) => {
        const fila = await tx.archivo.create({
          data: {
            id,
            moduloId: modulo.id,
            nombreOriginal: limpiarNombre(archivo.originalname),
            mimeType: archivo.mimetype,
            tamanoBytes: archivo.size,
            sha256: createHash('sha256').update(archivo.buffer).digest('hex'),
            blobKey,
            escaneo,
            subidoPor: actor.id,
          },
          include: { modulo: true },
        });
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'plataforma.archivo.subido',
            subject: { type: 'archivo', id },
            data: { archivoId: id, modulo: modulo.codigo, tamanoBytes: archivo.size },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
        return fila;
      });
      return aDto(creado);
    } catch (e) {
      await this.almacen.borrar(blobKey).catch(() => undefined); // no dejar contenido huérfano
      throw e;
    }
  }

  async metadatos(id: string, actor: AuthUser): Promise<ArchivoDto> {
    const a = await this.cargar(id);
    this.exigir(actor, a.modulo.permisoVer);
    return aDto(a);
  }

  async contenido(id: string, actor: AuthUser): Promise<{ archivo: ArchivoDto; flujo: Readable }> {
    const a = await this.cargar(id);
    this.exigir(actor, a.modulo.permisoVer);
    return { archivo: aDto(a), flujo: await this.almacen.leer(a.blobKey) };
  }

  /**
   * Lee el archivo en busca de una firma manuscrita (servicio `firmas-ocr`). Es una ayuda para revisar: no certifica la
   * autenticidad. Exige el permiso de ver los archivos del módulo. Si el servicio no está o falla, responde 503 y NUNCA
   * bloquea el flujo de quien llama.
   */
  async verificarFirma(
    id: string,
    parametros: ParametrosVerificacion,
    actor: AuthUser,
  ): Promise<VerificacionFirma> {
    const a = await this.cargar(id);
    this.exigir(actor, a.modulo.permisoVer);
    if (!this.firmas.disponible()) {
      throw new ServiceUnavailableException('La verificación de firmas no está disponible');
    }
    const partes: Buffer[] = [];
    for await (const trozo of await this.almacen.leer(a.blobKey)) partes.push(trozo as Buffer);
    try {
      return await this.firmas.verificar(
        Buffer.concat(partes),
        a.nombreOriginal,
        a.mimeType,
        parametros,
      );
    } catch (e) {
      // el mensaje del error no incluye contenido del documento
      this.logger.warn(`Verificación de firma fallida (${id}): ${(e as Error).message}`);
      throw new ServiceUnavailableException('No se pudo verificar la firma; intente de nuevo');
    }
  }

  /**
   * Valida las firmas digitales (FirmaEC y similares) incrustadas en un PDF: integridad, vigencia y cadena de confianza.
   * Solo PDF. Si el servicio no está o falla responde 503 y NUNCA bloquea el flujo de quien llama.
   */
  async verificarFirmaElectronica(
    id: string,
    actor: AuthUser,
  ): Promise<VerificacionFirmaElectronica> {
    const a = await this.cargar(id);
    this.exigir(actor, a.modulo.permisoVer);
    if (a.mimeType !== 'application/pdf') {
      throw new BadRequestException('La firma electrónica solo se valida en archivos PDF');
    }
    if (!this.firmas.disponible()) {
      throw new ServiceUnavailableException('La verificación de firmas no está disponible');
    }
    const partes: Buffer[] = [];
    for await (const trozo of await this.almacen.leer(a.blobKey)) partes.push(trozo as Buffer);
    try {
      return await this.firmas.verificarFirmaElectronica(Buffer.concat(partes), a.nombreOriginal);
    } catch (e) {
      this.logger.warn(`Validación de firma electrónica fallida (${id}): ${(e as Error).message}`);
      throw new ServiceUnavailableException(
        'No se pudo validar la firma electrónica; intente de nuevo',
      );
    }
  }

  /** Baja lógica: el registro queda (y el contenido en el almacenamiento) para auditoría; deja de ser accesible. */
  async eliminar(id: string, actor: AuthUser): Promise<void> {
    const a = await this.cargar(id);
    this.exigir(actor, a.modulo.permisoSubir);
    await this.prisma.archivo.update({
      where: { id },
      data: { eliminadoAt: new Date(), eliminadoPor: actor.id },
    });
  }

  private async cargar(id: string) {
    const a = await this.prisma.archivo.findFirst({
      where: { id, eliminadoAt: null },
      include: { modulo: true },
    });
    if (!a) throw new NotFoundException('El archivo no existe');
    return a;
  }

  private exigir(actor: AuthUser, permiso: string) {
    if (!actor.permissions.includes(permiso)) {
      throw new ForbiddenException('No tiene permiso para esta operación con archivos');
    }
  }
}
