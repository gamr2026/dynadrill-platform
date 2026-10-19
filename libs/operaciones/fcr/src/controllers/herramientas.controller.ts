import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { HerramientasService } from '../services/herramientas.service';

const P = Permission;

export class AgregarHerramientaDto {
  @IsUUID() articuloId!: string;
}

export class SolicitarHerramientasDto {
  /** Las herramientas a solicitar; sin lista, todas las que faltan por solicitar. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  herramientaIds?: string[];
}

export class NovedadDto {
  /** Lo que impide dar la herramienta por buena; sin novedad, la marca se da por cumplida. */
  @IsOptional() @IsString() @MaxLength(500) novedad?: string;
}

export class ConfirmarListadoDto {
  @IsBoolean() confirmado!: boolean;
}

export class BuscarHerramientasDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/** Herramientas de un ticket de FCR: precarga desde el pedido y el recorrido Supervisor → Bodega → Supervisor. */
@Controller('operaciones/fcr')
export class HerramientasController {
  constructor(private readonly herramientas: HerramientasService) {}

  /** Artículos del inventario que son herramientas (categorías con partes), para armar un kit o agregar una al ticket. */
  @RequirePermission(P.FCR_VER)
  @Get('herramientas-disponibles')
  disponibles(@Query() q: BuscarHerramientasDto) {
    return this.herramientas.disponibles(q.q);
  }

  /** Lo que Bodega tiene por preparar o enviar, de todos los tickets. */
  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Get('herramientas/pendientes-de-bodega')
  pendientesDeBodega() {
    return this.herramientas.pendientesDeBodega();
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('tickets/:id/herramientas')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.herramientas.detalle(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/herramientas')
  agregar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgregarHerramientaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.agregar(id, dto.articuloId, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Delete('tickets/:id/herramientas/:herramientaId')
  quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.quitar(id, herramientaId, actor);
  }

  /** «Recargar desde el pedido»: vuelve a armar la precarga (solo en la preparación y con el listado sin confirmar). */
  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/herramientas/recargar')
  recargar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.herramientas.recargar(id, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/herramientas/solicitar')
  solicitar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SolicitarHerramientasDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.solicitar(id, dto.herramientaIds, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/herramientas/confirmar-listado')
  confirmarListado(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarListadoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.confirmarListado(id, dto.confirmado, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/herramientas/:herramientaId/recibir')
  recibir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @Body() dto: NovedadDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.recibir(id, herramientaId, dto.novedad, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Delete('tickets/:id/herramientas/:herramientaId/recepcion')
  corregirRecepcion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.corregirRecepcion(id, herramientaId, actor);
  }

  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Post('tickets/:id/herramientas/:herramientaId/preparar')
  preparar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @Body() dto: NovedadDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.preparar(id, herramientaId, dto.novedad, actor);
  }

  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Delete('tickets/:id/herramientas/:herramientaId/preparacion')
  corregirPreparacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.corregirPreparacion(id, herramientaId, actor);
  }

  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Post('tickets/:id/herramientas/:herramientaId/enviar')
  enviar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.herramientas.enviar(id, herramientaId, actor);
  }
}
