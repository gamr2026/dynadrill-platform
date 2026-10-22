import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { RequisitosLegalesConsultaService } from './requisitos-legales-consulta.service';
import { RequisitosLegalesService } from './requisitos-legales.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class RegistrarRequisitoLegalDto {
  @IsUUID() tipoId!: string;
  @IsString() @MaxLength(50) revision!: string;
  @Matches(FECHA) fechaAprobacion!: string;
  @IsOptional() @Matches(FECHA) vigenteHasta?: string;
  /** Documento subido antes a `/api/archivos` con el módulo `qhse_requisito_legal`. */
  @IsUUID() archivoId!: string;
}

/**
 * Requisitos legales (matrices de Gestión Ambiental y SST). Ruta pública `/api/v2/qhse/legal`. Verlos: `qhse.legal.ver`; registrar una revisión
 * nueva: `qhse.legal.gestionar`. El Supervisor no entra.
 */
@Controller('qhse/legal')
export class RequisitosLegalesController {
  constructor(
    private readonly legal: RequisitosLegalesService,
    private readonly consulta: RequisitosLegalesConsultaService,
  ) {}

  @RequirePermission(P.LEGAL_VER)
  @Get('tipos')
  tipos() {
    return this.consulta.tipos();
  }

  @RequirePermission(P.LEGAL_VER)
  @Get()
  listar() {
    return this.consulta.listar();
  }

  @RequirePermission(P.LEGAL_VER)
  @Get(':id')
  uno(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.uno(id);
  }

  @RequirePermission(P.LEGAL_GESTIONAR)
  @Post()
  registrar(@Body() dto: RegistrarRequisitoLegalDto, @CurrentUser() actor: AuthUser) {
    return this.legal.registrar(dto, actor);
  }
}
