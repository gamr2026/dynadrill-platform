import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { DerramesBandasService } from './derrames-bandas.service';
import { DerramesDesechoService } from './derrames-desecho.service';
import { DerramesMaeService } from './derrames-mae.service';
import { DerramesContencionService } from './derrames-contencion.service';
import { DerramesConsultaService } from './derrames-consulta.service';
import { DerramesService } from './derrames.service';

const P = Permission;

export class ResumenDerramesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2200) anio?: number;
}

export class ListarDerramesDto {
  @IsOptional() @IsIn(['activo', 'contenido', 'cerrado']) estado?:
    'activo' | 'contenido' | 'cerrado';
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class ActivarDerrameDto {
  @IsUUID() ubicacionId!: string;
  @IsUUID() bandaId!: string;
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(300) ubicacionFisica?: string;
  @IsOptional() @IsUUID() ticketId?: string;
}

export class LineaDesechoDerrameDto {
  @IsString() @MaxLength(500) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(100) numeroLote?: string;
  @IsString() @MaxLength(100) codigo!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(999_999_999) cantidadGalones!: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) bultos?: number;
}

export class GenerarDesechoDto {
  @IsUUID() contenedorId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  caracteristicaIds!: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LineaDesechoDerrameDto)
  items!: LineaDesechoDerrameDto[];
  @IsOptional() @IsString() @MaxLength(1000) nota?: string;
}

export class ActualizarBandaDto {
  @IsOptional() @IsString() @MaxLength(100) nombre?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(9_999_999) desdeBarriles?: number;
  /** `null` = sin tope. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(9_999_999) hastaBarriles?:
    number | null;
  @IsOptional() @IsBoolean() exigeNotificacionMae?: boolean;
  @IsOptional() @IsBoolean() escalaAEmergencia?: boolean;
  @IsOptional() @IsBoolean() porConfirmar?: boolean;
  @IsOptional() @IsBoolean() activo?: boolean;
}

export class NotificarMaeDto {
  /** Número o referencia del oficio o reporte presentado al MAE (opcional). */
  @IsOptional() @IsString() @MaxLength(100) referencia?: string;
}

export class ConfirmarPasoDto {
  @IsUUID() itemId!: string;
}

export class ConfirmarVolumenDto {
  /** Volumen real estimado tras la contención, en barriles. */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) barriles!: number;
}

/**
 * Derrames. Ruta pública `/api/v2/qhse/derrames`. Activar la alerta es de cualquier usuario autenticado (`qhse.eventos.reportar`);
 * verlos y gestionarlos es del equipo HSE.
 */
@Controller('qhse/derrames')
export class DerramesController {
  constructor(
    private readonly derrames: DerramesService,
    private readonly contencion: DerramesContencionService,
    private readonly mae: DerramesMaeService,
    private readonly desecho: DerramesDesechoService,
    private readonly bandas: DerramesBandasService,
    private readonly consulta: DerramesConsultaService,
  ) {}

  /** Catálogos del formulario de alerta (lo usa quien reporta, aunque no vea la bandeja). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  activar(@Body() dto: ActivarDerrameDto, @CurrentUser() actor: AuthUser) {
    return this.derrames.activar(dto, actor);
  }

  /** Tablero: por estado, MAE pendientes, contención en plazo y volumen real del año. Va antes de `:id`. */
  @RequirePermission(P.DERRAMES_VER)
  @Get('resumen')
  resumen(@Query() q: ResumenDerramesDto) {
    return this.consulta.tablero(q.anio);
  }

  /** Bandas de volumen con su rango y si siguen por confirmar con Dynadrill. */
  @RequirePermission(P.DERRAMES_VER)
  @Get('bandas')
  listarBandas() {
    return this.bandas.listar();
  }

  /** Configura una banda (Gerente HSE): umbrales, notificación al MAE y escalada; la base impide solapes. */
  @RequirePermission(P.DERRAMES_CONFIGURAR)
  @Put('bandas/:id')
  actualizarBanda(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarBandaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.bandas.actualizar(id, dto, actor);
  }

  @RequirePermission(P.DERRAMES_VER)
  @Get()
  listar(@Query() q: ListarDerramesDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.DERRAMES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  /** Confirma un paso del checklist de contención (con el derrame activo). */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/checklist')
  confirmarPaso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarPasoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contencion.confirmarPaso(id, dto.itemId, actor);
  }

  /** Marca el derrame como contenido (exige todos los pasos); informa si se cumplió el plazo de 5 minutos. */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/contener')
  contener(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.contencion.contener(id, actor);
  }

  /** Volumen real en barriles, confirmado después de contener (se puede corregir mientras no esté cerrado). */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/volumen')
  confirmarVolumen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarVolumenDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contencion.confirmarVolumen(id, dto.barriles, actor);
  }

  /** Registra la notificación al MAE (obligatoria si el derrame la requiere); una vez registrada no se cambia. */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/notificar-mae')
  notificarMae(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotificarMaeDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.mae.notificarMae(id, dto, actor);
  }

  /** Cierra el derrame contenido; sin la notificación al MAE no se cierra si la requiere. */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/cerrar')
  cerrar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.mae.cerrar(id, actor);
  }

  /** Genera el desecho peligroso de un derrame en suelo: HSE elige la característica CRETIB, el contenedor y los galones. */
  @RequirePermission(P.DERRAMES_GESTIONAR)
  @Post(':id/generar-desecho')
  generarDesecho(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerarDesechoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.desecho.generar(id, dto, actor);
  }
}
