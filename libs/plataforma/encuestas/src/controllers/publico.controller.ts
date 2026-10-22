import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Public } from '@dyn/common';
import { ResponderService } from '../services/responder.service';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RespuestaPreguntaDto {
  @IsUUID() preguntaId!: string;
  /** El tipo del valor depende de la pregunta (número, texto, sí/no, id de opción o lista de ids): lo valida el servicio. */
  @IsDefined() valor!: unknown;
}

export class ResponderEncuestaDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Escriba su nombre' })
  @MaxLength(120)
  nombre!: string;
  @IsOptional() @Transform(recortar) @IsString() @MaxLength(120) cargo?: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RespuestaPreguntaDto)
  respuestas!: RespuestaPreguntaDto[];
}

/**
 * Formulario público de la encuesta: el cliente lo abre con el enlace del correo, sin sesión. El token del enlace es lo que autoriza (el
 * gateway deja pasar solo este tramo sin token de sesión). Un solo uso, con vigencia de un día.
 */
@Controller('encuestas/publico')
export class PublicoController {
  constructor(private readonly responder: ResponderService) {}

  @Public()
  @Get(':token')
  obtener(@Param('token') token: string) {
    return this.responder.obtener(token);
  }

  @Public()
  @Post(':token')
  contestar(@Param('token') token: string, @Body() dto: ResponderEncuestaDto) {
    return this.responder.responder(token, dto);
  }
}
