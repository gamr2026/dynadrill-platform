/**
 * Carga del stock real por bodega y de los costos de AS2, desde `prisma/data/stock-as2.json` (reporte «Stock» de AS2 al
 * 17/10/2026, agrupado por bodega) y `prisma/data/costos-as2.json` (último costo de ingreso del kardex de AS2). Ver
 * `prisma/data/README.md`.
 *   npm run db:cargar:stock
 * Idempotente. El reporte de AS2 manda: para cada artículo y bodega que trae, deja el saldo igual al del reporte con UN movimiento:
 *   - sin movimientos en esa bodega → «Saldo inicial»;
 *   - con movimientos y distinto → ajuste («sobrante» o «faltante»), porque el kardex es inmutable (no se borra ni se edita nada);
 *   - lo que el portal tenía en una bodega del reporte y el reporte ya no lista (AS2 solo lista saldos positivos) → ajuste a cero.
 * También corrige la unidad de stock de cada artículo (el export de la demo traía todo en «Unidad») y pone el costo unitario a los
 * artículos que no lo tienen.
 *
 * Variables: DATABASE_URL (usuario app_operaciones). Opcional: INVENTARIO_CARGA_USUARIO_ID (por defecto, un Superadmin).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarCatalogos } from '../src/catalog/sembrar-catalogos';
import { PrismaClient } from '../src/generated/client';
import { registrarEnKardex, saldosPorBodega } from '../src/services/kardex';

loadDotenv('apps/operaciones/.env', '.env');

interface RenglonStock {
  bodega: string;
  codigo: string;
  codigoAs2: string;
  unidad: string;
  saldo: number;
}
interface ArchivoStock {
  fecha: string;
  stock: RenglonStock[];
}
interface ArchivoCostos {
  costos: Array<{ codigo: string; costoUnitario: number }>;
}

const leer = <T>(archivo: string): T =>
  JSON.parse(readFileSync(join(__dirname, 'data', archivo), 'utf8')) as T;

const OBSERVACION = (fecha: string) =>
  `Saldo según el reporte de stock de AS2 al ${fecha.split('-').reverse().join('/')}`;

export interface ResumenStock {
  saldosIniciales: number;
  sobrantes: number;
  faltantes: number;
  sinCambio: number;
  aCero: number;
  unidadesCorregidas: number;
  costos: number;
}

export async function cargarStockAs2(
  prisma: PrismaClient,
  opciones: { responsableId?: string } = {},
): Promise<ResumenStock> {
  await sembrarCatalogos(prisma);
  const stock = leer<ArchivoStock>('stock-as2.json');
  const costos = leer<ArchivoCostos>('costos-as2.json');
  const fecha = new Date(`${stock.fecha}T12:00:00.000Z`);
  const observacion = OBSERVACION(stock.fecha);

  const responsable = opciones.responsableId
    ? await prisma.idUsuario.findUnique({ where: { id: opciones.responsableId } })
    : await prisma.idUsuario.findFirst({
        where: { rol: { codigo: 'superadmin' } },
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
      });
  if (!responsable)
    throw new Error('No hay una cuenta responsable para los movimientos (Superadmin)');

  const motivo = async (nombre: string) =>
    (await prisma.motivoMovimiento.findUniqueOrThrow({ where: { nombre } })).id;
  const motivoInicial = await motivo('Saldo inicial');
  const motivoSobrante = await motivo('Ajuste por conteo físico (sobrante)');
  const motivoFaltante = await motivo('Ajuste por conteo físico (faltante)');

  const unidades = new Map((await prisma.unidadStock.findMany()).map((u) => [u.nombre, u.id]));
  const bodegas = new Map((await prisma.catBodega.findMany()).map((b) => [b.nombre, b.id]));
  const articulos = new Map(
    (
      await prisma.articulo.findMany({ select: { id: true, codigo: true, unidadStockId: true } })
    ).map((a) => [a.codigo.toUpperCase(), a]),
  );

  const r: ResumenStock = {
    saldosIniciales: 0,
    sobrantes: 0,
    faltantes: 0,
    sinCambio: 0,
    aCero: 0,
    unidadesCorregidas: 0,
    costos: 0,
  };

  const bodegasDelReporte = new Set(stock.stock.map((s) => s.bodega));
  const delReporte = new Set<string>();

  // 1. saldo y unidad por artículo y bodega
  for (const s of stock.stock) {
    const a = articulos.get(s.codigo.toUpperCase());
    const bodegaId = bodegas.get(s.bodega);
    if (!a || !bodegaId) throw new Error(`Falta el artículo ${s.codigo} o la bodega ${s.bodega}`);
    delReporte.add(`${bodegaId}|${a.id}`);
    const unidadId = unidades.get(s.unidad);
    if (!unidadId) throw new Error(`La unidad de stock «${s.unidad}» no existe`);
    await prisma.$transaction(async (tx) => {
      if (a.unidadStockId !== unidadId) {
        await tx.articulo.update({ where: { id: a.id }, data: { unidadStockId: unidadId } });
        a.unidadStockId = unidadId;
        r.unidadesCorregidas++;
      }
      const saldos = await saldosPorBodega(tx, a.id);
      const actual = saldos.find((x) => x.bodegaId === bodegaId);
      const diferencia = Math.round((s.saldo - (actual?.saldo ?? 0)) * 1000) / 1000;
      if (diferencia === 0) {
        r.sinCambio++;
        return;
      }
      const entrada = {
        articuloId: a.id,
        bodegaId,
        cantidad: Math.abs(diferencia),
        responsableId: responsable.id,
        fecha,
        observacion,
      };
      if (!actual) {
        await registrarEnKardex(tx, { ...entrada, motivoId: motivoInicial });
        r.saldosIniciales++;
      } else if (diferencia > 0) {
        await registrarEnKardex(tx, { ...entrada, motivoId: motivoSobrante });
        r.sobrantes++;
      } else {
        await registrarEnKardex(tx, { ...entrada, motivoId: motivoFaltante });
        r.faltantes++;
      }
    });
  }

  // 2. lo que el portal tiene en una bodega del reporte y el reporte ya no lista: a cero
  const idsBodegasReporte = [...bodegasDelReporte].map((n) => bodegas.get(n) as string);
  const conSaldo = await prisma.$queryRaw<Array<{ articulo_id: string; bodega_id: string }>>`
    SELECT articulo_id, bodega_id FROM (
      SELECT DISTINCT ON (articulo_id, bodega_id) articulo_id, bodega_id, saldo_resultante
        FROM inventario.movimiento
       ORDER BY articulo_id, bodega_id, secuencia DESC) u
     WHERE saldo_resultante > 0 AND bodega_id = ANY(${idsBodegasReporte}::uuid[])`;
  for (const f of conSaldo) {
    if (delReporte.has(`${f.bodega_id}|${f.articulo_id}`)) continue;
    await prisma.$transaction(async (tx) => {
      const actual = (await saldosPorBodega(tx, f.articulo_id)).find(
        (x) => x.bodegaId === f.bodega_id,
      );
      if (!actual || actual.saldo <= 0) return;
      await registrarEnKardex(tx, {
        articuloId: f.articulo_id,
        bodegaId: f.bodega_id,
        motivoId: motivoFaltante,
        cantidad: actual.saldo,
        responsableId: responsable.id,
        fecha,
        observacion: `${observacion}: ya no figura con saldo`,
      });
      r.aCero++;
    });
  }

  // 3. costo unitario: solo a los artículos que no lo tienen (no se pisa un costo ya cargado)
  for (const c of costos.costos) {
    const a = articulos.get(c.codigo.toUpperCase());
    if (!a) continue;
    const n = await prisma.articulo.updateMany({
      where: { id: a.id, costoUnitario: null },
      data: { costoUnitario: c.costoUnitario },
    });
    r.costos += n.count;
  }
  return r;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'inventario' },
    ),
  });
  try {
    const r = await cargarStockAs2(prisma, {
      responsableId: process.env['INVENTARIO_CARGA_USUARIO_ID'],
    });
    console.log(
      `Stock de AS2: ${r.saldosIniciales} saldos iniciales, ${r.sobrantes} ajustes por sobrante, ${r.faltantes} por faltante, ` +
        `${r.aCero} llevados a cero, ${r.sinCambio} sin cambio, ${r.unidadesCorregidas} unidades corregidas, ${r.costos} costos nuevos`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
