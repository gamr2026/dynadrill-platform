import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/client';

export interface UsuarioDeRol {
  id: string;
  nombre: string;
  email: string;
  /** Cargo en AS2 (si la cuenta tiene ficha de empleado) o el nombre del rol. */
  cargo: string;
  rolCodigo: string;
  rolNombre: string;
}

const capitalizar = (s: string) => {
  const t = s.toLowerCase().trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/**
 * Consulta de solo lectura para otros módulos del contenedor (p. ej. avisos): las personas ACTIVAS que tienen un rol.
 * Es la única forma de leer usuarios desde fuera de identidad; nadie lee sus tablas directamente.
 */
@Injectable()
export class UsuariosPorRolService {
  constructor(private readonly prisma: PrismaService) {}

  async activosPorRol(rolCodigo: string): Promise<UsuarioDeRol[]> {
    return this.buscar({ rol: { codigo: rolCodigo } });
  }

  /** Las cuentas indicadas que estén activas. */
  async activosPorIds(ids: string[]): Promise<UsuarioDeRol[]> {
    if (!ids.length) return [];
    return this.buscar({ id: { in: ids } });
  }

  private async buscar(where: Prisma.UsuarioWhereInput): Promise<UsuarioDeRol[]> {
    const filas = await this.prisma.usuario.findMany({
      where: { activo: true, ...where },
      include: {
        rol: { select: { codigo: true, nombre: true } },
        perfil: { select: { cargo: true } },
      },
      orderBy: { nombre: 'asc' },
    });
    return filas.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      cargo: u.perfil?.cargo ? capitalizar(u.perfil.cargo) : u.rol.nombre,
      rolCodigo: u.rol.codigo,
      rolNombre: u.rol.nombre,
    }));
  }
}
