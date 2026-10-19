/**
 * Extrae la matriz IPERC real (DYN-SGI-RE-087, hoja «GTC 45 - Julio 2026») a `iperc-087.json`, ya normalizada: la misma actividad escrita de
 * varias formas (MANTENIMIENTO/Mantenimiento, «Fisíco»/«Físico», «Base Coca-Campo»/«Base Coca - Campo»...) queda con un solo nombre.
 *
 *   node libs/qhse/seguridad/prisma/data/extraer-iperc.cjs <ruta del xlsx> <ruta de la carpeta node_modules con exceljs>
 *
 * Se corre una sola vez cuando cambia el Excel (el repositorio no depende de exceljs); el JSON resultante es lo que carga `npm run
 * db:cargar:iperc`. Columnas del formato (fila 20 en adelante): 1 proceso, 2 zona, 3 actividad, 4 tarea, 5 rutinaria, 6 área o puesto,
 * 7 cargos expuestos, 8 peligro, 9 clasificación, 10 fuente de riesgo, 11 generado en, 12 efectos posibles, 13-15 controles existentes
 * (fuente, medio, individuo), 16-17 y 20 valoración inicial (ND, NE, NC), 24 expuestos, 25 peor consecuencia, 26 requisito legal, 27-31
 * medidas de intervención (eliminación, sustitución, ingeniería, administrativo, EPP), 32 seguimiento, 33-34 y 37 valoración residual,
 * 40-44 controles residuales y 45 seguimiento residual.
 */
const fs = require('fs');
const path = require('path');

const [, , xlsx, modulos] = process.argv;
if (!xlsx || !modulos) {
  console.error('Uso: node extraer-iperc.cjs <xlsx> <node_modules con exceljs>');
  process.exit(1);
}
const ExcelJS = require(path.join(modulos, 'exceljs'));

const sinAcentos = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = (t) => sinAcentos(t).toLowerCase().replace(/\s+/g, ' ').trim();
const limpio = (t) => t.replace(/\s+/g, ' ').trim();

const PROCESOS = {
  operaciones: 'Operaciones',
  mantenimiento: 'Mantenimiento',
  laboratorio: 'Laboratorio',
  'direccion general': 'Dirección General',
  'compras y logistica': 'Compras y Logística',
  'administrativo financiero': 'Administrativo Financiero',
  administrativo: 'Administrativo',
  'gestion integral': 'Gestión Integral',
  'ingenieria y ventas': 'Ingeniería y Ventas',
  'talento humano': 'Talento Humano',
};
const CLASIFICACIONES = {
  fisico: 'Físico',
  mecanico: 'Mecánico',
  quimico: 'Químico',
  biologico: 'Biológico',
  ergonomico: 'Ergonómico',
  psicosocial: 'Psicosocial',
  'condiciones de seguridad': 'Condiciones de seguridad',
  locativos: 'Condiciones de seguridad',
  'fenomenos naturales': 'Fenómenos naturales',
};
const TIPOS_CONTROL = ['eliminacion', 'sustitucion', 'ingenieria', 'administrativo', 'epp'];

const celda = (ws, r, c) => {
  let v = ws.getRow(r).getCell(c).value;
  if (v && typeof v === 'object')
    v = v.richText ? v.richText.map((t) => t.text).join('') : (v.result ?? v.text ?? '');
  return v == null ? '' : limpio(String(v));
};
const entero = (t) => {
  const n = Number(String(t).replace(',', '.'));
  return Number.isFinite(n) && t !== '' ? Math.round(n) : null;
};
const si = (t) => /^s[ií]/i.test(t);
const valoracion = (nd, ne, nc) =>
  nd !== null && ne !== null && nc !== null ? { nd, ne, nc } : null;

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.getWorksheet('GTC 45 - Julio 2026');
  if (!ws) throw new Error('No encuentro la hoja «GTC 45 - Julio 2026»');
  const actividades = new Map();
  let filas = 0;
  for (let r = 20; r <= ws.rowCount; r++) {
    const act = celda(ws, r, 3);
    const peligro = celda(ws, r, 8);
    if (!act && !peligro) continue;
    filas++;
    const procesoCrudo = celda(ws, r, 1).replace(/[.\s]+$/, '');
    const proceso = PROCESOS[clave(procesoCrudo)] ?? procesoCrudo;
    const zona = celda(ws, r, 2).replace(/\s*-\s*/g, ' - ');
    const llave = [clave(proceso), clave(zona), clave(act)].join('|');
    if (!actividades.has(llave))
      actividades.set(llave, { proceso, zona, actividad: act, tareas: new Map() });
    const a = actividades.get(llave);
    const tareaTxt = celda(ws, r, 4);
    if (!a.tareas.has(clave(tareaTxt))) {
      a.tareas.set(clave(tareaTxt), {
        descripcion: tareaTxt,
        rutinaria: si(celda(ws, r, 5)),
        areaPuesto: celda(ws, r, 6) || null,
        cargos: celda(ws, r, 7)
          .split(/[,;\n]/)
          .map(limpio)
          .filter(Boolean),
        peligros: [],
      });
    }
    const clasifCruda = celda(ws, r, 9)
      .replace(/\(.*?\)/g, '')
      .trim();
    const controles = [];
    TIPOS_CONTROL.forEach((tipo, i) => {
      const prop = celda(ws, r, 27 + i);
      if (prop) controles.push({ momento: 'propuesto', tipo, descripcion: prop });
      const res = celda(ws, r, 40 + i);
      if (res) controles.push({ momento: 'residual', tipo, descripcion: res });
    });
    a.tareas.get(clave(tareaTxt)).peligros.push({
      descripcion: peligro,
      clasificacion: CLASIFICACIONES[clave(clasifCruda)] ?? clasifCruda,
      fuenteRiesgo: celda(ws, r, 10) || null,
      generadoEn: celda(ws, r, 11) || null,
      efectosPosibles: celda(ws, r, 12) || null,
      controlExistenteFuente: celda(ws, r, 13) || null,
      controlExistenteMedio: celda(ws, r, 14) || null,
      controlExistenteIndividuo: celda(ws, r, 15) || null,
      numeroExpuestos: entero(celda(ws, r, 24)),
      peorConsecuencia: celda(ws, r, 25) || null,
      requisitoLegal: si(celda(ws, r, 26)),
      seguimiento: celda(ws, r, 32) || null,
      seguimientoResidual: celda(ws, r, 45) || null,
      inicial: valoracion(
        entero(celda(ws, r, 16)),
        entero(celda(ws, r, 17)),
        entero(celda(ws, r, 20)),
      ),
      residual: valoracion(
        entero(celda(ws, r, 33)),
        entero(celda(ws, r, 34)),
        entero(celda(ws, r, 37)),
      ),
      controles,
    });
  }
  const salida = [...actividades.values()].map((a) => ({ ...a, tareas: [...a.tareas.values()] }));
  const destino = path.join(__dirname, 'iperc-087.json');
  fs.writeFileSync(destino, JSON.stringify(salida, null, 1) + '\n');
  const peligros = salida.reduce(
    (n, a) => n + a.tareas.reduce((m, t) => m + t.peligros.length, 0),
    0,
  );
  console.log(
    `${filas} filas → ${salida.length} actividades, ${salida.reduce((n, a) => n + a.tareas.length, 0)} tareas, ${peligros} peligros: ${destino}`,
  );
})();
