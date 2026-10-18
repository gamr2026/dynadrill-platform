import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { REQ } from '../catalog/sembrar-pasos';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService } from './tickets.service';

const PASO = 'tipo_operador';
/** Rol de cuenta del operador que repara e inspecciona las herramientas. */
const ROL_INSPECTOR = 'operador_fcr';

/**
 * Entrada SERVICIOS, primer paso: el Supervisor elige el tipo de operador (mecánico o soldador) y la cuenta del operador FCR que repara e
 * inspecciona las herramientas. Esa cuenta pasa a ser parte del equipo (puede actuar en la inspección). Se puede cambiar mientras el
 * ticket siga en este paso.
 */
@Injectable()
export class TipoOperadorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  async definir(id: string, tipoOperadorId: string, inspectorId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, id);
      this.tickets.exigirActuar(t, actor);
      if (t.pasoCodigo !== PASO) {
        throw new ConflictException('El tipo de operador se define en el paso «Tipo de operador»');
      }
      const tipo = await tx.tipoOperador.findUnique({ where: { id: tipoOperadorId } });
      if (!tipo || !tipo.activo) throw new BadRequestException('El tipo de operador no existe');
      const inspector = await tx.idUsuario.findUnique({
        where: { id: inspectorId },
        include: { rol: true },
      });
      if (!inspector || !inspector.activo)
        throw new BadRequestException('El operador indicado no existe o está inactivo');
      if (inspector.rol.codigo !== ROL_INSPECTOR)
        throw new BadRequestException(`${inspector.nombre} no tiene el rol de operador FCR`);
      await tx.ticket.update({
        where: { id },
        data: { tipoOperadorId, inspectorId, updatedBy: actor.id },
      });
      await this.requisitos.marcar(
        tx,
        { ticketId: id, codigo: REQ.tipoOperadorDefinido },
        'sistema',
        actor.id,
      );
    });
    return this.tickets.detalle(id, actor);
  }
}
