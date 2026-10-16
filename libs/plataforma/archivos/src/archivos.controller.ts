import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AnyAuthenticated, AuthUser, CurrentUser } from '@dyn/common';
import { ArchivosService, ArchivoSubido } from './archivos.service';
import { VerificarFirmaDto } from './archivos.dto';

/** Tope absoluto del formulario; cada módulo fija su propio máximo (hasta 200 MB) en `modulo_archivo`. */
const TOPE_BYTES = 200 * 1024 * 1024;

/**
 * Archivos. Cualquier usuario autenticado puede llamar, pero el permiso que exige subir, ver o descargar lo define el
 * módulo dueño del archivo (`modulo_archivo`): se comprueba en el servicio.
 */
@Controller('archivos')
export class ArchivosController {
  constructor(private readonly archivos: ArchivosService) {}

  /** `multipart/form-data` con `archivo` (el contenido) y `modulo` (clave del módulo, p. ej. `pedido_documento`). */
  @AnyAuthenticated()
  @Post()
  @UseInterceptors(
    FileInterceptor('archivo', { storage: memoryStorage(), limits: { fileSize: TOPE_BYTES } }),
  )
  subir(
    @UploadedFile() archivo: ArchivoSubido | undefined,
    @Body('modulo') modulo: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.archivos.subir(archivo, modulo, actor);
  }

  @AnyAuthenticated()
  @Get(':id')
  metadatos(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.archivos.metadatos(id, actor);
  }

  @AnyAuthenticated()
  @Get(':id/contenido')
  async contenido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Res() res: Response,
  ) {
    const { archivo, flujo } = await this.archivos.contenido(id, actor);
    res.set({
      'Content-Type': archivo.mimeType,
      'Content-Length': String(archivo.tamanoBytes),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    flujo.pipe(res);
  }

  /** Lee el archivo en busca de una firma manuscrita. Ayuda para revisar; no certifica la autenticidad. */
  @AnyAuthenticated()
  @Post(':id/verificar-firma')
  verificarFirma(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerificarFirmaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.archivos.verificarFirma(id, dto, actor);
  }

  /** Valida las firmas digitales (electrónicas) incrustadas en un PDF. Solo PDF. */
  @AnyAuthenticated()
  @Post(':id/verificar-firma-electronica')
  verificarFirmaElectronica(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.archivos.verificarFirmaElectronica(id, actor);
  }

  @AnyAuthenticated()
  @Delete(':id')
  @HttpCode(200)
  async eliminar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.archivos.eliminar(id, actor);
    return { ok: true };
  }
}
