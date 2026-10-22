import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { DerramesMaeService } from './derrames-mae.service';
import { DerramesContencionService } from './derrames-contencion.service';
import { DerramesConsultaService } from './derrames-consulta.service';
import { DerramesService } from './derrames.service';

const P = Permission;

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
}
