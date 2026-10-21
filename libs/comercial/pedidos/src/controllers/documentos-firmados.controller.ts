import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { CargarDocumentoFirmadoDto } from '../dto/prefacturas.dto';
import { DocumentosFirmadosService } from '../services/documentos-firmados.service';

const P = Permission;
const sinBearer = (auth?: string) => (auth ?? '').replace(/^Bearer\s+/i, '');

/** Versión firmada del monitoreo y de la mezcla química del ticket, que carga Facturación (con el indicador de la firma). */
@Controller('comercial/pedidos/:pedidoId/documentos-firmados')
export class DocumentosFirmadosController {
  constructor(private readonly firmados: DocumentosFirmadosService) {}

  @RequirePermission(P.DOCUMENTOS_OPERATIVOS_VER)
  @Get()
  listar(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.firmados.listar(pedidoId);
  }

  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post()
  cargar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: CargarDocumentoFirmadoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.firmados.cargar(pedidoId, dto, actor, sinBearer(auth));
  }

  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post(':id/verificar')
  verificar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.firmados.verificarDeNuevo(pedidoId, id, sinBearer(auth));
  }
}
