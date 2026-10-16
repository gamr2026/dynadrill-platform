/**
 * Integración real: Postgres (PgBouncer, app_plataforma) y Azurite (almacenamiento de objetos); antivirus simulado.
 *   npm run infra:up && npm run db:migrate:archivos && npm run db:seed:archivos
 *   RUN_INTEGRATION=1 npx nx test archivos
 * Los archivos de prueba se eliminan al final con dyn_migrator (la aplicación solo hace baja lógica).
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import {
  ArchivosModule,
  archivosEnvSchema,
  FileStoragePort,
  FirmaVerificadorPort,
  ScannerPort,
} from './index';
import type { VerificacionFirma, VerificacionFirmaElectronica } from './ports';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const MODULO = 'pedido_documento';
const ACTOR = uuidv7();
const OTRO = uuidv7();
/** Cuentas reales: quién creó, modificó o subió cada registro es FK a `identidad.usuario`. */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: ACTOR, nombre: 'Actor de prueba', rol: 'superadmin' },
    { id: OTRO, nombre: 'Otro de prueba', rol: 'facturacion' },
  ],
};

/** Antivirus simulado: rechaza lo que contenga la cadena de prueba EICAR. */
class EscanerFalso extends ScannerPort {
  caido = false;
  async escanear(contenido: Buffer) {
    if (this.caido) throw new Error('clamd caído');
    return contenido.includes('EICAR-TEST')
      ? { limpio: false, amenaza: 'Eicar-Test' }
      : { limpio: true };
  }
}

/** Servicio de firmas simulado: registra qué recibió y responde lo que se le indique. */
class VerificadorFalso extends FirmaVerificadorPort {
  activo = true;
  falla = false;
  recibidoElectronica: { bytes: number; nombre: string } | null = null;
  recibido: { bytes: number; nombre: string; mime: string; nombreEsperado?: string } | null = null;
  disponible() {
    return this.activo;
  }
  async verificarFirmaElectronica(
    contenido: Buffer,
    nombre: string,
  ): Promise<VerificacionFirmaElectronica> {
    if (this.falla) throw new Error('servicio caído con detalle interno');
    this.recibidoElectronica = { bytes: contenido.length, nombre };
    return {
      estado: 'firmantes_no_verificados',
      resumen: '1 de 1 firmantes no verificados',
      revocacion: 'no_verificada',
      duracionMs: 30,
      firmas: [
        {
          campo: 'Signature1',
          integridad: 'intacto',
          firmaValida: true,
          documentoIntacto: true,
          firmanteNombre: 'Fabiola Facturación',
          firmanteIdentificacion: '1712345678',
          firmanteCorreo: null,
          emisor: 'Security Data',
          fechaFirma: '2026-11-03T10:00:00-05:00',
          origenFecha: 'declarada_por_el_firmante',
          vigenteAlFirmar: true,
          cadenaReconocida: false,
          entidad: null,
          firmanteVerificado: false,
          conclusion: 'Íntegra, pero la cadena no llega a una raíz cargada',
          advertencias: [],
        },
      ],
    };
  }
  async verificar(
    contenido: Buffer,
    nombre: string,
    mime: string,
    p: { nombreEsperado?: string },
  ): Promise<VerificacionFirma> {
    if (this.falla) throw new Error('servicio caído con detalle interno');
    this.recibido = { bytes: contenido.length, nombre, mime, nombreEsperado: p.nombreEsperado };
    return {
      resultado: 'firma_detectada',
      confianza: 0.9,
      nombreCoincide: p.nombreEsperado ? true : null,
      firmaElectronica: false,
      observaciones: [],
      paginasAnalizadas: 1,
      duracionMs: 12,
    };
  }
}

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('contenido de prueba '.repeat(20)),
]);

run('archivos (Azurite y base de datos reales)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let almacen: FileStoragePort;
  const escaner = new EscanerFalso();
  const verificador = new VerificadorFalso();
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const bearer = (sub: string, permissions: string[]) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: 'it@test.local', roleId: 'r', roleCode: 'operador', permissions })}`,
  });
  const editor = () => bearer(ACTOR, ['comercial.pedidos.editar', 'comercial.pedidos.ver']);
  const lector = () => bearer(OTRO, ['comercial.pedidos.ver']);
  const sinPermisos = () => bearer(OTRO, []);
  const subir = (
    cuerpo: Buffer,
    nombre = 'orden.pdf',
    tipo = 'application/pdf',
    modulo = MODULO,
    cab = editor(),
  ) =>
    http()
      .post('/api/archivos')
      .set(cab)
      .field('modulo', modulo)
      .attach('archivo', cuerpo, { filename: nombre, contentType: tipo });
  const creados: string[] = [];

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'archivos-test',
      PORT: '3197',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      JWT_PUBLIC_KEY: publicKey,
      ARCHIVOS_CONTAINER: 'archivos-test',
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
    });
    const envSchema = defineEnv(
      baseEnvSchema,
      databaseEnvSchema,
      jwtVerifyEnvSchema,
      rabbitEnvSchema,
      archivosEnvSchema,
    );

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'archivos-test' }),
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        ArchivosModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(ScannerPort)
      .useValue(escaner)
      .overrideProvider(FirmaVerificadorPort)
      .useValue(verificador)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
    almacen = app.get(FileStoragePort);
  });

  afterAll(async () => {
    if (creados.length) {
      await admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [creados]);
    }
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app?.close();
  });

  it('sube un PDF: guarda el contenido en el almacenamiento y su registro con la huella SHA-256', async () => {
    const r = await subir(PDF).expect(201);
    creados.push(r.body.id);
    expect(r.body).toMatchObject({
      modulo: MODULO,
      nombre: 'orden.pdf',
      mimeType: 'application/pdf',
      tamanoBytes: PDF.length,
      sha256: createHash('sha256').update(PDF).digest('hex'),
      escaneado: true,
      subidoPor: ACTOR,
    });
    const fila = await prisma.archivo.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(fila.blobKey).toMatch(new RegExp(`^${MODULO}/\\d{4}/\\d{2}/${r.body.id}$`));
    const flujo = await almacen.leer(fila.blobKey);
    const trozos: Buffer[] = [];
    for await (const t of flujo) trozos.push(t as Buffer);
    expect(Buffer.concat(trozos).equals(PDF)).toBe(true);
  });

  it('se descarga con los mismos bytes y encabezados seguros; los metadatos también se leen', async () => {
    const id = creados[0];
    const d = await http()
      .get(`/api/archivos/${id}/contenido`)
      .set(lector())
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect((d.body as Buffer).equals(PDF)).toBe(true);
    expect(d.headers['content-type']).toContain('application/pdf');
    expect(d.headers['content-disposition']).toContain("attachment; filename*=UTF-8''orden.pdf");
    expect(d.headers['x-content-type-options']).toBe('nosniff');
    const m = await http().get(`/api/archivos/${id}`).set(lector()).expect(200);
    expect(m.body).toMatchObject({ id, nombre: 'orden.pdf' });
  });

  it('exige el permiso que el módulo fija: subir pide el de editar, ver/descargar el de ver', async () => {
    await subir(PDF, 'x.pdf', 'application/pdf', MODULO, lector()).expect(403);
    await http().get(`/api/archivos/${creados[0]}/contenido`).set(sinPermisos()).expect(403);
    await http().get(`/api/archivos/${creados[0]}`).set(sinPermisos()).expect(403);
    await http().get(`/api/archivos/${creados[0]}`).expect(401);
  });

  it('rechaza lo que no cumple: módulo inexistente, tipo no admitido, vacío, firma que no corresponde, demasiado grande', async () => {
    await subir(PDF, 'x.pdf', 'application/pdf', 'no_existe').expect(400);
    await subir(Buffer.from('MZ ejecutable'), 'virus.exe', 'application/x-msdownload').expect(415);
    await subir(Buffer.alloc(0), 'vacio.pdf').expect(400);
    // dice ser PDF pero no lo es
    const falso = await subir(Buffer.from('esto no es un pdf'), 'falso.pdf').expect(422);
    expect(falso.body.detail).toContain('no corresponde a su tipo');
    // más de 25 MB (el máximo del módulo)
    const grande = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024, 1)]);
    await subir(grande, 'grande.pdf').expect(413);
    await http().post('/api/archivos').set(editor()).field('modulo', MODULO).expect(400); // sin archivo
  });

  it('un archivo con malware no se guarda; si el antivirus falla se rechaza (falla cerrada)', async () => {
    const antes = await prisma.archivo.count();
    const infectado = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('EICAR-TEST')]);
    const r = await subir(infectado, 'eicar.pdf').expect(422);
    expect(r.body.detail).toContain('antivirus');
    escaner.caido = true;
    await subir(PDF, 'ok.pdf').expect(503);
    escaner.caido = false;
    expect(await prisma.archivo.count()).toBe(antes);
  });

  it('el nombre se limpia de rutas (el archivo se guarda con una clave propia, nunca con su nombre)', async () => {
    const r = await subir(PDF, '..\\..\\etc\\passwd.pdf').expect(201);
    creados.push(r.body.id);
    expect(r.body.nombre).toBe('passwd.pdf');
  });

  it('verifica la firma de un archivo con el servicio de firmas: le envía el contenido y devuelve el resultado normalizado', async () => {
    const r = await subir(PDF, 'firmado.pdf').expect(201);
    creados.push(r.body.id);
    const v = await http()
      .post(`/api/archivos/${r.body.id}/verificar-firma`)
      .set(lector())
      .send({ nombreEsperado: 'Carlos Company Man' })
      .expect(201);
    expect(v.body).toEqual({
      resultado: 'firma_detectada',
      confianza: 0.9,
      nombreCoincide: true,
      firmaElectronica: false,
      observaciones: [],
      paginasAnalizadas: 1,
      duracionMs: 12,
    });
    expect(verificador.recibido).toEqual({
      bytes: PDF.length,
      nombre: 'firmado.pdf',
      mime: 'application/pdf',
      nombreEsperado: 'Carlos Company Man',
    });
    // exige el permiso de ver del módulo
    await http()
      .post(`/api/archivos/${r.body.id}/verificar-firma`)
      .set(sinPermisos())
      .send({})
      .expect(403);
    await http().post(`/api/archivos/${r.body.id}/verificar-firma`).send({}).expect(401);
    await http()
      .post(`/api/archivos/${r.body.id}/verificar-firma`)
      .set(lector())
      .send({ nombreEsperado: 'x'.repeat(201) })
      .expect(400);
  });

  it('valida la firma electrónica de un PDF con el servicio de firmas; solo PDF, con permiso y sin filtrar detalles al fallar', async () => {
    const r = await subir(PDF, 'firmado.pdf').expect(201);
    creados.push(r.body.id);
    const url = `/api/archivos/${r.body.id}/verificar-firma-electronica`;
    const v = await http().post(url).set(lector()).expect(201);
    expect(v.body).toMatchObject({
      estado: 'firmantes_no_verificados',
      revocacion: 'no_verificada',
    });
    expect(v.body.firmas[0]).toMatchObject({
      firmaValida: true,
      firmanteIdentificacion: '1712345678',
      firmanteVerificado: false,
    });
    expect(verificador.recibidoElectronica).toEqual({ bytes: PDF.length, nombre: 'firmado.pdf' });
    await http().post(url).set(sinPermisos()).expect(403);
    await http().post(url).expect(401);
    // una imagen no lleva firma digital
    const png = await subir(Buffer.from('89504e470d0a1a0a0000', 'hex'), 'firma.png', 'image/png');
    if (png.status === 201) {
      creados.push(png.body.id);
      await http()
        .post(`/api/archivos/${png.body.id}/verificar-firma-electronica`)
        .set(lector())
        .expect(400);
    }
    verificador.falla = true;
    const falla = await http().post(url).set(lector()).expect(503);
    expect(JSON.stringify(falla.body)).not.toContain('detalle interno');
    verificador.falla = false;
  });

  it('si el servicio de firmas no está o falla, responde 503 sin filtrar detalles internos', async () => {
    const r = await subir(PDF, 'otro.pdf').expect(201);
    creados.push(r.body.id);
    verificador.activo = false;
    const sin = await http()
      .post(`/api/archivos/${r.body.id}/verificar-firma`)
      .set(lector())
      .send({})
      .expect(503);
    expect(sin.body.detail).toContain('no está disponible');
    verificador.activo = true;
    verificador.falla = true;
    const falla = await http()
      .post(`/api/archivos/${r.body.id}/verificar-firma`)
      .set(lector())
      .send({})
      .expect(503);
    expect(JSON.stringify(falla.body)).not.toContain('detalle interno');
    verificador.falla = false;
  });

  it('la baja es lógica: el archivo deja de ser accesible pero su registro y contenido quedan; el registro es inmutable', async () => {
    const r = await subir(PDF, 'baja.pdf').expect(201);
    creados.push(r.body.id);
    await http().delete(`/api/archivos/${r.body.id}`).set(lector()).expect(403); // solo con permiso de editar
    await http().delete(`/api/archivos/${r.body.id}`).set(editor()).expect(200);
    await http().get(`/api/archivos/${r.body.id}`).set(editor()).expect(404);
    await http().get(`/api/archivos/${r.body.id}/contenido`).set(editor()).expect(404);
    const fila = await prisma.archivo.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(fila.eliminadoAt).not.toBeNull();
    expect(fila.eliminadoPor).toBe(ACTOR);
    // la aplicación no puede cambiar otras columnas del registro
    await expect(
      prisma.archivo.update({ where: { id: r.body.id }, data: { nombreOriginal: 'otro.pdf' } }),
    ).rejects.toThrow();
  });
});
