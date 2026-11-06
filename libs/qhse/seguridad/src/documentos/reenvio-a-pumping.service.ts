import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { PtwService } from '../ptw/ptw.service';
import { DocumentosPedidoService } from './documentos-pedido.service';

export interface ResumenReenvio {
  ptwAprobados: number;
  documentos: number;
}

/**
 * Reenvío único de lo que QHSE ya había hecho a Pumping. Al desplegar la jornada por día, Pumping empieza a guardar el PTW aprobado y los PT y ART
 * de cada día; lo que se aprobó o cargó antes no le llegó. Este reenvío vuelve a publicar esos hechos. Es seguro repetirlo: Pumping los guarda por
 * su origen, así que no se duplica nada.
 */
@Injectable()
export class ReenvioAPumpingService {
  constructor(
    private readonly ptw: PtwService,
    private readonly documentos: DocumentosPedidoService,
  ) {}

  async reenviar(actor: AuthUser): Promise<ResumenReenvio> {
    const ptwAprobados = await this.ptw.reenviarAprobados(actor);
    const documentos = await this.documentos.reenviarVigentes(actor);
    return { ptwAprobados, documentos };
  }
}
