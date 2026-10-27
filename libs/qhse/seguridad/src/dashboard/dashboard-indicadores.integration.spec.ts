import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

run('QHSE: indicadores del tablero HSE (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  const ruta = '/api/qhse/dashboard/indicadores';
  const tecnico = () => t.token('tecnico_hse', TECNICO.nombre, [Permission.QHSE_GESTIONAR], TECNICO.id);
  const operador = () => t.token('operador', OPERADOR.nombre, [Permission.QHSE_REPORTAR], OPERADOR.id);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3182');
    await sembrarMaestros(t.admin, MAESTROS);
  });

  afterAll(async () => {
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('exige el permiso general de QHSE', async () => {
    await t.http().get(ruta).set(operador()).expect(403);
  });

  it('devuelve los indicadores calculables, el estado de EPI y PTW y lo que pone el semáforo en rojo', async () => {
    const r = (await t.http().get(ruta).set(tecnico()).expect(200)).body;
    // los once calculables; los que no se pueden calcular (TRIR, LTIR, participación en STOP, capacitados, IPERC por trabajo) no vienen
    expect(Object.keys(r.valores).sort()).toEqual(
      [
        'dias_sin_lti',
        'derrames_trimestre',
        'derrames_volumen_barriles_year',
        'desechos_peligrosos_kg_mes',
        'inspecciones_vigentes_pct',
        'ptw_cerrados_pct',
        'ptw_tiempo_prom_dias',
        'ratio_near_miss',
        'reciclaje_pct',
        'stop_per_capita',
        'swa_eventos',
      ].sort(),
    );
    const catalogo = (await t.admin.query('SELECT codigo FROM qhse.kpi_indicador WHERE disponible')).rows.map(
      (f: { codigo: string }) => f.codigo,
    );
    expect(Object.keys(r.valores).sort()).toEqual(catalogo.sort()); // el catálogo y el cálculo dicen lo mismo
    const swa = (await t.admin.query('SELECT count(*)::int AS n FROM qhse.swa')).rows[0].n;
    expect(r.valores.swa_eventos).toBe(swa);
    const stop = (await t.admin.query('SELECT count(*)::int AS n FROM qhse.stop_tarjeta')).rows[0].n;
    const activos = (await t.admin.query('SELECT count(*)::int AS n FROM identidad.usuario WHERE activo')).rows[0].n;
    expect(r.valores.stop_per_capita).toBe(activos ? Math.round((stop / activos) * 100) / 100 : null);

    expect(r.epi.porEstado.map((e: { estado: string }) => e.estado)).toEqual([
      'solicitado',
      'aprobado',
      'despachado',
      'rechazado',
    ]);
    expect(r.epi.total).toBe(r.epi.porEstado.reduce((a: number, e: { cantidad: number }) => a + e.cantidad, 0));
    expect(r.ptw.porFase.map((f: { fase: string }) => f.fase)).toEqual(['gabinete', 'formalizacion', 'aprobacion']);
    expect(r.ptw.abiertos).toBe(r.ptw.porFase.reduce((a: number, f: { cantidad: number }) => a + f.cantidad, 0));
    expect(Array.isArray(r.incumplimientoLegal)).toBe(true);
  });
});
