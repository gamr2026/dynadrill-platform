import { ForbiddenException, Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus, type SqlExecutor } from '@dyn/messaging';

export type Catalogo =
  | 'cliente'
  | 'persona_contacto'
  | 'bloque'
  | 'campo'
  | 'pozo'
  | 'taladro'
  | 'zona'
  | 'bodega'
  | 'condicion_pago'
  | 'transportista'
  | 'tipo_vehiculo'
  | 'vehiculo'
  | 'chofer';
export type Cambio = 'creado' | 'actualizado' | 'inactivado';

/**
 * Evento `plataforma.catalogo.actualizado`: los demás contenedores mantienen réplicas locales de estos
 * datos (cap. 8 de la arquitectura). Se guarda en el outbox dentro de la misma transacción del cambio.
 */
@Injectable()
export class CatalogoEventos {
  constructor(private readonly bus: EventBus) {}

  async publicar(
    tx: SqlExecutor,
    catalogo: Catalogo,
    id: string,
    cambio: Cambio,
    actor: AuthUser,
  ): Promise<void> {
    const event = this.bus.create({
      type: 'plataforma.catalogo.actualizado',
      subject: { type: catalogo, id },
      data: { catalogo, id, cambio },
      actor: { userId: actor.id, role: actor.roleCode },
      traceparent: currentTraceparent(),
    });
    await this.bus.publish(tx, event);
  }
}

/**
 * Editar no puede servir para saltarse "inactivar": dejar en `false` una fila activa ES inactivarla, así que
 * exige ese permiso. Reactivar (`true`) solo exige editar.
 */
export function exigirInactivar(
  actor: AuthUser,
  permiso: string,
  estabaActivo: boolean,
  solicitado: boolean | undefined,
): void {
  if (solicitado === false && estabaActivo && !actor.permissions.includes(permiso)) {
    throw new ForbiddenException(`Para inactivar se necesita el permiso ${permiso}`);
  }
}
