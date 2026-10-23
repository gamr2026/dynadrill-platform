import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { TipoRespuesta } from '../generated/client';
import { EncuestasService } from '../services/encuestas.service';

const P = Permission;
const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CrearEncuestaDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'El código usa minúsculas, números y guion bajo' })
  @MaxLength(60)
  codigo!: string;
  @Transform(recortar) @IsString() @MinLength(1) @MaxLength(120) nombre!: string;
  @IsString() @MaxLength(60) moduloCodigo!: string;
}

export class ActualizarEncuestaDto {
  @IsOptional() @Transform(recortar) @IsString() @MinLength(1) @MaxLength(120) nombre?: string;
  @IsOptional() @IsBoolean() activa?: boolean;
}

export class EditarBorradorDto {
  @IsOptional() @Transform(recortar) @IsString() @MinLength(1) @MaxLength(160) titulo?: string;
  @IsOptional() @IsString() @MaxLength(2000) introduccion?: string | null;
}

export class PreguntaDto {
  @Transform(recortar) @IsString() @MinLength(1) @MaxLength(500) texto!: string;
  @IsIn(Object.values(TipoRespuesta)) tipo!: TipoRespuesta;
  @IsBoolean() obligatoria!: boolean;
  @IsOptional() @IsUUID() escalaId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  opciones?: string[];
}

export class ReemplazarPreguntasDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => PreguntaDto)
  preguntas!: PreguntaDto[];
}

/** Administración de encuestas: solo quien tenga `encuestas.administracion.gestionar` (el Superadmin). */
@Controller('encuestas')
export class EncuestasController {
  constructor(private readonly encuestas: EncuestasService) {}

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get('modulos')
  modulos() {
    return this.encuestas.modulos();
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get('escalas')
  escalas() {
    return this.encuestas.escalas();
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get()
  listar(@Query('modulo') modulo?: string) {
    return this.encuestas.listar(modulo);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Post()
  crear(@Body() dto: CrearEncuestaDto, @CurrentUser() actor: AuthUser) {
    return this.encuestas.crear(dto, actor);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get('versiones/:versionId')
  version(@Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.encuestas.version(versionId);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Patch('versiones/:versionId')
  editarBorrador(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: EditarBorradorDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.encuestas.editarBorrador(versionId, dto, actor);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Put('versiones/:versionId/preguntas')
  reemplazarPreguntas(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: ReemplazarPreguntasDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.encuestas.reemplazarPreguntas(versionId, dto.preguntas, actor);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Post('versiones/:versionId/publicar')
  publicar(@Param('versionId', ParseUUIDPipe) versionId: string, @CurrentUser() actor: AuthUser) {
    return this.encuestas.publicar(versionId, actor);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get(':id')
  obtener(@Param('id', ParseUUIDPipe) id: string) {
    return this.encuestas.obtener(id);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Patch(':id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarEncuestaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.encuestas.actualizar(id, dto, actor);
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Post(':id/borrador')
  crearBorrador(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.encuestas.crearBorrador(id, actor);
  }
}
