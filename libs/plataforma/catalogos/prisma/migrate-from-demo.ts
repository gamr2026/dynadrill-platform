/**
 * Migra los catálogos del backend demo (SQLite) a `catalogos` (PostgreSQL). Idempotente.
 *   npm run db:migrate-demo:catalogos                       (usa DEMO_DB_PATH o la ruta por defecto)
 *   DEMO_DB_PATH=ruta/a/dynadrill.db npm run db:migrate-demo:catalogos
 *
 * - Cada fila conserva su id numérico en `legacy_id` (los módulos viejos la referencian por ese id).
 * - Se enlaza por `legacy_id` o, si no, por la clave natural (nombre, código, identificación...).
 * - Una fila ya existente NUNCA se sobrescribe: solo se completa su `legacy_id`.
 * - Orden por dependencias: bloques, campos, taladros, pozos, clientes, personas de contacto.
 * - Imprime un informe por catálogo con lo creado, lo enlazado y lo que no pudo resolver.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const bool = (v: unknown, porDefecto = true) =>
  v === null || v === undefined ? porDefecto : Number(v) === 1;
const num = (v: unknown) => Number(v);
const lote = <T>(items: T[], n = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

interface Informe {
  catalogo: string;
  enDemo: number;
  creados: number;
  enlazados: number;
  yaEnlazados: number;
  omitidos: string[];
  /** Filas que solo difieren en mayúsculas: se migran las dos y se reportan para limpieza. */
  posiblesDuplicados: string[];
}

async function main() {
  const dbPath = resolve(process.env['DEMO_DB_PATH'] ?? '../dynadrill-backend/prisma/dynadrill.db');
  if (!existsSync(dbPath)) throw new Error(`No existe la base de la demo: ${dbPath}`);
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL es obligatoria');

  const demo = new DatabaseSync(dbPath, { readOnly: true });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(url), max: 3 },
      { schema: 'catalogos' },
    ),
  });
  const filas = (tabla: string) =>
    demo.prepare(`SELECT * FROM ${tabla} ORDER BY id`).all() as Row[];
  const informes: Informe[] = [];

  /**
   * Núcleo común: carga las filas existentes, enlaza por `legacy_id` o por clave natural y crea las que
   * faltan en lotes. `existentes` devuelve las filas ya presentes con su legacyId y su clave natural.
   */
  async function migrar<TNueva extends { id: string; legacyId: number }>(opts: {
    catalogo: string;
    demoRows: Row[];
    existentes: () => Promise<Array<{ id: string; legacyId: number | null; clave: string }>>;
    claveDe: (r: Row) => string;
    nueva: (r: Row, id: string) => TNueva | string; // string = motivo de omisión
    crearMuchas: (data: TNueva[]) => Promise<unknown>;
    enlazar: (id: string, legacyId: number) => Promise<unknown>;
  }): Promise<Map<number, string>> {
    const inf: Informe = {
      catalogo: opts.catalogo,
      enDemo: opts.demoRows.length,
      creados: 0,
      enlazados: 0,
      yaEnlazados: 0,
      omitidos: [],
      posiblesDuplicados: [],
    };
    const existentes = await opts.existentes();
    const porLegacy = new Map(
      existentes.filter((e) => e.legacyId !== null).map((e) => [e.legacyId as number, e]),
    );
    // La clave se compara EXACTA, igual que la unicidad de la base de datos: migrar es copiar fielmente. Lo que
    // solo difiere en mayúsculas se migra y se reporta como posible duplicado (decisión de limpieza de datos).
    const porClave = new Map(existentes.map((e) => [e.clave, e]));
    const mapa = new Map<number, string>(); // id demo -> uuid nuevo
    const aCrear: TNueva[] = [];
    const clavesNuevas = new Set<string>();

    for (const r of opts.demoRows) {
      const legacyId = num(r['id']);
      const clave = opts.claveDe(r);
      const ya = porLegacy.get(legacyId);
      if (ya) {
        mapa.set(legacyId, ya.id);
        inf.yaEnlazados += 1;
        continue;
      }
      const mismaClave = porClave.get(clave);
      if (mismaClave) {
        // existe (p. ej. creado antes en el backend nuevo): solo se completa el enlace, sin tocar sus datos
        if (mismaClave.legacyId === null) {
          await opts.enlazar(mismaClave.id, legacyId);
          inf.enlazados += 1;
        } else {
          inf.omitidos.push(
            `${opts.claveDe(r)}: la clave ya la usa otra fila (id demo ${mismaClave.legacyId})`,
          );
        }
        mapa.set(legacyId, mismaClave.id);
        continue;
      }
      if (clavesNuevas.has(clave)) {
        inf.omitidos.push(`${opts.claveDe(r)}: clave repetida dentro de la propia demo`);
        continue;
      }
      const id = uuidv7();
      const nueva = opts.nueva(r, id);
      if (typeof nueva === 'string') {
        inf.omitidos.push(`${opts.claveDe(r)}: ${nueva}`);
        continue;
      }
      clavesNuevas.add(clave);
      mapa.set(legacyId, id);
      aCrear.push(nueva);
    }

    const grupos = new Map<string, string[]>();
    for (const r of opts.demoRows) {
      const k = opts.claveDe(r).toLowerCase();
      grupos.set(k, [...(grupos.get(k) ?? []), opts.claveDe(r)]);
    }
    for (const nombres of grupos.values()) {
      if (nombres.length > 1) inf.posiblesDuplicados.push(nombres.join(' / '));
    }

    for (const parte of lote(aCrear)) {
      await opts.crearMuchas(parte);
      inf.creados += parte.length;
    }
    informes.push(inf);
    return mapa;
  }

  try {
    // 1) Bloques
    const bloques = await migrar({
      catalogo: 'bloques',
      demoRows: filas('catalogo_bloques'),
      existentes: async () =>
        (await prisma.bloque.findMany()).map((b) => ({
          id: b.id,
          legacyId: b.legacyId,
          clave: b.nombre,
        })),
      claveDe: (r) => String(r['nombre']).trim(),
      nueva: (r, id) => ({ id, legacyId: num(r['id']), nombre: String(r['nombre']).trim() }),
      crearMuchas: (data) => prisma.bloque.createMany({ data }),
      enlazar: (id, legacyId) => prisma.bloque.update({ where: { id }, data: { legacyId } }),
    });

    // 2) Zonas (catálogo propio; en la demo era texto suelto del campo) y luego Campos
    const rowsCampos = filas('catalogo_campos');
    const zonasExistentes = await prisma.zona.findMany();
    const zonaPorNombre = new Map<string, string>(
      zonasExistentes.map((z) => [z.nombre.toUpperCase(), z.id] as [string, string]),
    );
    const zonasNuevas: Array<{ id: string; nombre: string }> = [];
    for (const r of rowsCampos) {
      const nombre = str(r['zona']);
      if (!nombre || zonaPorNombre.has(nombre.toUpperCase())) continue;
      const id = uuidv7();
      zonaPorNombre.set(nombre.toUpperCase(), id);
      zonasNuevas.push({ id, nombre });
    }
    if (zonasNuevas.length) await prisma.zona.createMany({ data: zonasNuevas });
    const campos = await migrar({
      catalogo: 'campos',
      demoRows: rowsCampos,
      existentes: async () =>
        (await prisma.campo.findMany()).map((c) => ({
          id: c.id,
          legacyId: c.legacyId,
          clave: c.nombre,
        })),
      claveDe: (r) => String(r['nombre']).trim(),
      nueva: (r, id) => ({
        id,
        legacyId: num(r['id']),
        nombre: String(r['nombre']).trim(),
        zonaId: zonaPorNombre.get(str(r['zona'])?.toUpperCase() ?? '') ?? null,
      }),
      crearMuchas: (data) => prisma.campo.createMany({ data }),
      enlazar: (id, legacyId) => prisma.campo.update({ where: { id }, data: { legacyId } }),
    });

    // 3) Taladros
    await migrar({
      catalogo: 'taladros',
      demoRows: filas('catalogo_taladros'),
      existentes: async () =>
        (await prisma.taladro.findMany()).map((t) => ({
          id: t.id,
          legacyId: t.legacyId,
          clave: t.nombre,
        })),
      claveDe: (r) => String(r['nombre']).trim(),
      nueva: (r, id) => ({
        id,
        legacyId: num(r['id']),
        nombre: String(r['nombre']).trim(),
        rigContractual: str(r['rigContractual']),
        habilitado: bool(r['habilitado']),
      }),
      crearMuchas: (data) => prisma.taladro.createMany({ data }),
      enlazar: (id, legacyId) => prisma.taladro.update({ where: { id }, data: { legacyId } }),
    });

    // 4) Pozos: referencian campo y bloque, que ya están migrados
    await migrar({
      catalogo: 'pozos',
      demoRows: filas('catalogo_pozos'),
      existentes: async () =>
        (await prisma.pozo.findMany()).map((p) => ({
          id: p.id,
          legacyId: p.legacyId,
          clave: p.codigo,
        })),
      claveDe: (r) => String(r['codigo']).trim(),
      nueva: (r, id) => {
        const campoId = campos.get(num(r['campoId']));
        const bloqueId = bloques.get(num(r['bloqueId']));
        if (!campoId) return `su campo (id demo ${String(r['campoId'])}) no se pudo resolver`;
        if (!bloqueId) return `su bloque (id demo ${String(r['bloqueId'])}) no se pudo resolver`;
        return {
          id,
          legacyId: num(r['id']),
          codigo: String(r['codigo']).trim(),
          nombreCompleto: String(r['nombreCompleto']),
          campoId,
          bloqueId,
          habilitado: bool(r['habilitado']),
        };
      },
      crearMuchas: (data) => prisma.pozo.createMany({ data }),
      enlazar: (id, legacyId) => prisma.pozo.update({ where: { id }, data: { legacyId } }),
    });

    // 5) Clientes
    await migrar({
      catalogo: 'clientes',
      demoRows: filas('clientes_catalogo'),
      existentes: async () =>
        (await prisma.cliente.findMany()).map((c) => ({
          id: c.id,
          legacyId: c.legacyId,
          clave: c.identificacion,
        })),
      claveDe: (r) => String(r['identificacion']).trim(),
      nueva: (r, id) => ({
        id,
        legacyId: num(r['id']),
        tipoIdentificacion: String(r['tipoIdentificacion']),
        identificacion: String(r['identificacion']).trim(),
        nombreComercial: String(r['nombreComercial']),
        nombreFiscal: str(r['nombreFiscal']),
        activo: bool(r['activo']),
      }),
      crearMuchas: (data) => prisma.cliente.createMany({ data }),
      enlazar: (id, legacyId) => prisma.cliente.update({ where: { id }, data: { legacyId } }),
    });

    // 6) Personas de contacto: la clave natural es (tipo, nombre)
    await migrar({
      catalogo: 'personas de contacto',
      demoRows: filas('personas_contacto'),
      existentes: async () =>
        (await prisma.personaContacto.findMany()).map((p) => ({
          id: p.id,
          legacyId: p.legacyId,
          clave: `${p.tipo}|${p.nombre}`,
        })),
      claveDe: (r) => `${String(r['tipo'])}|${String(r['nombre']).trim()}`,
      nueva: (r, id) => ({
        id,
        legacyId: num(r['id']),
        tipo: String(r['tipo']),
        nombre: String(r['nombre']).trim(),
        cedula: str(r['cedula']),
        activo: bool(r['activo']),
      }),
      crearMuchas: (data) => prisma.personaContacto.createMany({ data }),
      enlazar: (id, legacyId) =>
        prisma.personaContacto.update({ where: { id }, data: { legacyId } }),
    });

    console.log(`Base de la demo: ${dbPath}\n`);
    for (const i of informes) {
      console.log(
        `${i.catalogo.padEnd(22)} demo=${String(i.enDemo).padStart(4)}  creados=${String(i.creados).padStart(4)}  enlazados=${String(i.enlazados).padStart(3)}  ya migrados=${String(i.yaEnlazados).padStart(4)}  omitidos=${i.omitidos.length}`,
      );
      for (const d of i.posiblesDuplicados)
        console.log(`    - posible duplicado (solo difieren en mayúsculas): ${d}`);
      for (const o of i.omitidos.slice(0, 20)) console.log(`    - omitido: ${o}`);
      if (i.omitidos.length > 20) console.log(`    ... y ${i.omitidos.length - 20} más`);
    }
  } finally {
    demo.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
