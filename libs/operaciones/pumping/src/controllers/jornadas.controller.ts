import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { JornadasService } from '../services/jornadas.service';

const P = Permission;

export class SinOperacionDto {
  @IsUUID() motivoId!: string;
  @IsString() @MinLength(3) @MaxLength(500) detalle!: string;
}

export class ReabrirJornadaDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

/** Jornadas (un día de operación) de un ticket de Pumping. La fecha va como AAAA-MM-DD. */
@Controller('operaciones/pumping')
export class JornadasController {
  constructor(private readonly jornadas: JornadasService) {}

  /** Las jornadas del ticket con su estado de hoy; en la Ejecución operativa se crean las que falten. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('tickets/:id/jornadas')
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.jornadas.listar(id);
  }

  /** Motivos para registrar un día sin operación. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('jornadas/motivos-sin-operacion')
  motivos() {
    return this.jornadas.motivosSinOperacion();
  }

  /** El Supervisor marca que el Company Man aceptó trabajar ese día; la jornada queda abierta. */
  @RequirePermission(P.PUMPING_JORNADA_ACEPTAR_COMPANY_MAN)
  @Post('tickets/:id/jornadas/:fecha/aceptacion-company-man')
  aceptar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.aceptarCompanyMan(id, fecha, actor);
  }

  /** Registra un día sin operación (motivo del catálogo y detalle). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/jornadas/:fecha/sin-operacion')
  sinOperacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: SinOperacionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.sinOperacion(id, fecha, dto.motivoId, dto.detalle, actor);
  }

  /** El Supervisor cierra la jornada; no se cierra un día que todavía no llega. */
  @RequirePermission(P.PUMPING_JORNADA_CERRAR)
  @Post('tickets/:id/jornadas/:fecha/cerrar')
  cerrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.cerrar(id, fecha, actor);
  }

  /** Reabre con motivo una jornada cerrada o sin operación. */
  @RequirePermission(P.PUMPING_JORNADA_REABRIR)
  @Post('tickets/:id/jornadas/:fecha/reabrir')
  reabrir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: ReabrirJornadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.reabrir(id, fecha, dto.motivo, actor);
  }
}
