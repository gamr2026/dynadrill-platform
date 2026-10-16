/** Persona que recibe un aviso. */
export interface Destinatario {
  id: string;
  nombre: string;
  email: string;
  /** Cargo en AS2 o, si no tiene, el nombre del rol: personaliza el mensaje. */
  cargo: string;
  rolNombre: string;
}

/**
 * Quiénes tienen un rol. Lo implementa el contenedor con el módulo de identidad (los usuarios nunca se leen de sus
 * tablas); así `avisos` no conoce a `identidad`.
 */
export abstract class DestinatariosPort {
  abstract activosPorRol(rolCodigo: string): Promise<Destinatario[]>;
  /** Las cuentas indicadas que estén ACTIVAS (para avisar a quien se eligió, no a todo un rol). */
  abstract activosPorIds(ids: string[]): Promise<Destinatario[]>;
}
