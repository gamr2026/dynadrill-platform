import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { FORMATOS } from '../engine/formatos';
import { aplicarMapeo, leerRuta } from '../engine/mapeo';
import { ContextoPlantilla, PlantillaError, resolver } from '../engine/plantilla';
import { SecretResolver } from '../engine/secretos';
import { PrismaService } from '../prisma/prisma.service';

/** Falla al hablar con un tercero. Su mensaje nunca incluye secretos, tokens ni cuerpos de datos. */
export class IntegracionError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'IntegracionError';
  }
}

export interface EjecutarOpciones {
  /** Valores para `{{param.x}}`. */
  param?: Record<string, unknown>;
  /** `sistema` o el id del usuario que lo pidió; queda en la bitácora. */
  solicitadoPor?: string;
}

export interface ResultadoEjecucion {
  /** Filas ya traducidas a nuestro modelo. */
  registros: Record<string, unknown>[];
  /** Filas descartadas por faltarles un campo obligatorio. */
  omitidos: number;
  /** Respuesta del tercero antes de traducir (solo para diagnóstico; no se guarda). */
  leidos: number;
}

const MAX_PAGINAS = 200; // tope de seguridad contra paginaciones que no terminan
const ESPERA_REINTENTO_MS = 250;

interface Config {
  tipo: string;
  config: Record<string, unknown>;
  secretos: Record<string, string>;
}
type ProveedorCargado = NonNullable<Awaited<ReturnType<MotorService['cargarProveedor']>>>;
type OperacionCargada = NonNullable<Awaited<ReturnType<MotorService['cargarOperacion']>>>;

/**
 * Motor de integraciones: ejecuta una operación registrada en la base de datos. No sabe nada de AS2 ni de ningún
 * tercero en particular; todo lo que necesita (URL, autenticación, plantilla, paginación, mapeo) viene de las
 * tablas. Un cambio del tercero se resuelve creando una versión nueva de la operación, no desplegando código.
 */
@Injectable()
export class MotorService {
  private readonly logger = new Logger(MotorService.name);
  /** Tokens de `bearer_login` por proveedor, reutilizados hasta que vencen o el tercero los rechaza. */
  private readonly tokens = new Map<string, { valor: string; expira: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretos: SecretResolver,
  ) {}

  /** `true` si el proveedor existe, está activo y tiene al menos una operación activa. */
  async disponible(proveedor: string): Promise<boolean> {
    const p = await this.prisma.proveedor.findUnique({
      where: { codigo: proveedor },
      select: { activo: true, _count: { select: { operaciones: { where: { activa: true } } } } },
    });
    return Boolean(p?.activo && p._count.operaciones > 0);
  }

  async ejecutar(
    proveedor: string,
    operacion: string,
    opciones: EjecutarOpciones = {},
  ): Promise<ResultadoEjecucion> {
    const inicio = Date.now();
    const prov = await this.cargarProveedor(proveedor);
    if (!prov || !prov.activo)
      throw new IntegracionError(`El proveedor "${proveedor}" no está disponible`);
    const op = await this.cargarOperacion(prov.id, operacion);
    if (!op)
      throw new IntegracionError(
        `El proveedor "${proveedor}" no tiene activa la operación "${operacion}"`,
      );

    let leidos = 0;
    let omitidos = 0;
    let registros: Record<string, unknown>[] = [];
    let httpStatus: number | undefined;
    try {
      const r = await this.correr(prov, op, opciones.param ?? {});
      ({ leidos, omitidos, registros } = r);
      httpStatus = r.httpStatus;
      await this.bitacora(
        op.id,
        inicio,
        'ok',
        { httpStatus, registros: registros.length, omitidos },
        opciones,
      );
      return { registros, omitidos, leidos };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const status = error instanceof IntegracionError ? error.httpStatus : undefined;
      await this.bitacora(
        op.id,
        inicio,
        'error',
        { httpStatus: status, error: error.message },
        opciones,
      );
      if (error instanceof IntegracionError) throw error;
      throw new IntegracionError(`${proveedor}.${operacion}: ${error.message}`);
    }
  }

  /**
   * Prueba una versión de una operación (activa o no) sin tocar nada: devuelve conteos y los nombres de los campos,
   * nunca los valores. Sirve para validar una versión nueva antes de activarla.
   */
  async probar(
    operacionId: string,
    param: Record<string, unknown> = {},
    solicitadoPor = 'sistema',
  ) {
    const inicio = Date.now();
    const op = await this.prisma.operacion.findUnique({
      where: { id: operacionId },
      include: {
        mapeos: { orderBy: [{ orden: 'asc' }, { destino: 'asc' }] },
        proveedor: { include: { autenticacion: true } },
      },
    });
    if (!op) throw new IntegracionError('La operación no existe');
    const { proveedor: prov, ...operacion } = op;
    try {
      const r = await this.correr(prov, operacion, param);
      await this.bitacora(
        op.id,
        inicio,
        'ok',
        { httpStatus: r.httpStatus, registros: r.registros.length, omitidos: r.omitidos },
        { solicitadoPor },
      );
      return {
        leidos: r.leidos,
        registros: r.registros.length,
        omitidos: r.omitidos,
        campos: operacion.mapeos.map((m) => m.destino),
        httpStatus: r.httpStatus,
      };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.bitacora(
        op.id,
        inicio,
        'error',
        {
          httpStatus: error instanceof IntegracionError ? error.httpStatus : undefined,
          error: error.message,
        },
        { solicitadoPor },
      );
      if (error instanceof IntegracionError) throw error;
      throw new IntegracionError(error.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------

  /** @internal visible para el tipo de `ProveedorCargado`. */
  cargarProveedor(codigo: string) {
    return this.prisma.proveedor.findUnique({
      where: { codigo },
      include: { autenticacion: true },
    });
  }

  /** @internal visible para el tipo de `OperacionCargada`. */
  cargarOperacion(proveedorId: string, codigo: string) {
    return this.prisma.operacion.findFirst({
      where: { proveedorId, codigo, activa: true },
      include: { mapeos: { orderBy: [{ orden: 'asc' }, { destino: 'asc' }] } },
    });
  }

  private async correr(
    prov: ProveedorCargado,
    op: OperacionCargada,
    param: Record<string, unknown>,
  ) {
    const formato = FORMATOS[prov.formato];
    if (!formato)
      throw new IntegracionError(
        `El formato "${prov.formato}" de "${prov.codigo}" aún no está soportado`,
      );

    const pag = (op.paginacion ?? null) as {
      tamano: number;
      inicio?: number;
      campoDesde?: string;
      campoTamano?: string;
    } | null;
    const tamano = pag?.tamano ?? 0;
    let desde = pag?.inicio ?? 0;

    const registros: Record<string, unknown>[] = [];
    let leidos = 0;
    let omitidos = 0;
    let httpStatus = 200;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const ctx = this.contexto(prov, param, { desde, tamano });
      const { status, cuerpo } = await this.llamar(prov, op, ctx, pag);
      httpStatus = status;
      const filas = leerRuta(cuerpo, op.rutaResultados);
      if (!Array.isArray(filas)) {
        throw new IntegracionError(
          `${prov.codigo}.${op.codigo}: la respuesta no trae un arreglo en "${op.rutaResultados || '(raíz)'}"`,
        );
      }
      for (const fila of filas) {
        leidos++;
        const mapeada = aplicarMapeo(fila, op.mapeos);
        if (mapeada === null) omitidos++;
        else registros.push(mapeada);
      }
      if (!pag || filas.length < tamano) return { registros, leidos, omitidos, httpStatus };
      desde += tamano;
    }
    throw new IntegracionError(
      `${prov.codigo}.${op.codigo}: la paginación superó ${MAX_PAGINAS} páginas`,
    );
  }

  private contexto(
    prov: ProveedorCargado,
    param: Record<string, unknown>,
    pagina: { desde: number; tamano: number },
  ): ContextoPlantilla {
    const aut = this.autenticacion(prov);
    const secreto: Record<string, string> = {};
    for (const [logico, nombre] of Object.entries(aut.secretos)) {
      const v = this.secretos.resolver(nombre);
      if (v !== undefined) secreto[logico] = v;
    }
    return { param, var: (prov.variables ?? {}) as Record<string, unknown>, secreto, pagina };
  }

  private autenticacion(prov: ProveedorCargado): Config {
    const a = prov.autenticacion;
    return {
      tipo: a?.tipo ?? 'ninguna',
      config: (a?.config ?? {}) as Record<string, unknown>,
      secretos: (a?.secretos ?? {}) as Record<string, string>,
    };
  }

  /** Una llamada HTTP con autenticación, reintentos y, si el tercero rechaza el token, una renovación. */
  private async llamar(
    prov: ProveedorCargado,
    op: OperacionCargada,
    ctx: ContextoPlantilla,
    pag: { campoDesde?: string; campoTamano?: string } | null,
    renovado = false,
  ): Promise<{ status: number; cuerpo: unknown }> {
    const formato = FORMATOS[prov.formato];
    const aut = this.autenticacion(prov);

    const cabeceras: Record<string, string> = {
      accept: formato.contentType,
      ...(op.cabeceras ? (resolver(op.cabeceras, ctx) as Record<string, string>) : {}),
    };
    let cuerpo =
      op.cuerpo === null || op.cuerpo === undefined ? undefined : resolver(op.cuerpo, ctx);
    if (pag && cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo)) {
      const c = cuerpo as Record<string, unknown>;
      if (pag.campoDesde) c[pag.campoDesde] = ctx.pagina.desde;
      if (pag.campoTamano) c[pag.campoTamano] = ctx.pagina.tamano;
      cuerpo = c;
    }
    if (cuerpo !== undefined && op.metodo !== 'GET')
      cabeceras['content-type'] = formato.contentType;

    if (op.requiereAuth) {
      if (aut.tipo === 'bearer_login')
        cabeceras['authorization'] = `Bearer ${await this.token(prov, aut, ctx)}`;
      if (aut.tipo === 'api_key') {
        const nombre = String(aut.config['cabecera'] ?? '');
        const clave = ctx.secreto['clave'];
        if (!nombre || !clave)
          throw new IntegracionError(`${prov.codigo}: autenticación api_key incompleta`);
        cabeceras[nombre] = clave;
      }
    }

    const url = `${prov.baseUrl}${resolver(op.ruta, ctx) as string}`;
    const { status, texto } = await this.enviar(
      prov,
      op,
      url,
      op.metodo,
      cabeceras,
      cuerpo === undefined ? undefined : formato.serializar(cuerpo),
    );

    // Sin sesión válida el tercero contesta 401/403 o redirige al login (302): se renueva el token una vez.
    if (
      [401, 403, 302].includes(status) &&
      op.requiereAuth &&
      aut.tipo === 'bearer_login' &&
      !renovado
    ) {
      this.tokens.delete(prov.id);
      return this.llamar(prov, op, ctx, pag, true);
    }
    if (status !== 200) {
      throw new IntegracionError(
        `${prov.codigo}.${op.codigo}: el proveedor respondió ${status}${this.detalle(formato, texto)}`,
        status,
      );
    }
    try {
      return { status, cuerpo: formato.parsear(texto) };
    } catch {
      throw new IntegracionError(
        `${prov.codigo}.${op.codigo}: la respuesta no es ${prov.formato} válido`,
        status,
      );
    }
  }

  private async enviar(
    prov: ProveedorCargado,
    op: OperacionCargada,
    url: string,
    metodo: string,
    cabeceras: Record<string, string>,
    cuerpo?: string,
  ): Promise<{ status: number; texto: string }> {
    let ultimo: Error | undefined;
    for (let intento = 0; intento <= prov.reintentos; intento++) {
      if (intento > 0) await new Promise((r) => setTimeout(r, ESPERA_REINTENTO_MS * intento));
      try {
        const r = await fetch(url, {
          method: metodo,
          redirect: 'manual',
          signal: AbortSignal.timeout(prov.timeoutMs),
          headers: cabeceras,
          body: metodo === 'GET' ? undefined : cuerpo,
        });
        const texto = await r.text();
        if (r.status >= 500 && intento < prov.reintentos) {
          ultimo = new IntegracionError(`respondió ${r.status}`, r.status);
          continue;
        }
        return { status: r.status, texto };
      } catch (e) {
        // La URL puede llevar datos: solo se informa el tipo de error de red.
        ultimo = new IntegracionError(
          `${prov.codigo}.${op.codigo}: no se pudo contactar al proveedor (${(e as Error).name})`,
        );
      }
    }
    throw ultimo ?? new IntegracionError(`${prov.codigo}.${op.codigo}: falló la llamada`);
  }

  private async token(
    prov: ProveedorCargado,
    aut: Config,
    ctx: ContextoPlantilla,
  ): Promise<string> {
    const guardado = this.tokens.get(prov.id);
    if (guardado && guardado.expira > Date.now()) return guardado.valor;

    const codigoLogin = String(aut.config['operacion'] ?? '');
    const campo = String(aut.config['campoToken'] ?? 'token');
    const vida = Number(aut.config['vidaSegundos'] ?? 600);
    const login = await this.cargarOperacion(prov.id, codigoLogin);
    if (!codigoLogin || !login) {
      throw new IntegracionError(
        `${prov.codigo}: no tiene activa la operación de login "${codigoLogin}"`,
      );
    }
    const { cuerpo } = await this.llamar(
      prov,
      login,
      { ...ctx, pagina: { desde: 0, tamano: 0 } },
      null,
    );
    const valor = leerRuta(cuerpo, campo);
    if (typeof valor !== 'string' || !valor) {
      throw new IntegracionError(`${prov.codigo}: el login no devolvió un token`);
    }
    this.tokens.set(prov.id, { valor, expira: Date.now() + vida * 1000 });
    return valor;
  }

  /** Mensaje del tercero, solo si es texto corto y viene en un campo `mensaje` de un JSON. */
  private detalle(formato: { parsear(t: string): unknown }, texto: string): string {
    try {
      const m = (formato.parsear(texto) as { mensaje?: unknown })?.mensaje;
      return typeof m === 'string' ? `: ${m.slice(0, 200)}` : '';
    } catch {
      return '';
    }
  }

  private async bitacora(
    operacionId: string,
    inicio: number,
    estado: 'ok' | 'error',
    datos: { httpStatus?: number; registros?: number; omitidos?: number; error?: string },
    opciones: EjecutarOpciones,
  ): Promise<void> {
    try {
      await this.prisma.ejecucion.create({
        data: {
          id: uuidv7(),
          operacionId,
          duracionMs: Date.now() - inicio,
          estado,
          httpStatus: datos.httpStatus ?? null,
          registros: datos.registros ?? 0,
          omitidos: datos.omitidos ?? 0,
          error: datos.error?.slice(0, 500) ?? null,
          solicitadoPor: opciones.solicitadoPor ?? 'sistema',
        },
      });
    } catch (e) {
      // La bitácora es auxiliar: si falla no debe tumbar la integración.
      this.logger.warn(`No se pudo registrar la ejecución: ${(e as Error).message}`);
    }
  }
}

export { PlantillaError };
