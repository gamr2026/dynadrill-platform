import { Injectable } from '@nestjs/common';
import { Destinatario, DestinatariosPort } from '@dyn/avisos';
import { UsuariosPorRolService } from '@dyn/identidad';

/** Quiénes tienen un rol: se le pregunta a identidad (la única que conoce a los usuarios). */
@Injectable()
export class DestinatariosIdentidadAdapter extends DestinatariosPort {
  constructor(private readonly usuarios: UsuariosPorRolService) {
    super();
  }

  async activosPorRol(rolCodigo: string): Promise<Destinatario[]> {
    const lista = await this.usuarios.activosPorRol(rolCodigo);
    return lista.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      cargo: u.cargo,
      rolNombre: u.rolNombre,
    }));
  }

  async activosPorIds(ids: string[]): Promise<Destinatario[]> {
    const lista = await this.usuarios.activosPorIds(ids);
    return lista.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      cargo: u.cargo,
      rolNombre: u.rolNombre,
    }));
  }
}
