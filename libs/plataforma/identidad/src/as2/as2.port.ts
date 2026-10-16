/** Empleado tal como lo entiende el portal: ya recortado, con fechas de calendario y sin datos sensibles. */
export interface As2Empleado {
  idEmpleado: number;
  cedula: string;
  nombres: string;
  apellidos: string;
  genero: string | null;
  cargo: string | null;
  departamento: string | null;
  sucursal: string | null;
  tipoContrato: string | null;
  fechaIngreso: Date | null;
  fechaSalida: Date | null;
}

/** Usuario de AS2: solo lo que sirve para cruzar con un empleado y conocer su correo. */
export interface As2Usuario {
  identificacion: string;
  email: string | null;
}

/** Falla al hablar con AS2 (red, autenticación, respuesta inesperada). Nunca lleva credenciales. */
export class As2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'As2Error';
  }
}

/**
 * Puerto hacia AS2. El módulo solo conoce esta clase; el adaptador HTTP es reemplazable (otro ERP, un
 * archivo, un doble en las pruebas) sin tocar la sincronización.
 */
export abstract class As2Port {
  /** `false` si la integración no está configurada o está inactiva: la sincronización queda deshabilitada. */
  abstract disponible(): Promise<boolean>;
  abstract listarEmpleados(): Promise<As2Empleado[]>;
  abstract listarUsuarios(): Promise<As2Usuario[]>;
}
