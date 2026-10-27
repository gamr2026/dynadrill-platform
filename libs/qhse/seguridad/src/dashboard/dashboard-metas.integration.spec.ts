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

run('QHSE: metas del tablero HSE (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  const ruta = '/api/qhse/dashboard-metas';
  const tecnico = () =>
    t.token('tecnico_hse', TECNICO.nombre, [Permission.QHSE_GESTIONAR], TECNICO.id);
  const operador = () =>
    t.token('operador', OPERADOR.nombre, [Permission.QHSE_REPORTAR], OPERADOR.id);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3181');
    await sembrarMaestros(t.admin, MAESTROS);
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.kpi_meta WHERE created_by = $1', [TECNICO.id]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('exige el permiso general de QHSE', async () => {
    await t.http().get(ruta).set(operador()).expect(403);
    await t.http().patch(ruta).set(operador()).send({ dias_sin_lti: 30 }).expect(403);
  });

  it('una meta nueva reemplaza a la anterior y la historia se conserva', async () => {
    const primera = await t.http().patch(ruta).set(tecnico()).send({ dias_sin_lti: 30 }).expect(200);
    expect(primera.body['dias_sin_lti']).toBe(30);
    const segunda = await t
      .http()
      .patch(ruta)
      .set(tecnico())
      .send({ dias_sin_lti: 45, derrames_trimestre: 0 })
      .expect(200);
    expect(segunda.body).toMatchObject({ dias_sin_lti: 45, derrames_trimestre: 0 });
    expect((await t.http().get(ruta).set(tecnico()).expect(200)).body['dias_sin_lti']).toBe(45);
    const filas = await t.admin.query(
      `SELECT count(*)::int AS n FROM qhse.kpi_meta m JOIN qhse.kpi_indicador i ON i.id = m.indicador_id
        WHERE i.codigo = 'dias_sin_lti' AND m.created_by = $1`,
      [TECNICO.id],
    );
    expect(filas.rows[0].n).toBe(2);
  });

  it('rechaza indicadores desconocidos, valores no numéricos o negativos y cuerpos vacíos', async () => {
    await t.http().patch(ruta).set(tecnico()).send({ inventado: 1 }).expect(400);
    await t.http().patch(ruta).set(tecnico()).send({ dias_sin_lti: 'mucho' }).expect(400);
    await t.http().patch(ruta).set(tecnico()).send({ dias_sin_lti: -1 }).expect(400);
    await t.http().patch(ruta).set(tecnico()).send({}).expect(400);
  });
});
