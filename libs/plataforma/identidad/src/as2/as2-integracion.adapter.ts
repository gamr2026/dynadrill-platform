import { Injectable } from '@nestjs/common';
import { IntegracionError, MotorService } from '@dyn/integraciones';
import { As2Empleado, As2Error, As2Port, As2Usuario } from './as2.port';

const PROVEEDOR = 'as2';

/**
 * AS2 a través del registro de integraciones: la URL, la autenticación, los campos pedidos y su traducción viven
 * en la base de datos (módulo `integraciones`), no aquí. Este adaptador solo ordena las filas ya traducidas a las
 * dos formas que usa `identidad`. Si AS2 cambia una ruta o un campo se corrige con una versión nueva de la operación.
 */
@Injectable()
export class As2IntegracionAdapter extends As2Port {
  constructor(private readonly motor: MotorService) {
    super();
  }

  disponible(): Promise<boolean> {
    return this.motor.disponible(PROVEEDOR);
  }

  async listarEmpleados(): Promise<As2Empleado[]> {
    const { registros } = await this.ejecutar('listar_empleados');
    return registros.map((r) => ({
      idEmpleado: r['idEmpleado'] as number,
      cedula: r['cedula'] as string,
      nombres: (r['nombres'] as string | null) ?? '',
      apellidos: (r['apellidos'] as string | null) ?? '',
      genero: (r['genero'] as string | null) ?? null,
      cargo: (r['cargo'] as string | null) ?? null,
      departamento: (r['departamento'] as string | null) ?? null,
      sucursal: (r['sucursal'] as string | null) ?? null,
      tipoContrato: (r['tipoContrato'] as string | null) ?? null,
      fechaIngreso: (r['fechaIngreso'] as Date | null) ?? null,
      fechaSalida: (r['fechaSalida'] as Date | null) ?? null,
    }));
  }

  async listarUsuarios(): Promise<As2Usuario[]> {
    const { registros } = await this.ejecutar('listar_usuarios');
    return registros.map((r) => ({
      identificacion: r['identificacion'] as string,
      email: (r['email'] as string | null) ?? null,
    }));
  }

  private async ejecutar(operacion: string) {
    try {
      return await this.motor.ejecutar(PROVEEDOR, operacion);
    } catch (e) {
      if (e instanceof IntegracionError) throw new As2Error(e.message);
      throw e;
    }
  }
}
