/**
 * Integración real de QHSE: requisitos legales (revisiones, vigencia y documento por el servicio de archivos), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest requisitos-legales   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse` y `npm run db:seed:archivos`)
 *
 * Las pruebas usan tipos propios de requisito legal para no reemplazar las revisiones reales de «ambiente» y «sst».
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const n = Date.now();

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const MAESTROS: MaestrosDePrueba = { usuarios: [{ ...TECNICO, rol: 'tecnico_hse' }] };

type Salida = { datos: { data: Record<string, unknown> } };
const fechaEn = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: requisitos legales (base de datos real)', () => {
  jest.setTimeout(240000);
  let t: AppDePrueba;
  const modulo: Record<string, string> = {};
  const tipo = { a: uuidv7(), b: uuidv7(), c: uuidv7() };
  const archivos: string[] = [];
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const gestor = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.LEGAL_VER, P.LEGAL_GESTIONAR], TECNICO.id);
  const soloVer = () => t.token('tecnico_hse', TECNICO.nombre, [P.LEGAL_VER], TECNICO.id);
  const sinPermiso = () => t.token('operador', 'Oscar Operador', [P.QHSE_REPORTAR], uuidv7());

  /** Un archivo ya subido por el módulo de archivos, como lo deja `POST /api/archivos`. */
  const archivo = async (codigoModulo = 'qhse_requisito_legal') => {
    const id = uuidv7();
    archivos.push(id);
    await sql(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'matriz.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        id,
        modulo[codigoModulo],
        id.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/${n}/${id}`,
        TECNICO.id,
      ],
    );
    return id;
  };
  const registrar = async (cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
    t
      .http()
      .post('/api/qhse/legal')
      .set(quien)
      .send({
        tipoId: tipo.a,
        revision: `Rev. ${uuidv7().slice(-6)}`,
        fechaAprobacion: fechaEn(-5),
        archivoId: await archivo(),
        ...cuerpo,
      });
  const eventos = async (id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = 'qhse.requisito_legal.registrado' AND datos->'data'->>'requisitoLegalId' = $1",
        [id],
      )
    ).rows as Salida[];
  const grupo = async (id: string) =>
    (await t.http().get('/api/qhse/legal').set(soloVer())).body.find(
      (g: { tipo: { id: string } }) => g.tipo.id === id,
    );

  beforeAll(async () => {
    t = await levantarAppDePrueba('3183');
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await sql(
      "SELECT id, codigo FROM archivos.modulo_archivo WHERE codigo IN ('qhse_requisito_legal','qhse_documento_pedido')",
    );
    for (const f of r.rows as Array<{ id: string; codigo: string }>) modulo[f.codigo] = f.id;
    // si falla aquí, falta correr `npm run db:seed:archivos`
    expect(Object.keys(modulo)).toHaveLength(2);
    for (const [k, id] of Object.entries(tipo))
      await sql(
        'INSERT INTO qhse.requisito_legal_tipo (id, codigo, nombre, orden, created_by) VALUES ($1, $2, $3, $4, $5)',
        [
          id,
          `prueba-${k}-${n}`,
          `Tipo de prueba ${k}`,
          800000 + (n % 90000) + ['a', 'b', 'c'].indexOf(k),
          TECNICO.id,
        ],
      );
  });

  afterAll(async () => {
    await sql('DELETE FROM qhse.requisito_legal WHERE tipo_id = ANY($1::uuid[])', [
      [tipo.a, tipo.b, tipo.c],
    ]);
    await sql('DELETE FROM qhse.requisito_legal_tipo WHERE id = ANY($1::uuid[])', [
      [tipo.a, tipo.b, tipo.c],
    ]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo = 'qhse.requisito_legal.registrado' AND datos->'actor'->>'userId' = $1",
      [TECNICO.id],
    );
    await sql('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('catálogo y registro', () => {
    it('los dos tipos de la demo (Ambiente y SST) están sembrados', async () => {
      const r = await t.http().get('/api/qhse/legal/tipos').set(soloVer());
      const codigos = r.body.map((x: { codigo: string }) => x.codigo);
      expect(codigos).toEqual(expect.arrayContaining(['ambiente', 'sst']));
    });

    it('registra la primera revisión de un tipo: queda vigente, con su documento, y publica el evento', async () => {
      const r = await registrar({ revision: 'Rev. 01', vigenteHasta: fechaEn(200) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        tipo: { id: tipo.a },
        revision: 'Rev. 01',
        estado: 'vigente',
        estadoVigencia: 'vigente',
        registradoPor: TECNICO.nombre,
      });
      expect(r.body.archivoId).toBeTruthy();
      const ev = await eventos(r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ revision: 'Rev. 01', reemplazaId: null });
    });

    it('una revisión nueva reemplaza a la vigente del mismo tipo (queda como historia) y no toca a otro tipo', async () => {
      const otro = await registrar({ tipoId: tipo.b, revision: 'B-1' });
      const anterior = (await grupo(tipo.a)).vigente;
      const r = await registrar({ revision: 'Rev. 02' });
      expect(r.status).toBe(201);
      const g = await grupo(tipo.a);
      expect(g.vigente).toMatchObject({ id: r.body.id, revision: 'Rev. 02' });
      const vieja = g.revisiones.find((x: { id: string }) => x.id === anterior.id);
      expect(vieja).toMatchObject({
        estado: 'reemplazado',
        reemplazadoPor: TECNICO.nombre,
        estadoVigencia: null,
      });
      expect(vieja.reemplazadoAt).toBeTruthy();
      expect(g.revisiones.map((x: { revision: string }) => x.revision)).toEqual([
        'Rev. 02',
        'Rev. 01',
      ]);
      expect((await eventos(r.body.id))[0].datos.data).toMatchObject({ reemplazaId: anterior.id });
      expect((await grupo(tipo.b)).vigente.id).toBe(otro.body.id);
    });

    it('la vigencia se evalúa sobre la revisión que rige: sin vencimiento, vigente, por vencer o vencida', async () => {
      const sin = await registrar({ revision: 'V-sin' });
      expect(sin.body).toMatchObject({ estadoVigencia: 'sin_vencimiento', diasParaVencer: null });
      const ok = await registrar({ revision: 'V-ok', vigenteHasta: fechaEn(90) });
      expect(ok.body).toMatchObject({ estadoVigencia: 'vigente', diasParaVencer: 90 });
      const pronto = await registrar({ revision: 'V-pronto', vigenteHasta: fechaEn(30) });
      expect(pronto.body).toMatchObject({ estadoVigencia: 'por_vencer', diasParaVencer: 30 });
      const vencida = await registrar({
        revision: 'V-vencida',
        fechaAprobacion: fechaEn(-400),
        vigenteHasta: fechaEn(-1),
      });
      expect(vencida.body).toMatchObject({ estadoVigencia: 'vencido', diasParaVencer: -1 });
      expect((await grupo(tipo.a)).vigente.estadoVigencia).toBe('vencido');
    });

    it('rechaza lo inválido: revisión vacía, fecha futura, vigencia anterior a la aprobación, tipo inexistente', async () => {
      expect((await registrar({ revision: '  ' })).status).toBe(400);
      expect((await registrar({ fechaAprobacion: fechaEn(3) })).body.message).toMatch(/futura/);
      expect(
        (await registrar({ fechaAprobacion: fechaEn(-2), vigenteHasta: fechaEn(-9) })).body.message,
      ).toMatch(/antes de la fecha de aprobación/);
      expect((await registrar({ tipoId: uuidv7() })).body.message).toMatch(
        /tipo de requisito legal/,
      );
      expect((await registrar({ fechaAprobacion: '2026-13-45' })).status).toBe(400);
    });

    it('el documento debe existir y haberse subido como requisito legal (no el de otro módulo)', async () => {
      expect((await registrar({ archivoId: uuidv7() })).body.message).toMatch(/no existe/);
      const ajeno = await archivo('qhse_documento_pedido');
      expect((await registrar({ archivoId: ajeno })).body.message).toMatch(
        /no se subió como requisito legal/,
      );
      const eliminado = await archivo();
      await sql(
        'UPDATE archivos.archivo SET eliminado_at = now(), eliminado_por = $2 WHERE id = $1',
        [eliminado, TECNICO.id],
      );
      expect((await registrar({ archivoId: eliminado })).body.message).toMatch(/no existe/);
    });

    it('no se repite una revisión del mismo tipo ni se reutiliza un documento; una falla no deja la anterior reemplazada', async () => {
      const antes = (await grupo(tipo.b)).vigente;
      const dup = await registrar({ tipoId: tipo.b, revision: antes.revision });
      expect(dup.status).toBe(409);
      expect(dup.body.message).toMatch(/Ya existe la revisión/);
      const mismoDoc = await registrar({
        tipoId: tipo.b,
        revision: 'B-2',
        archivoId: antes.archivoId,
      });
      expect(mismoDoc.status).toBe(409);
      expect(mismoDoc.body.message).toMatch(/ya está registrado/);
      expect((await grupo(tipo.b)).vigente.id).toBe(antes.id);
    });

    it('solo quien gestiona registra; quien solo ve consulta; quien no tiene permiso no entra', async () => {
      expect((await registrar({}, soloVer())).status).toBe(403);
      expect((await t.http().get('/api/qhse/legal').set(sinPermiso())).status).toBe(403);
      expect((await t.http().get('/api/qhse/legal').set(soloVer())).status).toBe(200);
      expect((await t.http().get(`/api/qhse/legal/${uuidv7()}`).set(soloVer())).status).toBe(404);
    });
  });

  describe('reglas de la base', () => {
    const insertar = async (extra: Record<string, unknown> = {}) => {
      const v = {
        id: uuidv7(),
        tipo_id: tipo.b,
        revision: `DB-${uuidv7().slice(-6)}`,
        fecha_aprobacion: '2026-01-01',
        vigente_hasta: null,
        archivo_id: await archivo(),
        estado: 'vigente',
        reemplazado_at: null,
        reemplazado_por: null,
        ...extra,
      };
      return sql(
        `INSERT INTO qhse.requisito_legal (id, tipo_id, revision, fecha_aprobacion, vigente_hasta, archivo_id, estado, reemplazado_at, reemplazado_por, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::qhse.estado_requisito_legal, $8, $9, $10)`,
        [
          v.id,
          v.tipo_id,
          v.revision,
          v.fecha_aprobacion,
          v.vigente_hasta,
          v.archivo_id,
          v.estado,
          v.reemplazado_at,
          v.reemplazado_por,
          TECNICO.id,
        ],
      );
    };

    it('una sola vigente por tipo, nace vigente y cada estado trae sus datos', async () => {
      await expect(insertar()).rejects.toThrow(/requisito_legal_vigente_key/);
      await expect(
        insertar({
          estado: 'reemplazado',
          reemplazado_at: new Date(),
          reemplazado_por: TECNICO.id,
        }),
      ).rejects.toThrow(/nace vigente/);
      await expect(insertar({ reemplazado_at: new Date() })).rejects.toThrow(
        /requisito_legal_estado_check/,
      );
    });

    it('revisión no vacía, vigencia coherente, documento existente y único', async () => {
      await expect(insertar({ tipo_id: tipo.c, revision: ' ' })).rejects.toThrow(
        /requisito_legal_revision_check/,
      );
      await expect(insertar({ tipo_id: tipo.c, vigente_hasta: '2025-12-31' })).rejects.toThrow(
        /requisito_legal_vigencia_check/,
      );
      await expect(insertar({ tipo_id: tipo.c, archivo_id: uuidv7() })).rejects.toThrow(
        /requisito_legal_archivo_fkey/,
      );
      const vigente = (await grupo(tipo.a)).vigente;
      await expect(insertar({ tipo_id: tipo.c, archivo_id: vigente.archivoId })).rejects.toThrow(
        /requisito_legal_archivo_key/,
      );
    });

    it('una revisión registrada no se modifica y no vuelve a vigente después de reemplazada', async () => {
      const g = await grupo(tipo.a);
      const vigente = g.vigente;
      const vieja = g.revisiones.find((x: { estado: string }) => x.estado === 'reemplazado');
      for (const col of [
        "revision = 'otra'",
        "fecha_aprobacion = '2020-01-01'",
        "vigente_hasta = '2030-01-01'",
      ])
        await expect(
          sql(`UPDATE qhse.requisito_legal SET ${col} WHERE id = $1`, [vigente.id]),
        ).rejects.toThrow(/no se modifica/);
      await expect(
        sql(
          "UPDATE qhse.requisito_legal SET estado = 'vigente', reemplazado_at = NULL, reemplazado_por = NULL WHERE id = $1",
          [vieja.id],
        ),
      ).rejects.toThrow(/Cambio de estado no permitido|requisito_legal_vigente_key/);
    });

    it('la aplicación no borra revisiones ni reescribe lo registrado', async () => {
      const vigente = (await grupo(tipo.a)).vigente;
      await expect(
        t.prisma.requisitoLegal.deleteMany({ where: { id: vigente.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.requisitoLegal.updateMany({ where: { id: vigente.id }, data: { revision: 'x' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.requisitoLegal.updateMany({
          where: { id: vigente.id },
          data: { archivoId: uuidv7() },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });
  });
});
