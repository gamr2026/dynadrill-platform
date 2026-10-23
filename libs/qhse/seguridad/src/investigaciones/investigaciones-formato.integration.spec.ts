/**
 * Integración real de QHSE: investigación de incidentes (rebanada 2: formato de campo), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest investigaciones-formato   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const LESIONADO = {
  id: uuidv7(),
  nombre: 'Pedro Perforador',
  cedula: '1712345678',
  cargo: 'Operador de torre',
};
const MIEMBRO = { id: uuidv7(), nombre: 'Marta Mantenimiento' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...LESIONADO, rol: 'operador' },
    { ...MIEMBRO, rol: 'operador' },
  ],
};

run('QHSE: investigación de incidentes, formato de campo (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  let resultado: Record<string, { id: string }> = {};
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () => t.token('tecnico_hse', TECNICO.nombre, [P.INVESTIGACIONES_VER], TECNICO.id);

  const abierta = async (codigo: string) => {
    const r = await t
      .http()
      .post('/api/qhse/investigaciones')
      .set(gestor())
      .send({
        resultadoId: resultado[codigo].id,
        descripcionEvento: 'Atrapamiento de mano en la llave de fuerza',
        fechaIncidente: new Date(Date.now() - 3 * H).toISOString(),
        ubicacion: 'Locación 7',
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
  const ver = async (id: string) =>
    (await t.http().get(`/api/qhse/investigaciones/${id}`).set(soloVer())).body;

  beforeAll(async () => {
    t = await levantarAppDePrueba('3187');
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await t.http().get('/api/qhse/investigaciones/resultados').set(soloVer());
    resultado = Object.fromEntries(
      r.body.map((x: { codigo: string; id: string }) => [x.codigo, x]),
    );
  });

  afterAll(async () => {
    const ids = [TECNICO.id, LESIONADO.id, MIEMBRO.id];
    for (const tabla of [
      'investigacion_trabajador',
      'investigacion_detalle',
      'investigacion_equipo',
      'investigacion_testigo',
      'investigacion_entorno_factor',
    ])
      await sql(`DELETE FROM qhse.${tabla} WHERE created_by = ANY($1::uuid[])`, [ids]);
    await sql('DELETE FROM qhse.investigacion_historial WHERE actor_id = ANY($1::uuid[])', [ids]);
    await sql('DELETE FROM qhse.investigacion WHERE created_by = ANY($1::uuid[])', [ids]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.investigacion.%' AND datos->'actor'->>'userId' = ANY($1::text[])",
      [ids],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('trabajador involucrado', () => {
    it('con cuenta del portal: nombre, cédula y cargo salen del perfil, no se copian', async () => {
      const id = await abierta('grave');
      const r = await guardar(id, 'trabajador', {
        usuarioId: LESIONADO.id,
        sexo: 'masculino',
        tipoVinculacion: 'Relación de dependencia',
        tiempoExperienciaMeses: 18,
      });
      expect(r.status).toBe(200);
      expect(r.body.trabajador).toMatchObject({
        apellidosNombres: LESIONADO.nombre,
        cedula: LESIONADO.cedula,
        cargo: LESIONADO.cargo,
        sexo: 'masculino',
        tiempoExperienciaMeses: 18,
      });
      const fila = (
        await sql(
          'SELECT apellidos_nombres, cedula, cargo FROM qhse.investigacion_trabajador WHERE investigacion_id = $1',
          [id],
        )
      ).rows[0];
      expect(fila).toEqual({ apellidos_nombres: null, cedula: null, cargo: null });
    });

    it('persona externa: lleva sus datos; guardar de nuevo reemplaza lo anterior', async () => {
      const id = await abierta('leve');
      await guardar(id, 'trabajador', {
        apellidosNombres: 'Juan Contratista',
        cedula: '0102030405',
      });
      const r = await guardar(id, 'trabajador', {
        apellidosNombres: 'Juan Contratista Pérez',
        cedula: '0102030405',
        cargo: 'Ayudante',
      });
      expect(r.body.trabajador).toMatchObject({
        apellidosNombres: 'Juan Contratista Pérez',
        cargo: 'Ayudante',
      });
      expect(
        (await sql('SELECT 1 FROM qhse.investigacion_trabajador WHERE investigacion_id = $1', [id]))
          .rowCount,
      ).toBe(1);
    });

    it('rechaza lo incompleto, mezclar cuenta con datos copiados, una cuenta inexistente y un resultado sin lesionado', async () => {
      const id = await abierta('grave');
      expect((await guardar(id, 'trabajador', { apellidosNombres: 'Solo nombre' })).status).toBe(
        400,
      );
      expect(
        (await guardar(id, 'trabajador', { usuarioId: LESIONADO.id, cedula: '1' })).body.message,
      ).toMatch(/se toman de su perfil/);
      expect((await guardar(id, 'trabajador', { usuarioId: uuidv7() })).body.message).toMatch(
        /no existe/,
      );
      const nm = await abierta('near_miss');
      expect((await guardar(nm, 'trabajador', { usuarioId: LESIONADO.id })).body.message).toMatch(
        /no involucra a un trabajador lesionado/,
      );
    });

    it('solo quien gestiona edita; quien solo ve, no', async () => {
      const id = await abierta('grave');
      expect((await guardar(id, 'trabajador', { usuarioId: LESIONADO.id }, soloVer())).status).toBe(
        403,
      );
    });
  });

  describe('información del incidente', () => {
    it('guarda el detalle con la lesión y sus días de incapacidad (insumo del dashboard) y lo reemplaza al guardar de nuevo', async () => {
      const id = await abierta('grave');
      const r = await guardar(id, 'incidente', {
        jornadaSuceso: 'ordinaria',
        zona: 'rural',
        horaInicioJornada: '06:30',
        tiempoLaboradoPrevioHoras: 4.5,
        parteCuerpoAfectada: 'Mano derecha',
        tipoLesionSufrida: 'Aplastamiento',
        totalDiasIncapacidad: 12,
        continuaIncapacitado: true,
        sucesosSimilaresPrevios: true,
        sucesosSimilaresDetalle: 'Hace un año, misma llave',
        totalPerdidasEconomicas: 1500.5,
      });
      expect(r.status).toBe(200);
      expect(r.body.incidente).toMatchObject({
        jornadaSuceso: 'ordinaria',
        zona: 'rural',
        parteCuerpoAfectada: 'Mano derecha',
        totalDiasIncapacidad: 12,
        causoMuerte: false,
      });
      expect(r.body.incidente.horaInicioJornada).toContain('06:30');
      const otra = await guardar(id, 'incidente', { totalDiasIncapacidad: 15 });
      expect(otra.body.incidente).toMatchObject({
        totalDiasIncapacidad: 15,
        parteCuerpoAfectada: null,
      });
    });

    it('la muerte exige su fecha y viceversa; los sucesos similares se detallan solo si los hubo', async () => {
      const id = await abierta('fatal');
      expect((await guardar(id, 'incidente', { causoMuerte: true })).body.message).toMatch(
        /fecha de la muerte/,
      );
      expect((await guardar(id, 'incidente', { fechaMuerte: '2026-10-20' })).body.message).toMatch(
        /solo aplica/,
      );
      expect((await guardar(id, 'incidente', { sucesosSimilaresDetalle: 'algo' })).status).toBe(
        400,
      );
      const ok = await guardar(id, 'incidente', { causoMuerte: true, fechaMuerte: '2026-10-20' });
      expect(ok.body.incidente).toMatchObject({ causoMuerte: true });
    });

    it('un incidente sin lesionado (Near Miss) guarda su detalle pero no datos de lesión', async () => {
      const id = await abierta('near_miss');
      expect(
        (await guardar(id, 'incidente', { zona: 'urbana', danosMateriales: 'Eslinga dañada' }))
          .status,
      ).toBe(200);
      for (const lesion of [
        { totalDiasIncapacidad: 3 },
        { parteCuerpoAfectada: 'Mano' },
        { causoMuerte: true, fechaMuerte: '2026-10-20' },
        { centroMedico: 'Hospital' },
      ])
        expect((await guardar(id, 'incidente', lesion)).body.message).toMatch(
          /no lleva datos de la lesión/,
        );
    });

    it('valida rangos y formatos', async () => {
      const id = await abierta('grave');
      expect((await guardar(id, 'incidente', { horaInicioJornada: '25:00' })).status).toBe(400);
      expect((await guardar(id, 'incidente', { totalDiasIncapacidad: -1 })).status).toBe(400);
      expect((await guardar(id, 'incidente', { tiempoLaboradoPrevioHoras: 30 })).status).toBe(400);
      expect((await guardar(id, 'incidente', { zona: 'marina' })).status).toBe(400);
    });
  });

  describe('equipo, testigos, entorno y evidencias', () => {
    it('el equipo mezcla cuentas del portal y personas externas, sin repetidos, y se reemplaza completo', async () => {
      const id = await abierta('near_miss');
      const r = await guardar(id, 'equipo', {
        miembros: [{ usuarioId: MIEMBRO.id }, { nombreExterno: 'Carlos del Cliente' }],
      });
      expect(r.status).toBe(200);
      expect(r.body.equipo.map((m: { nombre: string }) => m.nombre)).toEqual([
        MIEMBRO.nombre,
        'Carlos del Cliente',
      ]);
      expect(
        (
          await guardar(id, 'equipo', {
            miembros: [{ usuarioId: MIEMBRO.id }, { usuarioId: MIEMBRO.id }],
          })
        ).body.message,
      ).toMatch(/repetidos/);
      expect(
        (
          await guardar(id, 'equipo', {
            miembros: [{ nombreExterno: 'Ana' }, { nombreExterno: ' ANA ' }],
          })
        ).status,
      ).toBe(400);
      expect((await guardar(id, 'equipo', { miembros: [{}] })).status).toBe(400);
      expect(
        (await guardar(id, 'equipo', { miembros: [{ usuarioId: uuidv7() }] })).body.message,
      ).toMatch(/no existe/);
      const vacio = await guardar(id, 'equipo', { miembros: [] });
      expect(vacio.body.equipo).toEqual([]);
    });

    it('los testigos son hasta 3, en orden, con su versión', async () => {
      const id = await abierta('near_miss');
      const tres = [1, 2, 3].map((n) => ({
        nombresApellidos: `Testigo ${n}`,
        version: `Versión ${n}`,
      }));
      const r = await guardar(id, 'testigos', { testigos: tres });
      expect(r.body.testigos.map((x: { orden: number }) => x.orden)).toEqual([1, 2, 3]);
      expect((await guardar(id, 'testigos', { testigos: [...tres, tres[0]] })).status).toBe(400);
      expect(
        (
          await guardar(id, 'testigos', {
            testigos: [{ nombresApellidos: 'Sin versión', version: ' ' }],
          })
        ).body.message,
      ).toMatch(/versión/);
      const uno = await guardar(id, 'testigos', { testigos: [tres[1]] });
      expect(uno.body.testigos).toHaveLength(1);
    });

    it('el entorno de trabajo lleva sus factores con «existe control» y «contribuyó» como sí o no', async () => {
      const id = await abierta('near_miss');
      const r = await guardar(id, 'entorno', {
        factores: [
          {
            tipo: 'Físico',
            fuente: 'Ruido de la bomba',
            existeControl: true,
            contribuyoAlSuceso: false,
          },
          {
            tipo: 'Mecánico',
            fuente: 'Llave de fuerza',
            existeControl: false,
            contribuyoAlSuceso: true,
          },
        ],
      });
      expect(r.body.entorno).toEqual([
        {
          orden: 1,
          tipo: 'Físico',
          fuente: 'Ruido de la bomba',
          existeControl: true,
          contribuyoAlSuceso: false,
        },
        {
          orden: 2,
          tipo: 'Mecánico',
          fuente: 'Llave de fuerza',
          existeControl: false,
          contribuyoAlSuceso: true,
        },
      ]);
      expect(
        (
          await guardar(id, 'entorno', {
            factores: [{ tipo: ' ', fuente: 'x', existeControl: true, contribuyoAlSuceso: true }],
          })
        ).body.message,
      ).toMatch(/tipo y su fuente/);
      expect(
        (await guardar(id, 'entorno', { factores: [{ tipo: 'a', fuente: 'b' }] })).status,
      ).toBe(400);
    });

    it('guarda las evidencias y el resumen de testimonios', async () => {
      const id = await abierta('near_miss');
      const r = await guardar(id, 'evidencias', {
        evidenciasRecopiladas: 'Fotos de la eslinga y registro de izaje',
        testimoniosResumen: 'Coinciden en que no hubo señalero',
      });
      expect(r.body).toMatchObject({
        evidenciasRecopiladas: 'Fotos de la eslinga y registro de izaje',
        testimoniosResumen: 'Coinciden en que no hubo señalero',
      });
      expect((await ver(id)).evidenciasRecopiladas).toContain('eslinga');
    });

    it('una investigación inexistente responde 404', async () => {
      expect((await guardar(uuidv7(), 'equipo', { miembros: [] })).status).toBe(404);
    });
  });

  describe('reglas de la base', () => {
    const base = async (codigo = 'grave') => abierta(codigo);

    it('trabajador: cuenta o datos propios, nunca mezclados ni vacíos', async () => {
      const id = await base();
      const ins = (cols: string, vals: unknown[]) =>
        sql(
          `INSERT INTO qhse.investigacion_trabajador (investigacion_id, created_by, ${cols}) VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`,
          [id, TECNICO.id, ...vals],
        );
      await expect(ins('usuario_id, cedula', [LESIONADO.id, '1'])).rejects.toThrow(
        /investigacion_trabajador_identidad_check/,
      );
      await expect(ins('apellidos_nombres', ['Sin cédula'])).rejects.toThrow(
        /investigacion_trabajador_identidad_check/,
      );
      await expect(ins('usuario_id, tiempo_experiencia_meses', [LESIONADO.id, -1])).rejects.toThrow(
        /investigacion_trabajador_experiencia_check/,
      );
    });

    it('la base impide trabajador y lesión en un resultado sin lesionado', async () => {
      const id = await base('near_miss');
      await expect(
        sql(
          'INSERT INTO qhse.investigacion_trabajador (investigacion_id, usuario_id, created_by) VALUES ($1, $2, $3)',
          [id, LESIONADO.id, TECNICO.id],
        ),
      ).rejects.toThrow(/no lleva datos del trabajador/);
      await expect(
        sql(
          'INSERT INTO qhse.investigacion_detalle (investigacion_id, total_dias_incapacidad, created_by) VALUES ($1, 5, $2)',
          [id, TECNICO.id],
        ),
      ).rejects.toThrow(/no lleva datos de la lesión/);
    });

    it('detalle: muerte con fecha, similares con su marca, cifras no negativas', async () => {
      const id = await base();
      const ins = (cols: string, vals: unknown[]) =>
        sql(
          `INSERT INTO qhse.investigacion_detalle (investigacion_id, created_by, ${cols}) VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`,
          [id, TECNICO.id, ...vals],
        );
      await expect(ins('causo_muerte', [true])).rejects.toThrow(
        /investigacion_detalle_muerte_check/,
      );
      await expect(ins('fecha_muerte', ['2026-10-20'])).rejects.toThrow(
        /investigacion_detalle_muerte_check/,
      );
      await expect(ins('sucesos_similares_detalle', ['x'])).rejects.toThrow(
        /investigacion_detalle_similares_check/,
      );
      await expect(ins('total_perdidas_economicas', [-1])).rejects.toThrow(
        /investigacion_detalle_cifras_check/,
      );
      await expect(ins('tiempo_laborado_previo_horas', [25])).rejects.toThrow(
        /investigacion_detalle_cifras_check/,
      );
    });

    it('equipo, testigos y entorno: integridad de cada fila', async () => {
      const id = await base('near_miss');
      await expect(
        sql(
          'INSERT INTO qhse.investigacion_equipo (id, investigacion_id, usuario_id, nombre_externo, created_by) VALUES ($1, $2, $3, $4, $5)',
          [uuidv7(), id, MIEMBRO.id, 'Y también externo', TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_equipo_miembro_check/);
      await expect(
        sql(
          'INSERT INTO qhse.investigacion_equipo (id, investigacion_id, created_by) VALUES ($1, $2, $3)',
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_equipo_miembro_check/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_testigo (id, investigacion_id, orden, nombres_apellidos, version, created_by) VALUES ($1, $2, 4, 'T', 'v', $3)",
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_testigo_orden_check/);
      await sql(
        "INSERT INTO qhse.investigacion_testigo (id, investigacion_id, orden, nombres_apellidos, version, created_by) VALUES ($1, $2, 1, 'T', 'v', $3)",
        [uuidv7(), id, TECNICO.id],
      );
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_testigo (id, investigacion_id, orden, nombres_apellidos, version, created_by) VALUES ($1, $2, 1, 'U', 'v', $3)",
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_testigo_orden_key/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_entorno_factor (id, investigacion_id, orden, tipo, fuente, existe_control, contribuyo_al_suceso, created_by) VALUES ($1, $2, 1, ' ', 'f', true, true, $3)",
          [uuidv7(), id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_entorno_factor_texto_check/);
    });

    it('privilegios mínimos: la aplicación no borra el trabajador ni el detalle, solo reemplaza las listas', async () => {
      const id = await base();
      await guardar(id, 'trabajador', { usuarioId: LESIONADO.id });
      await guardar(id, 'incidente', { totalDiasIncapacidad: 2 });
      await expect(
        t.prisma.investigacionTrabajador.deleteMany({ where: { investigacionId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionDetalle.deleteMany({ where: { investigacionId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('la auditoría de las secciones queda con quién las creó', async () => {
      const id = await base();
      await guardar(id, 'trabajador', { usuarioId: LESIONADO.id });
      const f = (
        await sql(
          'SELECT created_by FROM qhse.investigacion_trabajador WHERE investigacion_id = $1',
          [id],
        )
      ).rows[0];
      expect(f.created_by).toBe(TECNICO.id);
    });
  });
});
