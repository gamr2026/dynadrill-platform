/**
 * Integración real de QHSE: Desechos (HSE-AMBIENTAL-001), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest desechos   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Catalogos = {
  caracteristicas: Array<{ id: string; codigo: string }>;
  contenedores: Array<{ id: string; codigo: string }>;
  pozos: Array<{ id: string }>;
};

run('QHSE: Desechos (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let cat: Catalogos;
  const desechos: string[] = [];

  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.QHSE_REPORTAR, P.DESECHOS_VER], TECNICO.id);

  const car = (codigo: string) => cat.caracteristicas.find((c) => c.codigo === codigo)!.id;
  const cont = (codigo: string) => cat.contenedores.find((c) => c.codigo === codigo)!.id;
  const linea = (extra: Record<string, unknown> = {}) => ({
    descripcion: 'Trapos con hidrocarburo',
    codigo: 'NE-03',
    cantidadGalones: 12.5,
    bultos: 2,
    ...extra,
  });
  const registrar = async (cuerpo: Record<string, unknown> = {}, quien = operador()) => {
    const r = await t
      .http()
      .post('/api/qhse/desechos')
      .set(quien)
      .send({
        clasificacion: 'peligroso',
        contenedorId: cont('negro'),
        caracteristicaIds: [car('inflamable'), car('toxico')],
        descripcion: 'Trapos y absorbentes contaminados',
        ubicacion: 'Laydown de la locación 3',
        items: [linea()],
        ...cuerpo,
      });
    if (r.status === 201) desechos.push(r.body.id);
    return r;
  };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const estadoId = async (codigo: string) =>
    (await sql('SELECT id FROM qhse.desecho_estado WHERE codigo = $1', [codigo])).rows[0]
      .id as string;

  /** Inserta un desecho completo directo en la base (como dyn_migrator) con la fecha de registro que se indique. */
  const insertarDirecto = async (diasAtras: number, estado = 'almacenado') => {
    const id = uuidv7();
    const c = await t.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO qhse.desecho (id, clasificacion, contenedor_id, estado_id, descripcion, registrado_el, limite_almacenamiento_hasta, created_by)
         VALUES ($1, 'no_peligroso', $2, $3, 'Desecho antiguo', CURRENT_DATE - $4::int, (CURRENT_DATE - $4::int + INTERVAL '12 months')::date, $5)`,
        [id, cont('gris'), await estadoId(estado), diasAtras, OPERADOR.id],
      );
      await c.query(
        "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 1, 'Plástico', 'NP-01', 5, $3)",
        [uuidv7(), id, OPERADOR.id],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    desechos.push(id);
    return id;
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3181');
    await sembrarMaestros(t.admin, MAESTROS);
    cat = (await t.http().get('/api/qhse/desechos/catalogos').set(operador())).body;
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.desecho WHERE id = ANY($1::uuid[])', [desechos]);
    await t.admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'desechoId' = ANY($1::text[])",
      [desechos],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('los catálogos salen sembrados: seis características CRETIB, cinco contenedores y tres estados', async () => {
    expect(cat.caracteristicas.map((c) => c.codigo)).toEqual([
      'corrosivo',
      'reactivo',
      'explosivo',
      'toxico',
      'inflamable',
      'biologico_infeccioso',
    ]);
    expect(cat.contenedores.map((c) => c.codigo)).toEqual([
      'rojo',
      'negro',
      'gris',
      'verde',
      'azul',
    ]);
    const estados = await sql('SELECT codigo FROM qhse.desecho_estado ORDER BY orden');
    expect(estados.rows.map((e: { codigo: string }) => e.codigo)).toEqual([
      'almacenado',
      'con_manifiesto',
      'dispuesto',
    ]);
  });

  it('cualquier trabajador registra; el equipo HSE lo ve con el límite de 12 meses, el historial y el evento', async () => {
    const r = await registrar();
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      codigo: expect.stringMatching(/^DES-\d{6}$/),
      estado: 'almacenado',
    });
    // quien reporta no ve la bandeja ni el detalle
    expect((await t.http().get('/api/qhse/desechos').set(operador())).status).toBe(403);
    expect((await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(operador())).status).toBe(
      403,
    );

    const d = (await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(tecnico())).body;
    expect(d).toMatchObject({
      clasificacion: 'peligroso',
      estado: { codigo: 'almacenado' },
      contenedor: { codigo: 'negro' },
      generadoPor: OPERADOR.nombre,
      totalGalones: 12.5,
      vencido: false,
    });
    expect(d.cretib.sort()).toEqual(['Inflamable', 'Tóxico']);
    expect(d.items).toHaveLength(1);
    expect(d.historial).toHaveLength(1);
    // límite = registro + 12 meses
    const fila = (
      await sql(
        "SELECT (registrado_el + INTERVAL '12 months')::date::text AS esperado, limite_almacenamiento_hasta::text AS limite FROM qhse.desecho WHERE id = $1",
        [r.body.id],
      )
    ).rows[0];
    expect(fila.limite).toBe(fila.esperado);
    expect(d.limiteAlmacenamientoHasta).toBe(fila.limite);
    expect(d.diasParaLimite).toBeGreaterThanOrEqual(364);

    const ev = (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = 'qhse.desecho.registrado' AND datos->'data'->>'desechoId' = $1",
        [r.body.id],
      )
    ).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.data).toMatchObject({
      estado: 'almacenado',
      clasificacion: 'peligroso',
      contenedor: 'negro',
      totalGalones: 12.5,
    });
    expect(ev[0].datos.data.cretib.sort()).toEqual(['inflamable', 'toxico']);
  });

  it('un no peligroso se registra sin características y con pozo del catálogo', async () => {
    const pozoId = cat.pozos[0]?.id;
    const r = await registrar({
      clasificacion: 'no_peligroso',
      contenedorId: cont('gris'),
      caracteristicaIds: [],
      descripcion: 'Residuos comunes de campamento',
      ...(pozoId ? { pozoId } : {}),
    });
    expect(r.status).toBe(201);
    const d = (await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(tecnico())).body;
    expect(d.cretib).toEqual([]);
  });

  it('el servicio rechaza lo incompleto con mensajes claros', async () => {
    const peligrosoSin = await registrar({ caracteristicaIds: [] });
    expect(peligrosoSin.status).toBe(400);
    expect(peligrosoSin.body.detail).toMatch(
      /peligroso necesita al menos una característica CRETIB/,
    );

    const noPeligrosoCon = await registrar({
      clasificacion: 'no_peligroso',
      caracteristicaIds: [car('toxico')],
    });
    expect(noPeligrosoCon.status).toBe(400);
    expect(noPeligrosoCon.body.detail).toMatch(/no peligroso no lleva/);

    expect((await registrar({ items: [] })).status).toBe(400);
    expect((await registrar({ items: [linea({ cantidadGalones: 0 })] })).status).toBe(400);
    expect((await registrar({ items: [linea({ codigo: '   ' })] })).status).toBe(400);
    expect((await registrar({ descripcion: '   ' })).status).toBe(400);
    expect((await registrar({ contenedorId: uuidv7() })).status).toBe(400);
    expect((await registrar({ caracteristicaIds: [uuidv7()] })).status).toBe(400);
    expect((await registrar({ pozoId: uuidv7() })).status).toBe(400);
    // sin cuenta con permiso de reportar no se registra
    const sinPermiso = t.token('operador', OPERADOR.nombre, [], OPERADOR.id);
    expect((await registrar({}, sinPermiso)).status).toBe(403);
  });

  it('la bandeja filtra por estado y marca como vencido lo almacenado más de 12 meses', async () => {
    const viejo = await insertarDirecto(400);
    const reciente = await insertarDirecto(10);
    const todos = (await t.http().get('/api/qhse/desechos').set(tecnico())).body as Array<{
      id: string;
      vencido: boolean;
      diasParaLimite: number | null;
    }>;
    expect(todos.find((x) => x.id === viejo)).toMatchObject({ vencido: true });
    expect(todos.find((x) => x.id === viejo)!.diasParaLimite).toBeLessThan(0);
    expect(todos.find((x) => x.id === reciente)).toMatchObject({ vencido: false });

    const almacenados = (await t.http().get('/api/qhse/desechos?estado=almacenado').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(almacenados.some((x) => x.id === viejo)).toBe(true);
    const conManifiesto = (
      await t.http().get('/api/qhse/desechos?estado=con_manifiesto').set(tecnico())
    ).body as Array<{ id: string }>;
    expect(conManifiesto.some((x) => x.id === viejo)).toBe(false);
    const busqueda = (await t.http().get('/api/qhse/desechos?q=antiguo').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(busqueda.some((x) => x.id === viejo)).toBe(true);
  });

  describe('reglas de la base', () => {
    const cabecera = async (
      extra: { limite?: string; estado?: string; clasificacion?: string } = {},
    ) => {
      const id = uuidv7();
      return {
        id,
        texto: `INSERT INTO qhse.desecho (id, clasificacion, contenedor_id, estado_id, descripcion, registrado_el, limite_almacenamiento_hasta, created_by)
                VALUES ($1, $2::qhse.clasificacion_desecho, $3, $4, 'Prueba', CURRENT_DATE, COALESCE($5::date, (CURRENT_DATE + INTERVAL '12 months')::date), $6)`,
        params: [
          id,
          extra.clasificacion ?? 'no_peligroso',
          cont('gris'),
          await estadoId(extra.estado ?? 'almacenado'),
          extra.limite ?? null,
          OPERADOR.id,
        ],
      };
    };
    /** Ejecuta en una transacción y confirma (los triggers diferidos se evalúan al confirmar). */
    const enTransaccion = async (pasos: Array<[string, unknown[]]>) => {
      const c = await t.admin.connect();
      try {
        await c.query('BEGIN');
        for (const [texto, params] of pasos) await c.query(texto, params);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    };
    const item = (id: string): [string, unknown[]] => [
      "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 1, 'Línea', 'X-1', 1, $3)",
      [uuidv7(), id, OPERADOR.id],
    ];

    it('el límite de almacenamiento debe ser el registro más 12 meses (AM 142)', async () => {
      const c = await cabecera({ limite: '2099-01-01' });
      await expect(sql(c.texto, c.params)).rejects.toThrow(/desecho_limite_check/);
    });

    it('un peligroso sin característica CRETIB, un no peligroso con ella y una guía sin líneas no se confirman', async () => {
      const peligroso = await cabecera({ clasificacion: 'peligroso' });
      await expect(
        enTransaccion([[peligroso.texto, peligroso.params], item(peligroso.id)]),
      ).rejects.toThrow(/al menos una característica CRETIB/);

      const noPeligroso = await cabecera();
      await expect(
        enTransaccion([
          [noPeligroso.texto, noPeligroso.params],
          [
            'INSERT INTO qhse.desecho_caracteristica_asignada (desecho_id, caracteristica_id) VALUES ($1, $2)',
            [noPeligroso.id, car('toxico')],
          ],
          item(noPeligroso.id),
        ]),
      ).rejects.toThrow(/no peligroso no lleva características CRETIB/);

      const sinLineas = await cabecera();
      await expect(enTransaccion([[sinLineas.texto, sinLineas.params]])).rejects.toThrow(
        /al menos una línea/,
      );
    });

    it('nace almacenado, no se salta de estado y la cantidad de una línea debe ser positiva', async () => {
      const nace = await cabecera({ estado: 'dispuesto' });
      await expect(sql(nace.texto, nace.params)).rejects.toThrow(/nace almacenado/);

      const id = await insertarDirecto(1);
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('dispuesto'),
        ]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        sql(
          "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 2, 'Línea', 'X-2', 0, $3)",
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/desecho_item_cantidad_check/);
    });

    it('la aplicación no reescribe ni borra lo registrado: solo avanza el estado', async () => {
      const id = await insertarDirecto(1);
      await expect(
        t.prisma.desecho.update({ where: { id }, data: { descripcion: 'otra cosa' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desecho.update({
          where: { id },
          data: { limiteAlmacenamientoHasta: new Date('2099-01-01') },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.desecho.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.desechoItem.updateMany({ where: { desechoId: id }, data: { bultos: 9 } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.desechoItem.deleteMany({ where: { desechoId: id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.desechoCaracteristicaAsignada.deleteMany({ where: { desechoId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desechoHistorial.deleteMany({ where: { desechoId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('con el desecho fuera de almacenamiento no se agregan líneas, y uno dispuesto ya no cambia', async () => {
      const id = await insertarDirecto(1);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('con_manifiesto'),
      ]);
      await expect(sql(...item(id))).rejects.toThrow(/solo se completan con el desecho almacenado/);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('dispuesto'),
      ]);
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('almacenado'),
        ]),
      ).rejects.toThrow(/dispuesto ya no se modifica/);
    });

    it('un contenedor, un estado o un pozo inexistentes no pasan (FK)', async () => {
      const c = await cabecera();
      c.params[2] = uuidv7();
      await expect(sql(c.texto, c.params)).rejects.toThrow(/desecho_contenedor_fkey/);
      const e = await cabecera();
      e.params[3] = uuidv7();
      await expect(sql(e.texto, e.params)).rejects.toThrow(/desecho_estado_fkey/);
      const id = await insertarDirecto(1);
      await expect(
        sql('UPDATE qhse.desecho SET pozo_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/desecho_pozo_fkey/);
    });
  });
});
