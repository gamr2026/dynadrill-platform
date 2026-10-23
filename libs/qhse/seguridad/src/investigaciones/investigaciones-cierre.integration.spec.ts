/**
 * Integración real de QHSE: investigación de incidentes (rebanada 5: conclusión, notificación legal, revisión y cierre), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest investigaciones-cierre   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { borrarInvestigacionesDe } from '../testing/limpieza-investigaciones';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;
const n = Date.now();

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const GERENTE = { id: uuidv7(), nombre: 'Gabriel Gerente HSE' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...GERENTE, rol: 'gerente_hse' },
  ],
};

type Salida = { datos: { data: Record<string, unknown> } };
const dia = (dias: number) =>
  new Date(Date.now() + dias * 24 * H).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: investigación de incidentes, revisión y cierre (base de datos real)', () => {
  jest.setTimeout(240000);
  let t: AppDePrueba;
  let resultado: Record<string, string> = {};
  const actividad = { id: uuidv7(), proceso: uuidv7(), zona: uuidv7() };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR],
      TECNICO.id,
    );
  const gerente = () =>
    t.token(
      'gerente_hse',
      GERENTE.nombre,
      [P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR, P.INVESTIGACIONES_APROBAR],
      GERENTE.id,
    );
  const ruta = (id: string, resto = '') => `/api/qhse/investigaciones/${id}${resto}`;
  const eventos = async (tipo: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'investigacionId' = $2 ORDER BY ocurrido_at, id",
        [tipo, id],
      )
    ).rows as Salida[];

  /** Investigación en curso (con líder y escena), del resultado indicado. */
  const enCurso = async (codigo = 'near_miss') => {
    const r = await t
      .http()
      .post(ruta(''))
      .set(tecnico())
      .send({
        resultadoId: resultado[codigo],
        descripcionEvento: 'Caída de objetos durante el izaje',
        fechaIncidente: new Date(Date.now() - 6 * H).toISOString(),
        ubicacion: 'Locación 5',
      });
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    await t.http().post(ruta(id, '/iniciar')).set(tecnico()).send({ liderId: TECNICO.id });
    return id;
  };
  const cincoPorques = (id: string) =>
    t
      .http()
      .put(ruta(id, '/porques'))
      .set(tecnico())
      .send({
        porques: [1, 2, 3, 4, 5].map((k) => ({
          pregunta: `¿Por qué ${k}?`,
          respuesta: `Porque ${k}`,
        })),
      });
  const conclusion = (id: string, cuerpo: Record<string, unknown> = { conclusion: 'incidente' }) =>
    t.http().put(ruta(id, '/conclusion')).set(tecnico()).send(cuerpo);
  const accion = (id: string) =>
    t
      .http()
      .post(ruta(id, '/acciones'))
      .set(tecnico())
      .send({
        descripcion: 'Señalizar el área',
        tipo: 'correctiva',
        responsableId: TECNICO.id,
        plazo: dia(15),
      });
  /** Todo lo que el envío a revisión exige. */
  const lista = async (codigo = 'near_miss') => {
    const id = await enCurso(codigo);
    await cincoPorques(id);
    await conclusion(id);
    await accion(id);
    return id;
  };
  const enRevision = async (codigo = 'near_miss') => {
    const id = await lista(codigo);
    expect((await t.http().post(ruta(id, '/enviar-revision')).set(tecnico())).status).toBe(201);
    return id;
  };
  const detalle = async (id: string) => (await t.http().get(ruta(id)).set(tecnico())).body;

  beforeAll(async () => {
    t = await levantarAppDePrueba('3184');
    await sembrarMaestros(t.admin, MAESTROS);
    const res = await t.http().get(ruta('/resultados').replace('//', '/')).set(tecnico());
    resultado = Object.fromEntries(
      res.body.map((x: { codigo: string; id: string }) => [x.codigo, x.id]),
    );
    // la actividad IPERC de la lección aprendida es propia de la prueba
    await sql(
      "INSERT INTO qhse.iperc_proceso (id, codigo, nombre, orden, created_by) VALUES ($1, $2, 'Proceso de prueba', $3, $4)",
      [actividad.proceso, `T-${n}`, 900000 + (n % 90000), TECNICO.id],
    );
    await sql(
      "INSERT INTO qhse.iperc_zona (id, codigo, nombre, orden, created_by) VALUES ($1, $2, 'Zona de prueba', $3, $4)",
      [actividad.zona, `T-${n}`, 900000 + (n % 90000), TECNICO.id],
    );
    await sql(
      "INSERT INTO qhse.iperc_actividad (id, proceso_id, zona_id, nombre, created_by) VALUES ($1, $2, $3, 'Actividad de prueba de investigación', $4)",
      [actividad.id, actividad.proceso, actividad.zona, TECNICO.id],
    );
  });

  afterAll(async () => {
    await borrarInvestigacionesDe(t.admin, [TECNICO.id, GERENTE.id]);
    await sql('DELETE FROM qhse.iperc_actividad WHERE id = $1', [actividad.id]);
    await sql('DELETE FROM qhse.iperc_proceso WHERE id = $1', [actividad.proceso]);
    await sql('DELETE FROM qhse.iperc_zona WHERE id = $1', [actividad.zona]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('conclusión y lección aprendida', () => {
    it('guarda la conclusión y la lección con el vínculo a la actividad IPERC, sin tocar la matriz', async () => {
      const id = await enCurso();
      const r = await conclusion(id, {
        conclusion: 'accidente',
        leccionesAprendidas: 'Revisar la señalización antes del izaje',
        ipercActividadId: actividad.id,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        conclusion: 'accidente',
        leccionesAprendidas: 'Revisar la señalización antes del izaje',
        ipercActividad: { id: actividad.id, nombre: 'Actividad de prueba de investigación' },
      });
      const estadoMatriz = await sql(
        'SELECT count(*)::int n FROM qhse.iperc_matriz WHERE actividad_id = $1',
        [actividad.id],
      );
      expect(estadoMatriz.rows[0].n).toBe(0);
    });

    it('rechaza una conclusión inventada o una actividad inexistente', async () => {
      const id = await enCurso();
      expect((await conclusion(id, { conclusion: 'siniestro' })).status).toBe(400);
      expect((await conclusion(id, { ipercActividadId: uuidv7() })).body.message).toMatch(
        /actividad/,
      );
    });
  });

  describe('notificación legal', () => {
    it('registra cuándo se notificó a Ministerio del Trabajo y al IESS', async () => {
      const id = await enCurso('leve');
      const mt = new Date(Date.now() - 2 * H).toISOString();
      const iess = new Date(Date.now() - H).toISOString();
      const r = await t
        .http()
        .put(ruta(id, '/notificacion-legal'))
        .set(tecnico())
        .send({ requerida: true, ministerioTrabajoNotificadoAt: mt, iessNotificadoAt: iess });
      expect(r.status).toBe(200);
      expect(r.body.notificacionLegal).toMatchObject({ sugerida: true, requerida: true });
      expect(new Date(r.body.notificacionLegal.iessNotificadoAt).toISOString()).toBe(iess);
    });

    it('rechaza fechas sin marcarla obligatoria, futuras o anteriores al incidente', async () => {
      const id = await enCurso('leve');
      const put = (cuerpo: Record<string, unknown>) =>
        t.http().put(ruta(id, '/notificacion-legal')).set(tecnico()).send(cuerpo);
      expect(
        (await put({ requerida: false, iessNotificadoAt: new Date(Date.now() - H).toISOString() }))
          .body.message,
      ).toMatch(/obligatoria/);
      expect(
        (
          await put({
            requerida: true,
            iessNotificadoAt: new Date(Date.now() + 3 * H).toISOString(),
          })
        ).body.message,
      ).toMatch(/futura/);
      expect(
        (
          await put({
            requerida: true,
            iessNotificadoAt: new Date(Date.now() - 48 * H).toISOString(),
          })
        ).body.message,
      ).toMatch(/anterior al incidente/);
    });
  });

  describe('enviar a revisión', () => {
    it('explica todo lo que falta: 5 Porqués, conclusión y una acción', async () => {
      const id = await enCurso();
      const r = await t.http().post(ruta(id, '/enviar-revision')).set(tecnico());
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/5 Porqués/);
      expect(r.body.message).toMatch(/conclusión/);
      expect(r.body.message).toMatch(/acción/);
      expect((await detalle(id)).cierre.pendientesParaRevision).toHaveLength(3);
    });

    it('una acción cancelada no cuenta; con todo listo pasa a en revisión, con historia y evento', async () => {
      const id = await enCurso();
      await cincoPorques(id);
      await conclusion(id);
      const a = (await accion(id)).body.acciones[0];
      await t
        .http()
        .post(ruta(id, `/acciones/${a.id}/cancelar`))
        .set(tecnico())
        .send({ motivo: 'Ya no aplica' });
      expect(
        (await t.http().post(ruta(id, '/enviar-revision')).set(tecnico())).body.message,
      ).toMatch(/acción/);
      await accion(id);
      const r = await t.http().post(ruta(id, '/enviar-revision')).set(tecnico());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ estado: 'en_revision', revisionEnviadaPor: TECNICO.nombre });
      expect(r.body.cierre.pendientesParaRevision).toEqual([]);
      const ev = await eventos('qhse.investigacion.enviada_a_revision', id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ estado: 'en_revision', conclusion: 'incidente' });
      expect((await t.http().post(ruta(id, '/enviar-revision')).set(tecnico())).status).toBe(409);
    });

    it('menos de 5 Porqués no alcanza', async () => {
      const id = await enCurso();
      await t
        .http()
        .put(ruta(id, '/porques'))
        .set(tecnico())
        .send({ porques: [1, 2, 3, 4].map((k) => ({ pregunta: `p${k}`, respuesta: `r${k}` })) });
      await conclusion(id);
      await accion(id);
      expect(
        (await t.http().post(ruta(id, '/enviar-revision')).set(tecnico())).body.message,
      ).toMatch(/tiene 4/);
    });
  });

  describe('devolver y cerrar', () => {
    it('solo el Gerente HSE devuelve o cierra: quien solo gestiona no puede', async () => {
      const id = await enRevision();
      expect((await t.http().post(ruta(id, '/cerrar')).set(tecnico())).status).toBe(403);
      expect(
        (await t.http().post(ruta(id, '/devolver')).set(tecnico()).send({ observacion: 'x' }))
          .status,
      ).toBe(403);
    });

    it('el Gerente la devuelve con su observación y vuelve a en investigación, editable otra vez', async () => {
      const id = await enRevision();
      expect(
        (await t.http().post(ruta(id, '/devolver')).set(gerente()).send({ observacion: ' ' }))
          .status,
      ).toBe(400);
      const r = await t
        .http()
        .post(ruta(id, '/devolver'))
        .set(gerente())
        .send({ observacion: 'Falta profundizar el tercer porqué' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ estado: 'en_investigacion', revisionEnviadaAt: null });
      expect(r.body.historial.at(-1)).toMatchObject({
        estadoNuevo: 'en_investigacion',
        observacion: 'Falta profundizar el tercer porqué',
      });
      expect(await eventos('qhse.investigacion.devuelta', id)).toHaveLength(1);
      expect((await cincoPorques(id)).status).toBe(200);
      expect(
        (
          await t
            .http()
            .post(ruta(id, '/devolver'))
            .set(gerente())
            .send({ observacion: 'otra vez' })
        ).status,
      ).toBe(409);
    });

    it('cierra y la deja con quién y cuándo; el evento trae los insumos del dashboard', async () => {
      const id = await lista();
      await t
        .http()
        .put(ruta(id, '/incidente'))
        .set(tecnico())
        .send({ zona: 'rural', danosMateriales: 'Eslinga dañada' });
      await t.http().post(ruta(id, '/enviar-revision')).set(tecnico());
      const r = await t.http().post(ruta(id, '/cerrar')).set(gerente());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ estado: 'cerrada', cerradaPor: GERENTE.nombre });
      expect(r.body.cerradaAt).toBeTruthy();
      const ev = await eventos('qhse.investigacion.cerrada', id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({
        estado: 'cerrada',
        resultado: 'near_miss',
        conclusion: 'incidente',
        involucraLesionado: false,
      });
      expect((await t.http().post(ruta(id, '/cerrar')).set(gerente())).status).toBe(409);
      expect(r.body.plazos.finalVencido).toBe(false);
    });

    it('si la notificación legal es obligatoria, no cierra sin las dos fechas', async () => {
      const id = await lista('leve');
      await t
        .http()
        .put(ruta(id, '/notificacion-legal'))
        .set(tecnico())
        .send({
          requerida: true,
          ministerioTrabajoNotificadoAt: new Date(Date.now() - 2 * H).toISOString(),
        });
      await t.http().post(ruta(id, '/enviar-revision')).set(tecnico());
      const d = await detalle(id);
      expect(d.cierre.pendientesParaCierre).toEqual(['Registre cuándo se notificó al IESS']);
      const r = await t.http().post(ruta(id, '/cerrar')).set(gerente());
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/IESS/);
      expect((await detalle(id)).estado).toBe('en_revision');
    });
  });

  describe('una investigación cerrada o en revisión queda congelada', () => {
    it('en revisión ya no se edita ninguna sección; las acciones siguen avanzando', async () => {
      const id = await enRevision();
      const putVarios: Array<[string, Record<string, unknown>]> = [
        ['/porques', { porques: [] }],
        ['/ishikawa', { causas: [] }],
        ['/causas', { causas: [] }],
        ['/equipo', { miembros: [] }],
        ['/testigos', { testigos: [] }],
        ['/entorno', { factores: [] }],
        ['/evidencias', { evidenciasRecopiladas: 'x' }],
        ['/conclusion', { conclusion: 'accidente' }],
        ['/notificacion-legal', { requerida: false }],
        ['/incidente', { zona: 'urbana' }],
      ];
      for (const [seccion, cuerpo] of putVarios) {
        const r = await t.http().put(ruta(id, seccion)).set(tecnico()).send(cuerpo);
        expect([seccion, r.status]).toEqual([seccion, 409]);
      }
      const nueva = await accion(id);
      expect(nueva.status).toBe(409);
      const a = (await detalle(id)).acciones[0];
      expect(
        (
          await t
            .http()
            .post(ruta(id, `/acciones/${a.id}/implementar`))
            .set(tecnico())
            .send({})
        ).status,
      ).toBe(201);
    });

    it('cerrada: nada de la investigación cambia, pero el seguimiento de sus acciones continúa', async () => {
      const id = await enRevision();
      await t.http().post(ruta(id, '/cerrar')).set(gerente());
      expect(
        (
          await t
            .http()
            .put(ruta(id, '/evidencias'))
            .set(tecnico())
            .send({ evidenciasRecopiladas: 'x' })
        ).status,
      ).toBe(409);
      expect((await t.http().post(ruta(id, '/enviar-revision')).set(tecnico())).status).toBe(409);
      expect(
        (await t.http().post(ruta(id, '/devolver')).set(gerente()).send({ observacion: 'x' }))
          .status,
      ).toBe(409);
      const a = (await detalle(id)).acciones[0];
      const impl = await t
        .http()
        .post(ruta(id, `/acciones/${a.id}/implementar`))
        .set(tecnico())
        .send({});
      expect(impl.status).toBe(201);
      const ver = await t
        .http()
        .post(ruta(id, `/acciones/${a.id}/verificar`))
        .set(tecnico())
        .send({ fueEficaz: true });
      expect(ver.body.acciones[0].estado).toBe('verificada');
      expect(ver.body.estado).toBe('cerrada');
      // la acción ya no se edita (contenido) aunque su seguimiento siga
      const edit = await t
        .http()
        .patch(ruta(id, `/acciones/${a.id}`))
        .set(tecnico())
        .send({ descripcion: 'x' });
      expect(edit.status).toBe(409);
    });
  });

  describe('reglas de la base', () => {
    it('no se saltan estados ni se vuelve atrás desde cerrada; la base exige lo mismo que el servicio', async () => {
      const id = await enCurso();
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'cerrada' WHERE id = $1", [id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      // enviar a revisión sin los 5 Porqués, la conclusión o una acción
      await expect(
        sql(
          "UPDATE qhse.investigacion SET estado = 'en_revision', revision_enviada_at = now(), revision_enviada_por = $2 WHERE id = $1",
          [id, TECNICO.id],
        ),
      ).rejects.toThrow(/5 niveles de los 5 Porqués/);
      await cincoPorques(id);
      await expect(
        sql(
          "UPDATE qhse.investigacion SET estado = 'en_revision', revision_enviada_at = now(), revision_enviada_por = $2 WHERE id = $1",
          [id, TECNICO.id],
        ),
      ).rejects.toThrow(/conclusión/);
      await conclusion(id);
      await expect(
        sql(
          "UPDATE qhse.investigacion SET estado = 'en_revision', revision_enviada_at = now(), revision_enviada_por = $2 WHERE id = $1",
          [id, TECNICO.id],
        ),
      ).rejects.toThrow(/al menos una acción/);
    });

    it('en revisión y cerrada, cada estado trae sus datos y una cerrada no se toca ni con el rol migrador', async () => {
      const id = await enRevision();
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'cerrada' WHERE id = $1", [id]),
      ).rejects.toThrow(/investigacion_estado_check/);
      await t.http().post(ruta(id, '/cerrar')).set(gerente());
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'en_investigacion' WHERE id = $1", [id]),
      ).rejects.toThrow(/cerrada y no admite cambios/);
      await expect(
        sql("UPDATE qhse.investigacion SET lecciones_aprendidas = 'x' WHERE id = $1", [id]),
      ).rejects.toThrow(/cerrada y no admite cambios/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_porque (id, investigacion_id, orden, pregunta, respuesta, created_by) VALUES ($1, $2, 9, 'p', 'r', $3)",
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/ya no admite cambios/);
      await expect(
        sql('DELETE FROM qhse.investigacion_porque WHERE investigacion_id = $1', [id]),
      ).rejects.toThrow(/ya no admite cambios/);
    });

    it('la notificación legal: sus fechas solo con la obligación marcada, y no se cierra incompleta', async () => {
      const id = await enCurso('leve');
      await expect(
        sql('UPDATE qhse.investigacion SET iess_notificado_at = now() WHERE id = $1', [id]),
      ).rejects.toThrow(/investigacion_notificacion_check/);
      await cincoPorques(id);
      await conclusion(id);
      await accion(id);
      await sql('UPDATE qhse.investigacion SET notificacion_legal_requerida = true WHERE id = $1', [
        id,
      ]);
      await t.http().post(ruta(id, '/enviar-revision')).set(tecnico());
      await expect(
        sql(
          "UPDATE qhse.investigacion SET estado = 'cerrada', cerrada_at = now(), cerrada_por = $2 WHERE id = $1",
          [id, GERENTE.id],
        ),
      ).rejects.toThrow(/notificación legal es obligatoria/);
    });

    it('la FK de la actividad IPERC y la aplicación no cambia lo que no le toca', async () => {
      const id = await enCurso();
      await expect(
        sql('UPDATE qhse.investigacion SET iperc_actividad_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/investigacion_iperc_actividad_fkey/);
      const t0 = (await sql('SELECT created_by FROM qhse.investigacion WHERE id = $1', [id]))
        .rows[0];
      await expect(
        t.prisma.investigacion.updateMany({ where: { id }, data: { createdBy: GERENTE.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      expect(t0.created_by).toBe(TECNICO.id);
    });
  });
});
