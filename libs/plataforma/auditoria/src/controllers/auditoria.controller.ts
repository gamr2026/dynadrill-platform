import { Controller, Get, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { BuscarEventosQueryDto, LineaDeTiempoQueryDto } from '../dto/consulta.dto';
import { ConsultaService } from '../services/consulta.service';

/** Consulta del registro de auditoría. Solo lectura: no hay endpoints de escritura, la historia no se edita. */
@Controller('auditoria')
export class AuditoriaController {
  constructor(private readonly consulta: ConsultaService) {}

  /** Lo que se puede elegir al filtrar la búsqueda. */
  @RequirePermission(Permission.AUDITORIA_VER)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  /** Qué pasó con una entidad (pedido, ticket, orden...), en orden cronológico. */
  @RequirePermission(Permission.AUDITORIA_VER)
  @Get('linea-de-tiempo')
  lineaDeTiempo(@Query() q: LineaDeTiempoQueryDto) {
    return this.consulta.lineaDeTiempo(q);
  }

  /** Búsqueda por actor, tipo, origen, entidad, clave de negocio y fechas; lo más reciente primero. */
  @RequirePermission(Permission.AUDITORIA_VER)
  @Get('eventos')
  buscar(@Query() q: BuscarEventosQueryDto) {
    return this.consulta.buscar(q);
  }
}
