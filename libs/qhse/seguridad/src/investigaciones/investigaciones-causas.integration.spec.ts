/**
 * Integración real de QHSE: investigación de incidentes (rebanada 3: análisis de causas), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest investigaciones-causas   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const MAESTROS: MaestrosDePrueba = { usuarios: [{ ...TECNICO, rol: 'tecnico_hse' }] };

run('QHSE: investigación de incidentes, análisis de causas (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  let nearMiss = '';
  let categorias: Record<string, string> = {};
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () => t.token('tecnico_hse', TECNICO.nombre, [P.INVESTIGACIONES_VER], TECNICO.id);
  const abierta = async () => {
    const r = await t
      .http()
      .post('/api/qhse/investigaciones')
      .set(gestor())
      .send({
        resultadoId: nearMiss,
        descripcionEvento: 'Caída de una herramienta desde la mesa de trabajo',
        fechaIncidente: new Date(Date.now() - 3 * H).toISOString(),
        ubicacion: 'Locación 9',
      });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const guardar = (
    id: string,
    seccion: string,
    cuerpo: Record<string, unknown>,
    quien = gestor(),
  ) => t.http().put(`/api/qhse/investigaciones/${id}/${seccion}`).set(quien).send(cuerpo);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3186');
    await sembrarMaestros(t.admin, MAESTROS);
    const res = await t.http().get('/api/qhse/investigaciones/resultados').set(soloVer());
    nearMiss = res.body.find((x: { codigo: string }) => x.codigo === 'near_miss').id;
    const cat = await t.http().get('/api/qhse/investigaciones/categorias-ishikawa').set(soloVer());
    categorias = Object.fromEntries(
      cat.body.map((c: { codigo: string; id: string }) => [c.codigo, c.id]),
    );
  });

  afterAll(async () => {
    for (const tabla of [
      'investigacion_porque',
      'investigacion_ishikawa_causa',
      'investigacion_causa',
    ])
      await sql(`DELETE FROM qhse.${tabla} WHERE created_by = $1`, [TECNICO.id]);
    await sql('DELETE FROM qhse.investigacion_historial WHERE actor_id = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.investigacion WHERE created_by = $1', [TECNICO.id]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.investigacion.%' AND datos->'actor'->>'userId' = $1",
      [TECNICO.id],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('el catálogo de Ishikawa trae las 6 M en orden', () => {
    expect(Object.keys(categorias).sort()).toEqual(
      ['mano_de_obra', 'maquina', 'material', 'medicion', 'medioambiente', 'metodo'].sort(),
    );
  });

  describe('5 Porqués', () => {
    it('guarda un nivel por fila, en orden, y reemplaza la lista completa al guardar de nuevo', async () => {
      const id = await abierta();
      const cinco = [1, 2, 3, 4, 5].map((n) => ({
        pregunta: `¿Por qué ${n}?`,
        respuesta: `Porque ${n}`,
      }));
      const r = await guardar(id, 'porques', { porques: cinco });
      expect(r.status).toBe(200);
      expect(r.body.porques.map((p: { orden: number }) => p.orden)).toEqual([1, 2, 3, 4, 5]);
      const menos = await guardar(id, 'porques', { porques: cinco.slice(0, 2) });
      expect(menos.body.porques).toHaveLength(2);
      expect(
        (
          await sql(
            'SELECT count(*)::int n FROM qhse.investigacion_porque WHERE investigacion_id = $1',
            [id],
          )
        ).rows[0].n,
      ).toBe(2);
    });

    it('rechaza niveles sin pregunta o respuesta, más de 10 niveles y a quien solo ve', async () => {
      const id = await abierta();
      expect(
        (await guardar(id, 'porques', { porques: [{ pregunta: '¿Por qué?', respuesta: '  ' }] }))
          .body.message,
      ).toMatch(/pregunta y su respuesta/);
      const once = Array.from({ length: 11 }, (_, n) => ({
        pregunta: `p${n}`,
        respuesta: `r${n}`,
      }));
      expect((await guardar(id, 'porques', { porques: once })).status).toBe(400);
      expect((await guardar(id, 'porques', { porques: [] }, soloVer())).status).toBe(403);
    });
  });

  describe('Ishikawa', () => {
    it('guarda varias causas por categoría, cada una en su fila, y las devuelve con el nombre de la categoría', async () => {
      const id = await abierta();
      const r = await guardar(id, 'ishikawa', {
        causas: [
          { categoriaId: categorias['mano_de_obra'], descripcion: 'Falta de capacitación' },
          { categoriaId: categorias['mano_de_obra'], descripcion: 'Fatiga' },
          { categoriaId: categorias['metodo'], descripcion: 'Procedimiento desactualizado' },
        ],
      });
      expect(r.status).toBe(200);
      expect(r.body.ishikawa).toEqual([
        expect.objectContaining({
          orden: 1,
          categoria: 'Mano de obra',
          descripcion: 'Falta de capacitación',
        }),
        expect.objectContaining({ orden: 2, categoria: 'Mano de obra', descripcion: 'Fatiga' }),
        expect.objectContaining({ orden: 3, categoria: 'Método' }),
      ]);
    });

    it('rechaza una categoría inexistente o una causa vacía', async () => {
      const id = await abierta();
      expect(
        (await guardar(id, 'ishikawa', { causas: [{ categoriaId: uuidv7(), descripcion: 'x' }] }))
          .body.message,
      ).toMatch(/categorías de Ishikawa no existe/);
      expect(
        (
          await guardar(id, 'ishikawa', {
            causas: [{ categoriaId: categorias['metodo'], descripcion: ' ' }],
          })
        ).body.message,
      ).toMatch(/descripción/);
      expect(
        (await guardar(id, 'ishikawa', { causas: [{ categoriaId: 'no-uuid', descripcion: 'x' }] }))
          .status,
      ).toBe(400);
    });
  });

  describe('causas del formato', () => {
    it('guarda varias causas de cada tipo, numeradas por tipo', async () => {
      const id = await abierta();
      const r = await guardar(id, 'causas', {
        causas: [
          { tipo: 'acto_inseguro', descripcion: 'No usó guantes' },
          { tipo: 'condicion_insegura', descripcion: 'Piso resbaloso' },
          { tipo: 'acto_inseguro', descripcion: 'Omitió el bloqueo' },
          { tipo: 'fuente_gestion', descripcion: 'No hay inspección programada' },
        ],
      });
      expect(r.status).toBe(200);
      const actos = r.body.causas.filter((c: { tipo: string }) => c.tipo === 'acto_inseguro');
      expect(
        actos.map((c: { orden: number; descripcion: string }) => [c.orden, c.descripcion]),
      ).toEqual([
        [1, 'No usó guantes'],
        [2, 'Omitió el bloqueo'],
      ]);
      expect(r.body.causas).toHaveLength(4);
    });

    it('rechaza un tipo inventado o una causa vacía', async () => {
      const id = await abierta();
      expect(
        (await guardar(id, 'causas', { causas: [{ tipo: 'otro', descripcion: 'x' }] })).status,
      ).toBe(400);
      expect(
        (await guardar(id, 'causas', { causas: [{ tipo: 'factor_personal', descripcion: '' }] }))
          .status,
      ).toBe(400);
    });

    it('una investigación inexistente responde 404', async () => {
      expect((await guardar(uuidv7(), 'causas', { causas: [] })).status).toBe(404);
    });
  });

  describe('reglas de la base', () => {
    it('orden y texto de cada fila son válidos; no hay dos filas con el mismo orden', async () => {
      const id = await abierta();
      const porque = (orden: number, pregunta = 'p', respuesta = 'r') =>
        sql(
          'INSERT INTO qhse.investigacion_porque (id, investigacion_id, orden, pregunta, respuesta, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [uuidv7(), id, orden, pregunta, respuesta, TECNICO.id],
        );
      await expect(porque(0)).rejects.toThrow(/investigacion_porque_orden_check/);
      await expect(porque(11)).rejects.toThrow(/investigacion_porque_orden_check/);
      await expect(porque(1, ' ')).rejects.toThrow(/investigacion_porque_texto_check/);
      await porque(1);
      await expect(porque(1)).rejects.toThrow(/investigacion_porque_orden_key/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_ishikawa_causa (id, investigacion_id, categoria_id, orden, descripcion, created_by) VALUES ($1, $2, $3, 1, ' ', $4)",
          [uuidv7(), id, categorias['metodo'], TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_ishikawa_causa_texto_check/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_ishikawa_causa (id, investigacion_id, categoria_id, orden, descripcion, created_by) VALUES ($1, $2, $3, 1, 'x', $4)",
          [uuidv7(), id, uuidv7(), TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_ishikawa_causa_categoria_fkey/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_causa (id, investigacion_id, tipo, orden, descripcion, created_by) VALUES ($1, $2, 'inventado', 1, 'x', $3)",
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/tipo_causa_investigacion/);
    });

    it('las causas dependen de la investigación (FK) y la categoría del catálogo no se borra con causas', async () => {
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_causa (id, investigacion_id, tipo, orden, descripcion, created_by) VALUES ($1, $2, 'acto_inseguro', 1, 'x', $3)",
          [uuidv7(), uuidv7(), TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_causa_investigacion_fkey/);
      const id = await abierta();
      await guardar(id, 'ishikawa', {
        causas: [{ categoriaId: categorias['material'], descripcion: 'Eslinga gastada' }],
      });
      await expect(
        sql('DELETE FROM qhse.ishikawa_categoria WHERE codigo = $1', ['material']),
      ).rejects.toThrow(/investigacion_ishikawa_causa_categoria_fkey/);
    });
  });
});
