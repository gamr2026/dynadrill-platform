import { Controller, Get, Headers, Param, ParseUUIDPipe } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { ExpedienteService } from '../expediente/expediente.service';

/** Índice de documentos vigentes del pedido (sección «Documentos de respaldo» y descarga del ZIP). */
@Controller('comercial/pedidos/:pedidoId/expediente')
export class ExpedienteController {
  constructor(private readonly expediente: ExpedienteService) {}

  /**
   * Los documentos del pedido por origen. Lo de Operaciones y QHSE se consulta con el token de quien pide; un módulo que no
   * responde sale como grupo no disponible (con su motivo), nunca como error de todo el índice.
   */
  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_VER)
  @Get()
  indice(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.expediente.construir(pedidoId, (auth ?? '').replace(/^Bearer\s+/i, ''));
  }
}
