import type { Rol, Usuario, UsuarioPerfil } from '../generated/client';
import type { RolResponse, UserResponse } from './user.dto';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Traduce columnas de la base a los nombres del contrato del frontend. Es la única salida de un
 * usuario: nunca se serializa la entidad completa, así `password_hash`, los intentos fallidos y
 * el estado de bloqueo no pueden filtrarse por accidente (OWASP: exposición excesiva de datos).
 */
export function toUserResponse(u: Usuario & { perfil?: UsuarioPerfil | null }): UserResponse {
  const e = u.perfil;
  return {
    id: u.id,
    legacyId: u.legacyId,
    email: u.email,
    username: u.username,
    name: u.nombre,
    phone: u.telefono ?? '',
    roleId: u.rolId,
    status: u.activo,
    tipoVinculo: u.tipoVinculo,
    specialty: u.especialidad,
    ...(e
      ? {
          cedula: e.cedula,
          tipoIdentificacion: e.tipoIdentificacion,
          nacionalidad: e.nacionalidad,
          apellidos: e.apellidos,
          nombres: e.nombres,
          cargo: e.cargo,
          departamento: e.departamento,
          area: e.area,
          fechaIngreso: iso(e.fechaIngreso),
          fechaSalida: iso(e.fechaSalida),
          causaSalidaEmpleado: e.causaSalida,
          tipoContrato: e.tipoContrato,
          sucursal: e.sucursal,
          tipoDiscapacidad: e.tipoDiscapacidad,
          cargasActivas: e.cargasActivas,
          categoria: e.categoria,
          centroCosto: e.centroCosto,
          empleadoActivo: e.empleadoActivo,
        }
      : {}),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function toRolResponse(r: Rol): RolResponse {
  return {
    id: r.id,
    legacyId: r.legacyId,
    name: r.nombre,
    code: r.codigo,
    description: r.descripcion,
  };
}
