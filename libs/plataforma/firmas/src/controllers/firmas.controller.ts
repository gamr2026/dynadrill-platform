import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { FirmasDeDocumentoQueryDto } from '../dto/consulta.dto';
import { ConsultaService } from '../services/consulta.service';
import { VerificacionService } from '../services/verificacion.service';

/**
 * Evidencia de firma. No hay endpoint para firmar: cada módulo registra la firma publicando `<contenedor>.<documento>.firmado`
 * después de validar quién puede firmar (contrato 4.14); así nadie puede inventar una firma ni firmar por otro.
 */
@Controller('firmas')
export class FirmasController {
  constructor(
    private readonly consulta: ConsultaService,
    private readonly verificacion: VerificacionService,
  ) {}

  /** Las firmas de un documento con su historia y su última verificación. */
  @RequirePermission(Permission.FIRMAS_VER)
  @Get()
  deDocumento(@Query() q: FirmasDeDocumentoQueryDto) {
    return this.consulta.deDocumento(q.documentoTipo, q.documentoId);
  }

  /** Lee el archivo de una firma manuscrita y guarda el resultado como un intento más. */
  @RequirePermission(Permission.FIRMAS_VERIFICAR)
  @Post(':id/verificar')
  @HttpCode(200)
  verificar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.verificacion.verificar(id, actor);
  }
}
