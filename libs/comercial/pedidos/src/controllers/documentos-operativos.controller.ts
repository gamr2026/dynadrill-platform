import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  CorregirDiaOperativoDto,
  DocumentosOperativosQueryDto,
  RecibirDocumentoOperativoDto,
} from '../dto/documentos-operativos.dto';
import { DocumentosOperativosService } from '../services/documentos-operativos.service';

/** Documentos operativos del pedido (Reporte Job y Reporte de Herramientas) y su avance documental. */
@Controller('comercial/pedidos/:pedidoId/documentos-operativos')
export class DocumentosOperativosController {
  constructor(private readonly documentos: DocumentosOperativosService) {}

  /** Operaciones envía un documento; si ya existe uno con la misma clave (tipo, origen, fecha), lo reemplaza. */
  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_ENVIAR)
  @Post()
  recibir(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: RecibirDocumentoOperativoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.recibir(pedidoId, dto, actor);
  }

  /** Facturación corrige un día del Reporte Job (lista vacía = quitar el día) hasta que el pedido sale para firmas. */
  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_CORREGIR)
  @Put('dia')
  corregirDia(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: CorregirDiaOperativoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.corregirDia(pedidoId, dto, actor);
  }

  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_VER)
  @Get()
  listar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Query() q: DocumentosOperativosQueryDto,
  ) {
    return this.documentos.listar(pedidoId, q.tipo);
  }

  /** Qué falta para tener la documentación completa. */
  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_VER)
  @Get('avance')
  avance(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.documentos.avance(pedidoId);
  }

  @RequirePermission(Permission.DOCUMENTOS_OPERATIVOS_ELIMINAR)
  @Delete(':documentoId')
  @HttpCode(200)
  async eliminar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Param('documentoId', ParseUUIDPipe) documentoId: string,
  ) {
    await this.documentos.eliminar(pedidoId, documentoId);
    return { ok: true };
  }
}
