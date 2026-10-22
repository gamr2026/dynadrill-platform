/**
 * Integración real de QHSE: objetivos ambientales (plan de acción, seguimiento y cierre), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest objetivos-ambientales   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const RESPONSABLE = { id: uuidv7(), nombre: 'Rolando Responsable' };
const INACTIVO = { id: uuidv7(), nombre: 'Ines Inactiva', activo: false };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...RESPONSABLE, rol: 'operador' },
    { ...INACTIVO, rol: 'operador' },
  ],
};

type Salida = { datos: { data: Record<string, unknown> } };
const fechaEn = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: objetivos ambientales (base de datos real)', () => {
  jest.setTimeout(240000);
  let t: AppDePrueba;
  let frecuencia: Record<string, string> = {};
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.OBJETIVOS_AMBIENTALES_VER, P.OBJETIVOS_AMBIENTALES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.OBJETIVOS_AMBIENTALES_VER], TECNICO.id);
  const sinPermiso = () => t.token('operador', 'Oscar Operador', [P.QHSE_REPORTAR], uuidv7());
  const ruta = (id = '', resto = '') =>
    `/api/qhse/objetivos-ambientales${id ? `/${id}` : ''}${resto}`;
  const eventos = async (tipo: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'objetivoId' = $2 ORDER BY ocurrido_at, id",
        [tipo, id],
      )
    ).rows as Salida[];

  const crear = (cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
    t
      .http()
      .post(ruta())
      .set(quien)
      .send({
        titulo: 'Reducir el consumo de agua',
        objetivo: 'Disminuir el consumo de agua en las locaciones',
        meta: 'Reducir 10% frente al año anterior',
        indicador: 'm3 de agua por pozo intervenido',
        ...cuerpo,
      });
  const creado = async (cuerpo: Record<string, unknown> = {}) => {
    const r = await crear(cuerpo);
    expect(r.status).toBe(201);
    return r.body as { id: string; codigo: string };
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3182');
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await t.http().get(ruta('catalogos')).set(soloVer());
    frecuencia = Object.fromEntries(
      r.body.frecuencias.map((f: { codigo: string; id: string }) => [f.codigo, f.id]),
    );
  });

  afterAll(async () => {
    const ids = [TECNICO.id, RESPONSABLE.id];
    // un objetivo cerrado está protegido por triggers que también impiden borrar su plan; se apagan SOLO dentro de esta transacción (rol migrador)
    const c = await t.admin.connect();
    try {
      await c.query('BEGIN');
      const mios = '(SELECT id FROM qhse.objetivo_ambiental WHERE created_by = ANY($1::uuid[]))';
      await c.query('ALTER TABLE qhse.objetivo_ambiental_accion DISABLE TRIGGER USER');
      await c.query(`DELETE FROM qhse.objetivo_ambiental_accion WHERE objetivo_id IN ${mios}`, [
        ids,
      ]);
      await c.query('ALTER TABLE qhse.objetivo_ambiental_accion ENABLE TRIGGER USER');
      await c.query(
        `DELETE FROM qhse.objetivo_ambiental_seguimiento WHERE objetivo_id IN ${mios}`,
        [ids],
      );
      await c.query('DELETE FROM qhse.objetivo_ambiental WHERE created_by = ANY($1::uuid[])', [
        ids,
      ]);
      await c.query(
        "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.objetivo_ambiental.%' AND datos->'actor'->>'userId' = ANY($1::text[])",
        [ids],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('registrar un objetivo', () => {
    it('trae las cuatro frecuencias del catálogo', () => {
      expect(Object.keys(frecuencia).sort()).toEqual([
        'anual',
        'mensual',
        'semestral',
        'trimestral',
      ]);
    });

    it('lo registra con su plan de acción (una acción por fila), consecutivo y evento', async () => {
      const r = await crear({
        beneficioEmpresarial: 'Menor costo operativo',
        plazo: fechaEn(120),
        planAccion: [
          {
            accionEspecifica: 'Instalar medidores de agua',
            responsableId: RESPONSABLE.id,
            indicador: 'Medidores instalados',
            evidenciaEsperada: 'Fotos y actas',
            frecuenciaId: frecuencia['mensual'],
          },
          { accionEspecifica: 'Capacitar al personal' },
        ],
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        estado: 'en_curso',
        estadoPlazo: 'vigente',
        creadoPor: TECNICO.nombre,
        beneficioEmpresarial: 'Menor costo operativo',
      });
      expect(r.body.codigo).toMatch(/^OBJ-\d{6}$/);
      expect(r.body.planAccion).toHaveLength(2);
      expect(r.body.planAccion[0]).toMatchObject({
        orden: 1,
        responsable: { id: RESPONSABLE.id, nombre: RESPONSABLE.nombre },
        frecuencia: { nombre: 'Mensual' },
      });
      expect(r.body.planAccion[1]).toMatchObject({ orden: 2, responsable: null, frecuencia: null });
      const ev = await eventos('qhse.objetivo_ambiental.creado', r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({
        estado: 'en_curso',
        titulo: 'Reducir el consumo de agua',
      });
    });

    it('el estado del plazo: sin plazo, vigente, por vencer (30 días) y vencido', async () => {
      const sin = await creado();
      const pronto = await creado({ plazo: fechaEn(10) });
      const vencido = await creado({ plazo: fechaEn(5) });
      await sql('UPDATE qhse.objetivo_ambiental SET plazo = CURRENT_DATE - 2 WHERE id = $1', [
        vencido.id,
      ]);
      const lista = (await t.http().get(ruta()).set(soloVer())).body;
      const de = (id: string) => lista.items.find((i: { id: string }) => i.id === id);
      expect(de(sin.id)).toMatchObject({ estadoPlazo: 'sin_plazo', diasParaVencer: null });
      expect(de(pronto.id)).toMatchObject({ estadoPlazo: 'por_vencer', diasParaVencer: 10 });
      expect(de(vencido.id)).toMatchObject({ estadoPlazo: 'vencido' });
      expect(lista.kpi.vencidos).toBeGreaterThanOrEqual(1);
      expect(lista.kpi.porVencer).toBeGreaterThanOrEqual(1);
    });

    it('rechaza lo inválido y a quien no corresponde', async () => {
      expect((await crear({ titulo: '  ' })).body.message).toMatch(
        /título, objetivo, meta e indicador/,
      );
      expect((await crear({ meta: '' })).status).toBe(400);
      expect((await crear({ plazo: fechaEn(-1) })).body.message).toMatch(/fecha pasada/);
      expect(
        (await crear({ planAccion: [{ accionEspecifica: 'x', responsableId: uuidv7() }] })).body
          .message,
      ).toMatch(/responsable/);
      expect(
        (await crear({ planAccion: [{ accionEspecifica: 'x', responsableId: INACTIVO.id }] }))
          .status,
      ).toBe(400);
      expect(
        (await crear({ planAccion: [{ accionEspecifica: 'x', frecuenciaId: uuidv7() }] })).body
          .message,
      ).toMatch(/frecuencia/);
      expect((await crear({ planAccion: [{ accionEspecifica: ' ' }] })).status).toBe(400);
      expect((await crear({}, soloVer())).status).toBe(403);
      expect((await t.http().get(ruta()).set(sinPermiso())).status).toBe(403);
      expect((await t.http().get(ruta(uuidv7())).set(soloVer())).status).toBe(404);
    });

    it('un objetivo fallido no deja nada a medias (el plan se guarda en la misma transacción)', async () => {
      const antes = (await sql('SELECT count(*)::int n FROM qhse.objetivo_ambiental')).rows[0].n;
      await crear({
        planAccion: [
          { accionEspecifica: 'ok' },
          { accionEspecifica: 'x', responsableId: uuidv7() },
        ],
      });
      expect((await sql('SELECT count(*)::int n FROM qhse.objetivo_ambiental')).rows[0].n).toBe(
        antes,
      );
    });
  });

  describe('editar y plan de acción', () => {
    it('edita los datos del objetivo y reemplaza el plan completo mientras está en curso', async () => {
      const o = await creado({ planAccion: [{ accionEspecifica: 'Primera' }] });
      const e = await t
        .http()
        .patch(ruta(o.id))
        .set(gestor())
        .send({ meta: 'Reducir 15%', plazo: fechaEn(60) });
      expect(e.status).toBe(200);
      expect(e.body).toMatchObject({
        meta: 'Reducir 15%',
        plazo: fechaEn(60),
        titulo: 'Reducir el consumo de agua',
      });
      const p = await t
        .http()
        .put(ruta(o.id, '/plan-accion'))
        .set(gestor())
        .send({
          acciones: [
            { accionEspecifica: 'Nueva A', frecuenciaId: frecuencia['trimestral'] },
            { accionEspecifica: 'Nueva B' },
            { accionEspecifica: 'Nueva C' },
          ],
        });
      expect(
        p.body.planAccion.map((a: { accionEspecifica: string }) => a.accionEspecifica),
      ).toEqual(['Nueva A', 'Nueva B', 'Nueva C']);
      expect((await t.http().patch(ruta(o.id)).set(gestor()).send({ titulo: ' ' })).status).toBe(
        400,
      );
      expect((await t.http().patch(ruta(o.id)).set(soloVer()).send({ meta: 'x' })).status).toBe(
        403,
      );
    });
  });

  describe('seguimiento', () => {
    it('registra avances fechados; el avance actual es el del seguimiento más reciente', async () => {
      const o = await creado();
      const seg = (cuerpo: Record<string, unknown>) =>
        t.http().post(ruta(o.id, '/seguimientos')).set(gestor()).send(cuerpo);
      expect(
        (
          await seg({
            fecha: fechaEn(-30),
            avancePorcentaje: 20,
            observacion: 'Se compraron medidores',
          })
        ).status,
      ).toBe(201);
      const r = await seg({
        avancePorcentaje: 55,
        observacion: 'Medidores instalados en 3 locaciones',
      });
      expect(r.body.avanceActual).toBe(55);
      expect(
        r.body.seguimientos.map((s: { avancePorcentaje: number }) => s.avancePorcentaje),
      ).toEqual([55, 20]);
      expect(r.body.seguimientos[0]).toMatchObject({
        registradoPor: TECNICO.nombre,
        fecha: fechaEn(0),
      });
      // un seguimiento con fecha anterior no cambia el avance actual: manda el más reciente por fecha
      await seg({
        fecha: fechaEn(-60),
        avancePorcentaje: 5,
        observacion: 'Registro tardío del arranque',
      });
      expect((await t.http().get(ruta(o.id)).set(soloVer())).body.avanceActual).toBe(55);
      expect((await eventos('qhse.objetivo_ambiental.seguimiento_registrado', o.id)).length).toBe(
        3,
      );
    });

    it('rechaza fecha futura, avance fuera de 0 a 100 y observación vacía', async () => {
      const o = await creado();
      const seg = (cuerpo: Record<string, unknown>) =>
        t.http().post(ruta(o.id, '/seguimientos')).set(gestor()).send(cuerpo);
      expect(
        (await seg({ fecha: fechaEn(2), avancePorcentaje: 10, observacion: 'x' })).body.message,
      ).toMatch(/futura/);
      expect((await seg({ avancePorcentaje: 101, observacion: 'x' })).status).toBe(400);
      expect((await seg({ avancePorcentaje: -1, observacion: 'x' })).status).toBe(400);
      expect((await seg({ avancePorcentaje: 10, observacion: '  ' })).status).toBe(400);
      expect((await seg({ avancePorcentaje: 10.5, observacion: 'x' })).status).toBe(400);
    });
  });

  describe('cierre', () => {
    it('lo cierra como cumplido con su resultado y queda congelado (plan, datos y seguimiento)', async () => {
      const o = await creado({ plazo: fechaEn(40), planAccion: [{ accionEspecifica: 'Única' }] });
      expect(
        (
          await t
            .http()
            .post(ruta(o.id, '/cerrar'))
            .set(gestor())
            .send({ estado: 'cumplido', resultado: ' ' })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .post(ruta(o.id, '/cerrar'))
            .set(gestor())
            .send({ estado: 'en_curso', resultado: 'x' })
        ).status,
      ).toBe(400);
      const r = await t
        .http()
        .post(ruta(o.id, '/cerrar'))
        .set(gestor())
        .send({ estado: 'cumplido', resultado: 'Se redujo 12%', evidencia: 'Informe anual' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        estado: 'cumplido',
        resultado: 'Se redujo 12%',
        evidencia: 'Informe anual',
        cerradoPor: TECNICO.nombre,
        estadoPlazo: null,
        diasParaVencer: null,
      });
      const ev = await eventos('qhse.objetivo_ambiental.cerrado', o.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ estado: 'cumplido' });
      // en secuencia: cada llamada abre su propio servidor de prueba
      const bloqueos: Array<[string, () => Promise<{ status: number }>]> = [
        ['editar', () => t.http().patch(ruta(o.id)).set(gestor()).send({ meta: 'x' })],
        [
          'plan',
          () => t.http().put(ruta(o.id, '/plan-accion')).set(gestor()).send({ acciones: [] }),
        ],
        [
          'seguimiento',
          () =>
            t
              .http()
              .post(ruta(o.id, '/seguimientos'))
              .set(gestor())
              .send({ avancePorcentaje: 1, observacion: 'x' }),
        ],
        [
          'cerrar',
          () =>
            t
              .http()
              .post(ruta(o.id, '/cerrar'))
              .set(gestor())
              .send({ estado: 'no_cumplido', resultado: 'x' }),
        ],
      ];
      for (const [nombre, llamar] of bloqueos)
        expect([nombre, (await llamar()).status]).toEqual([nombre, 409]);
    });

    it('también se cierra como no cumplido', async () => {
      const o = await creado();
      const r = await t.http().post(ruta(o.id, '/cerrar')).set(gestor()).send({
        estado: 'no_cumplido',
        resultado: 'No se alcanzó la meta por falta de presupuesto',
      });
      expect(r.body.estado).toBe('no_cumplido');
      const lista = (await t.http().get(`${ruta()}?estado=no_cumplido`).set(soloVer())).body;
      expect(lista.items.some((i: { id: string }) => i.id === o.id)).toBe(true);
      expect((await t.http().get(`${ruta()}?estado=otro`).set(soloVer())).status).toBe(400);
    });
  });

  describe('reglas de la base', () => {
    it('nace en curso y cada estado trae sus datos', async () => {
      const ins = (estado: string, extra = '') =>
        sql(
          `INSERT INTO qhse.objetivo_ambiental (id, titulo, objetivo, meta, indicador, estado, created_by${extra ? ', resultado, cerrado_at, cerrado_por' : ''})
           VALUES ($1, 't', 'o', 'm', 'i', $2::qhse.estado_objetivo_ambiental, $3${extra ? ", 'r', now(), $3" : ''})`,
          [uuidv7(), estado, TECNICO.id],
        );
      await expect(ins('cumplido', 'con datos')).rejects.toThrow(/nace en curso/);
      await expect(ins('cumplido')).rejects.toThrow(/nace en curso/);
      const o = await creado();
      await expect(
        sql("UPDATE qhse.objetivo_ambiental SET estado = 'cumplido' WHERE id = $1", [o.id]),
      ).rejects.toThrow(/objetivo_ambiental_estado_check/);
      await expect(
        sql("UPDATE qhse.objetivo_ambiental SET titulo = ' ' WHERE id = $1", [o.id]),
      ).rejects.toThrow(/objetivo_ambiental_texto_check/);
      await expect(
        sql("UPDATE qhse.objetivo_ambiental SET resultado = 'x' WHERE id = $1", [o.id]),
      ).rejects.toThrow(/objetivo_ambiental_estado_check/);
    });

    it('un objetivo cerrado no cambia, ni su plan ni su seguimiento, ni con el rol migrador', async () => {
      const o = await creado({ planAccion: [{ accionEspecifica: 'A' }] });
      await t
        .http()
        .post(ruta(o.id, '/cerrar'))
        .set(gestor())
        .send({ estado: 'cumplido', resultado: 'ok' });
      await expect(
        sql("UPDATE qhse.objetivo_ambiental SET meta = 'otra' WHERE id = $1", [o.id]),
      ).rejects.toThrow(/cerrado y no admite cambios/);
      await expect(
        sql(
          "UPDATE qhse.objetivo_ambiental SET estado = 'en_curso', resultado = NULL, cerrado_at = NULL, cerrado_por = NULL WHERE id = $1",
          [o.id],
        ),
      ).rejects.toThrow(/cerrado y no admite cambios/);
      await expect(
        sql(
          "INSERT INTO qhse.objetivo_ambiental_accion (id, objetivo_id, orden, accion_especifica, created_by) VALUES ($1, $2, 9, 'x', $3)",
          [uuidv7(), o.id, TECNICO.id],
        ),
      ).rejects.toThrow(/cerrado y no admite cambios/);
      await expect(
        sql(
          "INSERT INTO qhse.objetivo_ambiental_seguimiento (id, objetivo_id, fecha, avance_porcentaje, observacion, created_by) VALUES ($1, $2, CURRENT_DATE, 10, 'x', $3)",
          [uuidv7(), o.id, TECNICO.id],
        ),
      ).rejects.toThrow(/cerrado y no admite cambios/);
    });

    it('integridad de las filas: avance 0 a 100, orden único, FK de responsable y frecuencia', async () => {
      const o = await creado({ planAccion: [{ accionEspecifica: 'A' }] });
      const seg = (avance: number, obs = 'x') =>
        sql(
          'INSERT INTO qhse.objetivo_ambiental_seguimiento (id, objetivo_id, fecha, avance_porcentaje, observacion, created_by) VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)',
          [uuidv7(), o.id, avance, obs, TECNICO.id],
        );
      await expect(seg(101)).rejects.toThrow(/objetivo_ambiental_seguimiento_avance_check/);
      await expect(seg(-1)).rejects.toThrow(/objetivo_ambiental_seguimiento_avance_check/);
      await expect(seg(10, ' ')).rejects.toThrow(/objetivo_ambiental_seguimiento_texto_check/);
      const acc = (cols: string, vals: unknown[]) =>
        sql(
          `INSERT INTO qhse.objetivo_ambiental_accion (id, objetivo_id, orden, accion_especifica, created_by, ${cols}) VALUES ($1, $2, $3, 'x', $4, ${vals.map((_, i) => `$${i + 5}`).join(', ')})`,
          [uuidv7(), o.id, Math.floor(Math.random() * 1e6) + 10, TECNICO.id, ...vals],
        );
      await expect(acc('responsable_id', [uuidv7()])).rejects.toThrow(
        /objetivo_ambiental_accion_responsable_fkey/,
      );
      await expect(acc('frecuencia_id', [uuidv7()])).rejects.toThrow(
        /objetivo_ambiental_accion_frecuencia_fkey/,
      );
      await expect(
        sql(
          "INSERT INTO qhse.objetivo_ambiental_accion (id, objetivo_id, orden, accion_especifica, created_by) VALUES ($1, $2, 1, 'dup', $3)",
          [uuidv7(), o.id, TECNICO.id],
        ),
      ).rejects.toThrow(/objetivo_ambiental_accion_orden_key/);
    });

    it('la aplicación no borra objetivos ni reescribe el seguimiento, y no cambia lo que no le toca', async () => {
      const o = await creado();
      await t
        .http()
        .post(ruta(o.id, '/seguimientos'))
        .set(gestor())
        .send({ avancePorcentaje: 30, observacion: 'ok' });
      await expect(t.prisma.objetivoAmbiental.deleteMany({ where: { id: o.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.objetivoAmbiental.updateMany({
          where: { id: o.id },
          data: { createdBy: RESPONSABLE.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.objetivoAmbientalSeguimiento.updateMany({
          where: { objetivoId: o.id },
          data: { observacion: 'cambiada' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.objetivoAmbientalSeguimiento.deleteMany({ where: { objetivoId: o.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });
  });
});
