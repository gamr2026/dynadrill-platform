/**
 * API de consulta y verificación de firmas contra PostgreSQL real: historia por documento, vigencia, verificación y permisos.
 *   RUN_INTEGRATION=1 npx nx test firmas
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { FirmasConsumer } from './consumers/firmas.consumer';
import { PrismaService } from './prisma/prisma.service';
import { arrancarApp, lectura, limpiar, MIGRATOR_DB, sobre } from './testing/arranque';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const HASH = 'e'.repeat(64);

run('firmas: consulta y verificación (base de datos real)', () => {
  jest.setTimeout(60000);
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const eventos: string[] = [];
  const archivoId = uuidv7();
  const documentoId = uuidv7();
  let app: INestApplication;
  let consumer: FirmasConsumer;
  let prisma: PrismaService;
  let usuarioId = '';
  let ver: string;
  let verificar: string;
  let sinPermiso: string;
  const http = () => request(app.getHttpServer());
  const consulta = (q = `documentoTipo=qhse_ptw&documentoId=${documentoId}`) =>
    http().get(`/api/firmas?${q}`).set('Authorization', `Bearer ${ver}`);

  const firmar = async (data: Record<string, unknown>) => {
    const e = sobre(
      'qhse.ptw.firmado',
      documentoId,
      { documentoTipo: 'qhse_ptw', metodo: 'linea', hashDocumento: HASH, ...data },
      { actor: { userId: usuarioId, role: 'prueba' } },
    );
    eventos.push(e.id);
    await consumer.consumir(e);
    // el orden por hora del servidor necesita instantes distintos
    await new Promise((r) => setTimeout(r, 15));
    return e;
  };

  beforeAll(async () => {
    usuarioId = (await admin.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    await admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       SELECT $1::uuid, mo.id, 'ptw-firmado.pdf', 'application/pdf', 10, repeat('f', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
         FROM archivos.modulo_archivo mo WHERE mo.codigo = 'documento_respaldo_firmado'`,
      [archivoId, usuarioId],
    );
    const a = await arrancarApp('3196');
    ({ app, consumer, prisma } = a);
    ver = a.token(usuarioId, [Permission.FIRMAS_VER]);
    verificar = a.token(usuarioId, [Permission.FIRMAS_VER, Permission.FIRMAS_VERIFICAR]);
    sinPermiso = a.token(usuarioId, []);
  });

  afterAll(async () => {
    await limpiar(admin, { eventos, archivos: [archivoId] });
    await admin.end();
    await app.close();
  });

  it('exige un token y el permiso de ver firmas', async () => {
    await http().get(`/api/firmas?documentoTipo=qhse_ptw&documentoId=${documentoId}`).expect(401);
    await http()
      .get(`/api/firmas?documentoTipo=qhse_ptw&documentoId=${documentoId}`)
      .set('Authorization', `Bearer ${sinPermiso}`)
      .expect(403);
    await http()
      .post(`/api/firmas/${uuidv7()}/verificar`)
      .set('Authorization', `Bearer ${ver}`)
      .expect(403);
  });

  it('no ofrece ninguna forma de firmar ni de modificar: la firma entra solo por el evento del módulo', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete'] as const) {
      const r = await http()[metodo]('/api/firmas').set('Authorization', `Bearer ${verificar}`);
      expect(r.status).toBe(404);
    }
  });

  it('un documento sin firmas devuelve la lista vacía; un documento fuera del catálogo, 404', async () => {
    const r = await consulta().expect(200);
    expect(r.body).toEqual({ documentoTipo: 'qhse_ptw', documentoId, firmas: [] });
    await consulta(`documentoTipo=documento_inventado&documentoId=${documentoId}`).expect(404);
  });

  it('rechaza los filtros inválidos', async () => {
    await consulta('documentoTipo=qhse_ptw').expect(400);
    await consulta(`documentoTipo=qhse_ptw&documentoId=no-es-uuid`).expect(400);
    await consulta(`documentoTipo=MAL&documentoId=${documentoId}`).expect(400);
  });

  it('devuelve las firmas del documento con su historia: en cada papel vale la más reciente', async () => {
    await firmar({ rolFirmante: 'trabajador' });
    await firmar({ rolFirmante: 'talento_humano' });
    const segunda = await firmar({ rolFirmante: 'trabajador' });
    const r = await consulta().expect(200);
    const firmas = r.body.firmas as Array<{
      vigente: boolean;
      rolFirmante: { codigo: string };
      hashDocumento: string;
      firmante: { id: string };
    }>;
    expect(firmas).toHaveLength(3);
    // la más reciente primero
    expect(firmas[0].rolFirmante.codigo).toBe('trabajador');
    expect(firmas.map((f) => [f.rolFirmante.codigo, f.vigente])).toEqual([
      ['trabajador', true],
      ['talento_humano', true],
      ['trabajador', false],
    ]);
    expect(firmas[0]).toMatchObject({
      hashDocumento: HASH,
      firmante: { id: usuarioId },
      archivo: null,
      verificacion: null,
    });
    const enBase = await prisma.firma.findFirstOrThrow({ where: { eventoId: segunda.id } });
    expect(firmas[0]).toMatchObject({ id: enBase.id });
  });

  describe('verificación de la firma manuscrita', () => {
    let firmaId = '';

    beforeAll(async () => {
      const e = await firmar({
        rolFirmante: 'aprobacion',
        metodo: 'manuscrita',
        hashDocumento: undefined,
        archivoId,
      });
      firmaId = (await prisma.firma.findFirstOrThrow({ where: { eventoId: e.id } })).id;
    });

    it('guarda cada lectura como un intento más y la consulta muestra el último', async () => {
      lectura.llamadas = [];
      lectura.respuesta = { resultado: 'no_concluyente', confianza: 0.4, nombreCoincide: false };
      const a = await http()
        .post(`/api/firmas/${firmaId}/verificar`)
        .set('Authorization', `Bearer ${verificar}`)
        .expect(200);
      expect(a.body).toMatchObject({
        resultado: 'no_concluyente',
        confianza: 0.4,
        nombreCoincide: false,
        solicitadaPor: { id: usuarioId },
      });
      await new Promise((r) => setTimeout(r, 15));
      lectura.respuesta = { resultado: 'firma_detectada', confianza: 0.95, nombreCoincide: true };
      await http()
        .post(`/api/firmas/${firmaId}/verificar`)
        .set('Authorization', `Bearer ${verificar}`)
        .expect(200);
      expect(lectura.llamadas).toEqual([archivoId, archivoId]);
      expect(await prisma.firmaVerificacion.count({ where: { firmaId } })).toBe(2);
      const r = await consulta().expect(200);
      const f = r.body.firmas.find((x: { id: string }) => x.id === firmaId);
      expect(f.archivo).toMatchObject({
        id: archivoId,
        nombre: 'ptw-firmado.pdf',
        sha256: 'f'.repeat(64),
      });
      expect(f.verificacion).toMatchObject({ resultado: 'firma_detectada', confianza: 0.95 });
    });

    it('una firma de una línea no se verifica (no tiene archivo) y una firma que no existe da 404', async () => {
      const linea = await prisma.firma.findFirstOrThrow({
        where: { documentoId, metodo: 'linea' },
      });
      await http()
        .post(`/api/firmas/${linea.id}/verificar`)
        .set('Authorization', `Bearer ${verificar}`)
        .expect(409);
      await http()
        .post(`/api/firmas/${uuidv7()}/verificar`)
        .set('Authorization', `Bearer ${verificar}`)
        .expect(404);
      await http()
        .post(`/api/firmas/no-es-uuid/verificar`)
        .set('Authorization', `Bearer ${verificar}`)
        .expect(400);
    });

    it('si el servicio de lectura falla no se guarda nada', async () => {
      const antes = await prisma.firmaVerificacion.count({ where: { firmaId } });
      lectura.respuesta = new Error('servicio no disponible');
      const r = await http()
        .post(`/api/firmas/${firmaId}/verificar`)
        .set('Authorization', `Bearer ${verificar}`);
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await prisma.firmaVerificacion.count({ where: { firmaId } })).toBe(antes);
    });
  });
});
