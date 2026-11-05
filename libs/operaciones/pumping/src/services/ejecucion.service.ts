import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { JornadasService } from './jornadas.service';

/**
 * Ruta anterior «formalizar la ejecución» (el Supervisor confirmaba una sola vez que el Company Man aprobó el inicio). Desde las jornadas la
 * aceptación del Company Man es diaria y es un requisito de apertura de cada día: esta ruta se conserva para la pantalla actual y equivale a
 * marcar la aceptación del día de hoy. Ya no condiciona la salida de Ejecución operativa (esa depende de que todas las jornadas estén resueltas).
 *
 * @deprecated usar `POST operaciones/pumping/tickets/:id/jornadas/:fecha/aceptacion-company-man`.
 */
@Injectable()
export class EjecucionService {
  constructor(private readonly jornadas: JornadasService) {}

  async formalizar(ticketId: string, actor: AuthUser) {
    await this.jornadas.aceptarCompanyMan(ticketId, this.jornadas.hoy(), actor);
    return { ok: true };
  }
}
