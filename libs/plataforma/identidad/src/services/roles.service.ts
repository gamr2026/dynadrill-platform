import { Injectable } from '@nestjs/common';
import { toRolResponse } from '../dto/mappers';
import type { RolResponse, UsuarioPorRolResponse } from '../dto/user.dto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<RolResponse[]> {
    const roles = await this.prisma.rol.findMany({ orderBy: { nombre: 'asc' } });
    return roles.map(toRolResponse);
  }

  /**
   * `{id, name, specialty}` de los usuarios ACTIVOS con un rol (por `code`). Nada de RRHH ni de
   * contacto: alimenta los selects de responsable/supervisor de los formularios operativos, que no
   * pueden consultar `GET /api/users` (solo Superadmin). `specialty` es operativo y lo usa Mantenimiento.
   */
  /**
   * Directorio mínimo de personas por id (nombre, rol y si siguen activas) para que otros contenedores guarden la copia
   * del nombre de un agente, técnico o analista sin poder leer toda la ficha del usuario. Máximo 50 ids.
   */
  async directorio(
    ids: string[],
  ): Promise<{ id: string; name: string; roleCode: string; activo: boolean }[]> {
    const validos = [...new Set(ids)].filter((i) => /^[0-9a-f-]{36}$/i.test(i)).slice(0, 50);
    if (validos.length === 0) return [];
    const users = await this.prisma.usuario.findMany({
      where: { id: { in: validos } },
      select: { id: true, nombre: true, activo: true, rol: { select: { codigo: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.nombre,
      roleCode: u.rol.codigo,
      activo: u.activo,
    }));
  }

  async usuariosPorRol(code: string): Promise<UsuarioPorRolResponse[]> {
    const users = await this.prisma.usuario.findMany({
      where: { activo: true, rol: { codigo: code } },
      select: { id: true, legacyId: true, nombre: true, especialidad: true },
      orderBy: { nombre: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      legacyId: u.legacyId,
      name: u.nombre,
      specialty: u.especialidad,
    }));
  }
}
