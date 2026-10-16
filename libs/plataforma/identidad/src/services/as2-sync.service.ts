import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7 } from '@dyn/utils';
import { As2Empleado, As2Port } from '../as2/as2.port';
import { PrismaService } from '../prisma/prisma.service';

/** Campos de `empleado_as2` que se vigilan: cada cambio deja una fila en el historial. */
const CAMPOS = [
  'cedula',
  'nombres',
  'apellidos',
  'genero',
  'cargo',
  'departamento',
  'sucursal',
  'tipoContrato',
  'fechaIngreso',
  'fechaSalida',
  'activo',
  'correoAs2',
] as const;
type Campo = (typeof CAMPOS)[number];
type Valores = Record<Campo, string | boolean | Date | null>;

/** Si AS2 devuelve menos de esta fracción de los empleados que ya tenemos, se asume una respuesta incompleta. */
const MINIMO_RELATIVO = 0.5;
/** Una corrida `en_curso` más vieja que esto se considera abandonada y no bloquea a la siguiente. */
const CORRIDA_VIGENTE_MS = 15 * 60_000;

const dia = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const comoTexto = (v: string | boolean | Date | null): string | null =>
  v instanceof Date ? dia(v) : v === null ? null : String(v);

/**
 * Correo de AS2 por cédula. Si una cédula tiene varios usuarios con correos distintos solo se usa uno cuando es el
 * único de Dynadrill; si no, se deja sin correo (es ambiguo) y nadie recibe una cuenta con el correo equivocado.
 */
export function correoPorCedulaDe(usuarios: { identificacion: string; email: string | null }[]) {
  const porCedula = new Map<string, Set<string>>();
  for (const u of usuarios) {
    if (!u.email) continue;
    const set = porCedula.get(u.identificacion) ?? new Set<string>();
    set.add(u.email.trim().toLowerCase());
    porCedula.set(u.identificacion, set);
  }
  const resultado = new Map<string, string>();
  for (const [cedula, correos] of porCedula) {
    const lista = [...correos];
    if (lista.length === 1) {
      resultado.set(cedula, lista[0]);
      continue;
    }
    const dyn = lista.filter((c) => /@dynadrill.com(.ec)?$/.test(c));
    if (dyn.length === 1) resultado.set(cedula, dyn[0]);
  }
  return resultado;
}

export type OrigenSync = 'manual' | 'programada';

/**
 * Mantiene la copia local de los empleados de AS2. Reglas de seguridad:
 *  - Si AS2 falla o responde algo dudoso, NO se toca nada: se registra el error y se deja la copia como estaba.
 *  - Que un empleado falte en la respuesta no lo da de baja; solo una `fechaSalida` lo hace.
 *  - Inactivar cuentas del portal por una baja es opcional (`AS2_SYNC_INACTIVAR_BAJAS`, apagado por defecto).
 */
@Injectable()
export class As2SyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(As2SyncService.name);
  private readonly inactivarBajas: boolean;
  private readonly intervaloMin: number;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly as2: As2Port,
    cfg: ConfigService,
  ) {
    this.inactivarBajas = String(cfg.get('AS2_SYNC_INACTIVAR_BAJAS')) === 'true';
    this.intervaloMin = Number(cfg.get('AS2_SYNC_INTERVAL_MINUTES') ?? 0);
  }

  onApplicationBootstrap(): void {
    if (this.intervaloMin <= 0) return;
    this.timer = setInterval(() => {
      this.sincronizar('programada').catch((e: Error) =>
        this.logger.warn(`Sincronización programada con AS2 falló: ${e.message}`),
      );
    }, this.intervaloMin * 60_000);
    this.timer.unref();
    this.logger.log(`Sincronización con AS2 cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sincronizar(origen: OrigenSync, actorId?: string) {
    if (!(await this.as2.disponible())) {
      throw new ServiceUnavailableException('La integración con AS2 no está configurada');
    }
    if (this.enCurso) throw new ConflictException('Ya hay una sincronización en curso');
    const reciente = await this.prisma.sincronizacionAs2.findFirst({
      where: { estado: 'en_curso', iniciadaAt: { gt: new Date(Date.now() - CORRIDA_VIGENTE_MS) } },
      select: { id: true },
    });
    if (reciente) throw new ConflictException('Ya hay una sincronización en curso');

    this.enCurso = true;
    const ejecucion = await this.prisma.sincronizacionAs2.create({
      data: { id: uuidv7(), estado: 'en_curso', origen, disparadaPor: actorId ?? null },
    });
    try {
      const conteos = await this.ejecutar(ejecucion.id);
      return await this.prisma.sincronizacionAs2.update({
        where: { id: ejecucion.id },
        data: { estado: 'ok', finalizadaAt: new Date(), ...conteos },
      });
    } catch (e) {
      const mensaje = (e as Error).message.slice(0, 500);
      await this.prisma.sincronizacionAs2.update({
        where: { id: ejecucion.id },
        data: { estado: 'error', finalizadaAt: new Date(), error: mensaje },
      });
      this.logger.warn(`Sincronización con AS2 falló: ${mensaje}`);
      throw new BadGatewayException(`No se pudo sincronizar con AS2: ${mensaje}`);
    } finally {
      this.enCurso = false;
    }
  }

  private async ejecutar(ejecucionId: string) {
    // 1) Leer todo ANTES de escribir: si AS2 falla aquí, la copia no se toca.
    const [empleados, usuarios] = await Promise.all([
      this.as2.listarEmpleados(),
      this.as2.listarUsuarios(),
    ]);
    const existentes = await this.prisma.empleadoAs2.findMany();
    if (empleados.length === 0)
      throw new Error('AS2 devolvió 0 empleados; se descarta la respuesta');
    if (existentes.length > 0 && empleados.length < existentes.length * MINIMO_RELATIVO) {
      throw new Error(
        `AS2 devolvió ${empleados.length} empleados y ya hay ${existentes.length}; respuesta incompleta, se descarta`,
      );
    }

    const correoPorCedula = correoPorCedulaDe(usuarios);
    const porAs2Id = new Map(existentes.map((e) => [e.as2EmpleadoId, e]));
    const ahora = new Date();
    const hoy = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()));

    let nuevos = 0;
    let modificados = 0;
    let bajas = 0;
    let cuentasInactivadas = 0;

    await this.prisma.$transaction(
      async (tx) => {
        const historial: {
          id: string;
          empleadoId: string;
          campo: string;
          valorAnterior: string | null;
          valorNuevo: string | null;
          detectadoAt: Date;
          ejecucionId: string;
        }[] = [];

        for (const emp of empleados) {
          const nuevo = this.valores(emp, correoPorCedula.get(emp.cedula) ?? null, hoy);
          const previo = porAs2Id.get(emp.idEmpleado);

          if (!previo) {
            const id = uuidv7();
            await tx.empleadoAs2.create({
              data: {
                id,
                as2EmpleadoId: emp.idEmpleado,
                ...this.aColumnas(nuevo),
                sincronizadoAt: ahora,
              },
            });
            nuevos++;
            for (const campo of CAMPOS) {
              const v = comoTexto(nuevo[campo]);
              if (v !== null) {
                historial.push({
                  id: uuidv7(),
                  empleadoId: id,
                  campo,
                  valorAnterior: null,
                  valorNuevo: v,
                  detectadoAt: ahora,
                  ejecucionId,
                });
              }
            }
            continue;
          }

          const cambios = CAMPOS.filter((c) => comoTexto(previo[c]) !== comoTexto(nuevo[c]));
          if (cambios.length === 0) {
            await tx.empleadoAs2.update({
              where: { id: previo.id },
              data: { sincronizadoAt: ahora },
            });
            continue;
          }
          await tx.empleadoAs2.update({
            where: { id: previo.id },
            data: { ...this.aColumnas(nuevo), sincronizadoAt: ahora },
          });
          modificados++;
          if (previo.activo && nuevo.activo === false) bajas++;
          for (const campo of cambios) {
            historial.push({
              id: uuidv7(),
              empleadoId: previo.id,
              campo,
              valorAnterior: comoTexto(previo[campo]),
              valorNuevo: comoTexto(nuevo[campo]),
              detectadoAt: ahora,
              ejecucionId,
            });
          }
        }
        if (historial.length) await tx.empleadoAs2Historial.createMany({ data: historial });

        // 2) Enlazar perfiles que ya tengan la misma cédula y aún no tengan empleado de AS2.
        const copia = await tx.empleadoAs2.findMany({ select: { id: true, cedula: true } });
        for (const e of copia) {
          await tx.usuarioPerfil.updateMany({
            where: { cedula: e.cedula, empleadoAs2Id: null },
            data: { empleadoAs2Id: e.id },
          });
        }

        // 2b) AS2 es la fuente de verdad: los datos de la persona en el perfil se igualan a los del empleado enlazado.
        await alinearPerfilesConAs2(tx);

        // 3) Opcional: inactivar las cuentas cuyo empleado ya salió.
        if (this.inactivarBajas) {
          const cuentas = await tx.usuario.findMany({
            where: { activo: true, perfil: { empleadoAs2: { activo: false } } },
            select: { id: true },
          });
          for (const c of cuentas) {
            await tx.usuario.update({ where: { id: c.id }, data: { activo: false } });
            await tx.sesion.updateMany({
              where: { usuarioId: c.id, revocadoAt: null },
              data: { revocadoAt: ahora },
            });
          }
          cuentasInactivadas = cuentas.length;
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    return { leidos: empleados.length, nuevos, modificados, bajas, cuentasInactivadas };
  }

  /** Activo = sin fecha de salida, o con una fecha de salida que aún no llega. */
  private valores(e: As2Empleado, correo: string | null, hoy: Date): Valores {
    return {
      cedula: e.cedula,
      nombres: e.nombres,
      apellidos: e.apellidos,
      genero: e.genero,
      cargo: e.cargo,
      departamento: e.departamento,
      sucursal: e.sucursal,
      tipoContrato: e.tipoContrato,
      fechaIngreso: e.fechaIngreso,
      fechaSalida: e.fechaSalida,
      activo: e.fechaSalida === null || e.fechaSalida > hoy,
      correoAs2: correo,
    };
  }

  private aColumnas(v: Valores) {
    return {
      cedula: v.cedula as string,
      nombres: v.nombres as string,
      apellidos: v.apellidos as string,
      genero: v.genero as string | null,
      cargo: v.cargo as string | null,
      departamento: v.departamento as string | null,
      sucursal: v.sucursal as string | null,
      tipoContrato: v.tipoContrato as string | null,
      fechaIngreso: v.fechaIngreso as Date | null,
      fechaSalida: v.fechaSalida as Date | null,
      activo: v.activo as boolean,
      correoAs2: v.correoAs2 as string | null,
    };
  }
}

/**
 * AS2 es la fuente de verdad de los datos de la persona: en cada perfil enlazado a un empleado de AS2 se copian su
 * nombre, cargo, departamento, sucursal, contrato, fechas y si está activo. Solo se escriben los que difieren. Los datos
 * que AS2 no tiene (área, categoría, centro de costo...) no se tocan.
 *
 * @returns cuántos perfiles cambiaron.
 */
export async function alinearPerfilesConAs2(
  tx: Pick<PrismaService, 'usuarioPerfil'>,
): Promise<number> {
  const perfiles = await tx.usuarioPerfil.findMany({
    where: { empleadoAs2Id: { not: null } },
    include: { empleadoAs2: true },
  });
  let cambiados = 0;
  for (const p of perfiles) {
    const e = p.empleadoAs2;
    if (!e) continue;
    const datos = {
      nombres: e.nombres,
      apellidos: e.apellidos,
      cargo: e.cargo,
      departamento: e.departamento,
      sucursal: e.sucursal,
      tipoContrato: e.tipoContrato,
      fechaIngreso: e.fechaIngreso,
      fechaSalida: e.fechaSalida,
      empleadoActivo: e.activo,
    };
    const difiere = (Object.keys(datos) as Array<keyof typeof datos>).some(
      (k) => comoTexto(p[k]) !== comoTexto(datos[k]),
    );
    if (!difiere) continue;
    await tx.usuarioPerfil.update({ where: { id: p.id }, data: datos });
    cambiados++;
  }
  return cambiados;
}
