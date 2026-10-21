import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class EmitirOrdenTrabajoDto {
  /** Ciudad del número de la OT (catálogo); por defecto la primera activa (UIO). */
  @IsOptional() @IsUUID() ciudadId?: string;
  /** Descripción del requerimiento; por defecto "Servicio ejecutado según prefactura". */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(300) descripcionRequerimiento?: string;
  /** Representante del cliente que firma la OT; por defecto quien firmó la prefactura por el cliente. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) representanteClienteNombre?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) representanteClienteCargo?: string;
}

export class RegistrarOrdenFirmadaDto {
  /** Archivo opcional subido a `archivos` con módulo `orden_trabajo_documento`. */
  @IsOptional() @IsUUID() archivoId?: string;
}
