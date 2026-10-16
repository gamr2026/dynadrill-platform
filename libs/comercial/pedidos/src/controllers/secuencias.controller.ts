import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { AnularEmisionDto, EmisionesQueryDto } from '../dto/secuencias.dto';
import { SecuenciasService } from '../services/secuencias.service';

/**
 * Consulta de documentos y secuenciales del ciclo comercial. Emitir un número NO es un endpoint: lo hace el servicio
 * dentro de la transacción que crea el documento (pedido, prefactura...). Aquí solo se ve y se anula.
 */
@Controller('comercial/secuencias')
export class SecuenciasController {
  constructor(private readonly secuencias: SecuenciasService) {}

  @RequirePermission(Permission.SECUENCIAS_VER)
  @Get()
  listar() {
    return this.secuencias.listar();
  }

  @RequirePermission(Permission.SECUENCIAS_VER)
  @Get(':id/emisiones')
  emisiones(@Param('id', ParseUUIDPipe) id: string, @Query() q: EmisionesQueryDto) {
    return this.secuencias.emisiones(id, q.limit);
  }

  /** Anula un número emitido (con motivo). El número no se reutiliza. */
  @RequirePermission(Permission.SECUENCIAS_EDITAR)
  @Post('emisiones/:id/anular')
  async anular(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AnularEmisionDto) {
    await this.secuencias.anular(id, dto.motivo);
    return { ok: true };
  }
}
