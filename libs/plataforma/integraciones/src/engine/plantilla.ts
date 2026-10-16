/** Datos que las plantillas pueden leer. `secreto` ya viene resuelto (valores reales); nunca se registra. */
export interface ContextoPlantilla {
  param: Record<string, unknown>;
  var: Record<string, unknown>;
  secreto: Record<string, string>;
  pagina: { desde: number; tamano: number };
}

export class PlantillaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlantillaError';
  }
}

const MARCADOR = /\{\{\s*([a-z]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
const MARCADOR_UNICO = /^\{\{\s*([a-z]+)\.([A-Za-z0-9_]+)\s*\}\}$/;
const ESPACIOS = ['param', 'var', 'secreto', 'pagina'] as const;

function valorDe(ctx: ContextoPlantilla, espacio: string, nombre: string): unknown {
  if (!(ESPACIOS as readonly string[]).includes(espacio)) {
    throw new PlantillaError(`Marcador desconocido: {{${espacio}.${nombre}}}`);
  }
  const fuente = ctx[espacio as (typeof ESPACIOS)[number]] as Record<string, unknown>;
  const v = fuente[nombre];
  if (v === undefined || v === null) {
    // No se imprime el valor ni siquiera el nombre de un secreto faltante más allá de su alias lógico.
    throw new PlantillaError(`Falta el valor de {{${espacio}.${nombre}}}`);
  }
  return v;
}

/**
 * Sustituye los marcadores `{{espacio.nombre}}` en un texto, una estructura JSON o un arreglo. Un valor que es
 * exactamente un marcador conserva su tipo (número, booleano, objeto); dentro de un texto más largo se vuelve texto.
 */
export function resolver(plantilla: unknown, ctx: ContextoPlantilla): unknown {
  if (typeof plantilla === 'string') {
    const unico = MARCADOR_UNICO.exec(plantilla);
    if (unico) return valorDe(ctx, unico[1], unico[2]);
    return plantilla.replace(MARCADOR, (_m, espacio: string, nombre: string) =>
      String(valorDe(ctx, espacio, nombre)),
    );
  }
  if (Array.isArray(plantilla)) return plantilla.map((x) => resolver(x, ctx));
  if (plantilla !== null && typeof plantilla === 'object') {
    return Object.fromEntries(
      Object.entries(plantilla as Record<string, unknown>).map(([k, v]) => [k, resolver(v, ctx)]),
    );
  }
  return plantilla;
}

/** Nombres de secretos lógicos que usa una plantilla (para validar antes de activarla). */
export function secretosUsados(plantilla: unknown): string[] {
  const usados = new Set<string>();
  const recorrer = (x: unknown): void => {
    if (typeof x === 'string') {
      for (const m of x.matchAll(MARCADOR)) if (m[1] === 'secreto') usados.add(m[2]);
    } else if (Array.isArray(x)) x.forEach(recorrer);
    else if (x && typeof x === 'object') Object.values(x).forEach(recorrer);
  };
  recorrer(plantilla);
  return [...usados];
}

/** Marcadores con un espacio que no existe; vacío si la plantilla es válida. */
export function marcadoresInvalidos(plantilla: unknown): string[] {
  const malos = new Set<string>();
  const recorrer = (x: unknown): void => {
    if (typeof x === 'string') {
      for (const m of x.matchAll(MARCADOR)) {
        if (!(ESPACIOS as readonly string[]).includes(m[1])) malos.add(m[0]);
      }
    } else if (Array.isArray(x)) x.forEach(recorrer);
    else if (x && typeof x === 'object') Object.values(x).forEach(recorrer);
  };
  recorrer(plantilla);
  return [...malos];
}
