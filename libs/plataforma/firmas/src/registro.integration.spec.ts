/**
 * Registro de firmas desde los eventos `*.firmado` contra PostgreSQL real (consumidor invocado sin RabbitMQ). Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx nx test firmas
 */
import { Pool } from 'pg';
import { type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { FirmasConsumer } from './consumers/firmas.consumer';
import { PrismaService } from './prisma/prisma.service';
import { arrancarApp, limpiar, MIGRATOR_DB, sobre } from './testing/arranque';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const HASH = 'c'.repeat(64);

run('firmas: registro desde eventos (base de datos real)', () => {
  jest.setTimeout(60000);
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const eventos: string[] = [];
  const archivoId = uuidv7();
  let cerrar: () => Promise<void>;
  let prisma: PrismaService;
  let consumer: FirmasConsumer;
  let usuarioId = '';

  const firmado = (data: Record<string, unknown>, extra: Partial<EventEnvelope> = {}) => {
    const e = sobre(
      'qhse.ptw.firmado',
      uuidv7(),
      {
        documentoTipo: 'qhse_ptw',
        rolFirmante: 'trabajador',
        metodo: 'linea',
        hashDocumento: HASH,
        ...data,
      },
      { actor: { userId: usuarioId, role: 'prueba' }, ...extra },
    );
    eventos.push(e.id);
    return e;
  };
  const de = (e: EventEnvelope) => prisma.firma.findMany({ where: { eventoId: e.id } });

  beforeAll(async () => {
    usuarioId = (await admin.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    await admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       SELECT $1::uuid, mo.id, 'firmado.pdf', 'application/pdf', 10, repeat('d', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
         FROM archivos.modulo_archivo mo WHERE mo.codigo = 'documento_respaldo_firmado'`,
      [archivoId, usuarioId],
    );
    const a = await arrancarApp('3197');
    ({ prisma, consumer } = a);
    cerrar = () => a.app.close();
  });

  afterAll(async () => {
    await limpiar(admin, { eventos, archivos: [archivoId] });
    await admin.end();
    await cerrar();
  });

  it('una firma «de una línea» queda con el firmante del evento, el documento, el papel, la huella y la hora del servidor', async () => {
    const e = firmado({});
    const antes = Date.now();
    await consumer.consumir(e);
    const [f] = await prisma.firma.findMany({
      where: { eventoId: e.id },
      include: { documentoTipo: true, rolFirmante: true },
    });
    expect(f).toMatchObject({
      documentoId: e.subject.id,
      firmanteId: usuarioId,
      metodo: 'linea',
      hashDocumento: HASH,
      archivoId: null,
    });
    expect(f.documentoTipo.codigo).toBe('qhse_ptw');
    expect(f.rolFirmante.codigo).toBe('trabajador');
    // la hora es la del servidor (no la que traiga el evento)
    expect(Math.abs(f.firmadaAt.getTime() - antes)).toBeLessThan(60_000);
  });

  it('una firma manuscrita o electrónica guarda el archivo firmado y no una huella propia', async () => {
    for (const metodo of ['manuscrita', 'electronica']) {
      const e = firmado({ metodo, hashDocumento: undefined, archivoId });
      await consumer.consumir(e);
      expect(await de(e)).toEqual([
        expect.objectContaining({ metodo, archivoId, hashDocumento: null }),
      ]);
    }
  });

  it('es idempotente: el mismo evento dos veces deja una sola firma', async () => {
    const e = firmado({});
    await consumer.consumir(e);
    await consumer.consumir(e);
    expect(await de(e)).toHaveLength(1);
  });

  it('una corrección es una firma nueva y la anterior se conserva', async () => {
    const documentoId = uuidv7();
    const a = firmado({ rolFirmante: 'talento_humano', documentoId });
    const b = firmado({ rolFirmante: 'talento_humano', documentoId });
    await consumer.consumir(a);
    await consumer.consumir(b);
    expect(await prisma.firma.count({ where: { eventoId: { in: [a.id, b.id] } } })).toBe(2);
  });

  const rechaza = async (e: EventEnvelope, mensaje: RegExp) => {
    await expect(consumer.consumir(e)).rejects.toThrow(mensaje);
    // el rechazo no deja ni la firma ni la marca del inbox: al corregirse el origen se puede reintentar
    expect(await de(e)).toHaveLength(0);
  };

  it('rechaza un evento sin quién firmó o con una cuenta que no existe: nadie firma por otro ni por nadie', async () => {
    await rechaza(firmado({}, { actor: undefined }), /no informa quién firmó/);
    await rechaza(
      firmado({}, { actor: { userId: uuidv7(), role: 'x' } }),
      /cuenta firmante .* no existe/,
    );
  });

  it('rechaza un documento o un papel que no están en los catálogos', async () => {
    await rechaza(
      firmado({ documentoTipo: 'documento_inventado' }),
      /no está en el catálogo de firmas/,
    );
    await rechaza(firmado({ rolFirmante: 'papel_inventado' }), /no está en el catálogo de firmas/);
  });

  it('rechaza un método inválido y una prueba que no cuadra con el método', async () => {
    await rechaza(firmado({ metodo: 'con_el_dedo' }), /metodo debe ser uno de/);
    await rechaza(firmado({ hashDocumento: 'no-es-un-hash' }), /SHA-256/);
    await rechaza(firmado({ hashDocumento: HASH.toUpperCase() }), /SHA-256/);
    await rechaza(firmado({ archivoId }), /no lleva archivo/);
    await rechaza(
      firmado({ metodo: 'manuscrita', hashDocumento: undefined }),
      /necesita el archivoId/,
    );
    await rechaza(firmado({ metodo: 'manuscrita', archivoId }), /no lleva hashDocumento/);
    await rechaza(
      firmado({ metodo: 'manuscrita', hashDocumento: undefined, archivoId: uuidv7() }),
      /no existe o fue eliminado/,
    );
  });

  it('rechaza un documentoId que no es un UUID y un evento que no es de firma', async () => {
    await rechaza(firmado({ documentoId: 'abc' }), /documentoId no es un UUID/);
    await rechaza(firmado({}, { type: 'qhse.ptw.aprobado' }), /debe terminar en «\.firmado»/);
  });
});
