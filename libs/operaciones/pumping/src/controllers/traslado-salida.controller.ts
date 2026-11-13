import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EjecucionService } from '../services/ejecucion.service';
import { IngresoService } from '../services/ingreso.service';
import { RequisitosService } from '../services/requisitos.service';
import { ReporteUnidadService } from '../services/reporte-unidad.service';
import { TerminosService } from '../services/terminos.service';
import { TicketNoAnuladoGuard } from '../guards/ticket-no-anulado.guard';

const P = Permission;
const GASES = ['h2s', 'lel', 'o2', 'co'] as const;
const PUNTOS = ['origen', 'destino'] as const;
const POSICIONES = [
  'delantera_izquierda',
  'delantera_derecha',
  'trasera_izquierda',
  'trasera_derecha',
] as const;
const RESULTADOS = ['conforme', 'no_conforme'] as const;

class NuevaLecturaDto {
  @IsIn(GASES) gas!: (typeof GASES)[number];
  @IsNumber() @Min(0) @Max(100000) lectura!: number;
}

export class ActualizarIngresoDto {
  @IsOptional() @IsBoolean() toolboxTalkRealizado?: boolean;
  @IsOptional() @IsBoolean() walkaroundCompletado?: boolean;
  @IsOptional() @IsBoolean() lineaBaseAmbientalDocumentada?: boolean;
  @IsOptional() @IsBoolean() rutasEmergenciaVerificadas?: boolean;
  @IsOptional() @IsBoolean() simopsConfirmado?: boolean;
  @IsOptional() @ValidateNested() @Type(() => NuevaLecturaDto) nuevaLectura?: NuevaLecturaDto;
}

class HubodometroDto {
  @Matches(/^[A-Z]$/) eje!: string;
  @IsIn(PUNTOS) punto!: (typeof PUNTOS)[number];
  @ValidateIf((o: HubodometroDto) => o.salida !== null) @IsNumber() @Min(0) salida!: number | null;
}
class LlantaDto {
  @IsIn(POSICIONES) posicion!: (typeof POSICIONES)[number];
  @ValidateIf((o: LlantaDto) => o.salida !== null) @IsString() @MaxLength(100) salida!:
    string | null;
}
class InspeccionDto {
  @IsUUID() itemId!: string;
  @IsIn(RESULTADOS) resultado!: (typeof RESULTADOS)[number];
}

export class GuardarSalidaDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) fecha!: string;
  @IsNumber() @Min(0) @Max(100000) combustible!: number;
  @IsString() @MinLength(1) @MaxLength(200) origen!: string;
  @IsString() @MinLength(1) @MaxLength(200) destino!: string;
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => HubodometroDto)
  hubodometros!: HubodometroDto[];
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => LlantaDto)
  llantas!: LlantaDto[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InspeccionDto)
  inspecciones!: InspeccionDto[];
}

class HubodometroLlegadaDto {
  @Matches(/^[A-Z]$/) eje!: string;
  @IsIn(PUNTOS) punto!: (typeof PUNTOS)[number];
  @ValidateIf((o: HubodometroLlegadaDto) => o.llegada !== null) @IsNumber() @Min(0) llegada!:
    number | null;
}
class LlantaLlegadaDto {
  @IsIn(POSICIONES) posicion!: (typeof POSICIONES)[number];
  @ValidateIf((o: LlantaLlegadaDto) => o.llegada !== null) @IsString() @MaxLength(100) llegada!:
    string | null;
}

export class GuardarLlegadaDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) fecha!: string;
  @IsNumber() @Min(0) @Max(100000) combustible!: number;
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => HubodometroLlegadaDto)
  hubodometros!: HubodometroLlegadaDto[];
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => LlantaLlegadaDto)
  llantas!: LlantaLlegadaDto[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InspeccionDto)
  inspecciones!: InspeccionDto[];
  @IsOptional() @IsString() @MaxLength(4000) novedadesMecanica?: string;
  @IsOptional() @IsString() @MaxLength(4000) novedadesInstrumentacion?: string;
  @IsOptional() @IsString() @MaxLength(4000) novedadesOperaciones?: string;
  @IsBoolean() unidadLista!: boolean;
  @IsBoolean() operacionInterrumpida!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) detalleInterrupcion?: string;
}

/**
 * Lo que exige el paso Traslado de salida: términos y condiciones, checklist de ingreso a locación y reporte de unidad de salida.
 * Ver documentacion/pumping/PLAN-TRASLADO-SALIDA.md.
 */
export class PublicarTerminosDto {
  @IsString() @MinLength(5) @MaxLength(200) titulo!: string;
  @IsString() @MinLength(50) @MaxLength(20000) texto!: string;
}

/** El día del servicio de una ruta: `AAAA-MM-DD`. */
const diaValido = (f: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(`${f}T00:00:00Z`)))
    throw new BadRequestException('El día debe tener el formato AAAA-MM-DD');
  return f;
};

@UseGuards(TicketNoAnuladoGuard)
@Controller('operaciones/pumping')
export class TrasladoSalidaController {
  constructor(
    private readonly terminos: TerminosService,
    private readonly ingreso: IngresoService,
    private readonly reportes: ReporteUnidadService,
    private readonly requisitos: RequisitosService,
    private readonly ejecucion: EjecucionService,
  ) {}

  // ---- términos y condiciones
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('terminos/vigente')
  vigente() {
    return this.terminos.vigente();
  }

  /** QHSE valida el texto (D9): lista de versiones con su estado, validar una tal cual y publicar una nueva. */
  @RequirePermission(P.PUMPING_TERMINOS_VALIDAR)
  @Get('terminos/versiones')
  versionesTerminos() {
    return this.terminos.versiones();
  }

  @RequirePermission(P.PUMPING_TERMINOS_VALIDAR)
  @Post('terminos/versiones/:codigo/validar')
  validarTerminos(@Param('codigo') codigo: string, @CurrentUser() actor: AuthUser) {
    return this.terminos.validar(codigo, actor);
  }

  @RequirePermission(P.PUMPING_TERMINOS_VALIDAR)
  @Post('terminos/versiones')
  publicarTerminos(@Body() dto: PublicarTerminosDto, @CurrentUser() actor: AuthUser) {
    return this.terminos.publicar(dto.titulo, dto.texto, actor);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/terminos')
  terminosDelTicket(@Param('id', ParseUUIDPipe) id: string) {
    return this.terminos.deTicket(id);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/terminos/aceptar')
  aceptarTerminos(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.terminos.aceptar(id, actor);
  }

  // ---- checklist de ingreso a locación (uno por día; las rutas sin fecha trabajan con el día de hoy o, si no es de servicio, el primero)
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/ingreso')
  verIngreso(@Param('id', ParseUUIDPipe) id: string) {
    return this.ingreso.obtener(id);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/ingreso/:fecha')
  verIngresoDelDia(@Param('id', ParseUUIDPipe) id: string, @Param('fecha') fecha: string) {
    return this.ingreso.obtener(id, fecha);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Patch('tickets/:id/ingreso/:fecha')
  actualizarIngresoDelDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: ActualizarIngresoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ingreso.actualizar(id, dto, actor, fecha);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Patch('tickets/:id/ingreso/:fecha/loto/:itemId')
  alternarLotoDelDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ingreso.alternarLoto(id, itemId, actor, fecha);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Patch('tickets/:id/ingreso')
  actualizarIngreso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarIngresoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ingreso.actualizar(id, dto, actor);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Patch('tickets/:id/ingreso/loto/:itemId')
  alternarLoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ingreso.alternarLoto(id, itemId, actor);
  }

  // ---- reporte de unidad (uno por unidad y día del servicio; las rutas sin día usan el reporte más reciente)
  /** Expediente del pedido: los reportes de unidad del ticket como filas de documento (solo lectura). */
  @RequirePermission(P.PUMPING_OPERAR, P.EXPEDIENTE_VER)
  @Get('tickets/:id/expediente/reportes-unidad')
  reportesParaExpediente(@Param('id', ParseUUIDPipe) id: string) {
    return this.reportes.listarParaExpediente(id);
  }

  /** Expediente del pedido: los datos de la hoja `reporte-unidad-hoja` de un reporte de unidad. */
  @RequirePermission(P.PUMPING_OPERAR, P.EXPEDIENTE_VER)
  @Get('tickets/:id/expediente/reportes-unidad/:reporteId')
  reporteParaExpediente(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reporteId', ParseUUIDPipe) reporteId: string,
  ) {
    return this.reportes.obtenerParaExpediente(id, reporteId);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/reportes-unidad')
  reportesDelTicket(@Param('id', ParseUUIDPipe) id: string, @Query('fecha') fecha?: string) {
    return this.reportes.listar(id, fecha === undefined ? undefined : diaValido(fecha));
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/reportes-unidad/:unidadId/:fecha')
  reporteDelDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Param('fecha') fecha: string,
  ) {
    return this.reportes.obtener(id, unidadId, diaValido(fecha));
  }

  /** Salida de la unidad de un día del servicio: el día del reporte es el de la ruta. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Put('tickets/:id/reportes-unidad/:unidadId/:fecha/salida')
  guardarSalidaDelDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Param('fecha') fecha: string,
    @Body() dto: GuardarSalidaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.guardarSalida(id, unidadId, { ...dto, fecha: diaValido(fecha) }, actor);
  }

  /** Llegada de la unidad de un día del servicio. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Put('tickets/:id/reportes-unidad/:unidadId/:fecha/llegada')
  guardarLlegadaDelDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Param('fecha') fecha: string,
    @Body() dto: GuardarLlegadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.guardarLlegada(id, unidadId, dto, actor, diaValido(fecha));
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/reportes-unidad/:unidadId')
  reporte(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
  ) {
    return this.reportes.obtener(id, unidadId);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Put('tickets/:id/reportes-unidad/:unidadId/salida')
  guardarSalida(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Body() dto: GuardarSalidaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.guardarSalida(id, unidadId, dto, actor);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Put('tickets/:id/reportes-unidad/:unidadId/llegada')
  guardarLlegada(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Body() dto: GuardarLlegadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.guardarLlegada(id, unidadId, dto, actor);
  }

  // ---- formalización de la ejecución (Supervisor)
  @RequirePermission(P.PUMPING_EJECUCION_FORMALIZAR)
  @Post('tickets/:id/ejecucion/formalizar')
  formalizarEjecucion(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ejecucion.formalizar(id, actor);
  }
}
