/**
 * Integración real de los documentos operativos: Postgres (PgBouncer, app_comercial). Crea sus propios pedidos de
 * prueba (`it_<n>`) y los elimina al final con dyn_migrator.
 *   RUN_INTEGRATION=1 npx nx test pedidos
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission } from '@dyn/authz';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PedidosModule } from './index';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';
import { sinSuscripciones } from './testing/sin-suscripciones';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_COMERCIAL_DATABASE_URL'] ??
  'postgresql://app_comercial:dev_app_comercial@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const ACTOR = uuidv7();
const CLIENTE = uuidv7();
const BLOQUE_IT = { id: uuidv7(), nombre: `Bloque IT ${n}` };
const CAMPO_IT = { id: uuidv7(), nombre: `Campo IT ${n}` };
const POZO_NOMBRE = `ESTACION NORTE ${n}`;
const POZO_IT = { id: uuidv7(), nombre: POZO_NOMBRE, campoId: CAMPO_IT.id, bloqueId: BLOQUE_IT.id };
const PERSONA_IT = { id: uuidv7(), nombre: `Company Man IT ${n}` };
/** Registros reales que respaldan las FK (los inserta `beforeAll` y los quita `afterAll`). */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Operaciones IT', rol: 'facturacion' }],
  clientes: [{ id: CLIENTE, nombre: `Cliente IT ${n}`, ruc: `89${String(n).slice(-11)}` }],
  campos: [CAMPO_IT],
  bloques: [BLOQUE_IT],
  pozos: [POZO_IT],
};
const P = Permission;

run('documentos operativos (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const bearer = (permissions: string[]) => ({
    Authorization: `Bearer ${signer.sign({ sub: ACTOR, email: 'it@test.local', roleId: 'r', roleCode: 'facturacion', permissions })}`,
  });
  const envia = () => bearer([P.DOCUMENTOS_OPERATIVOS_ENVIAR, P.DOCUMENTOS_OPERATIVOS_VER]);
  const ve = () => bearer([P.DOCUMENTOS_OPERATIVOS_VER]);
  const elimina = () => bearer([P.DOCUMENTOS_OPERATIVOS_VER, P.DOCUMENTOS_OPERATIVOS_ELIMINAR]);
  const creados: string[] = [];

  /** Un pedido abierto de 3 días (1 al 3 de noviembre) de la línea indicada, creado directo en la base. */
  const pedido = async (linea: 'fcr' | 'pumping', estado = 'abierto') => {
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: linea } });
    const t = await prisma.tipoOt.findUniqueOrThrow({ where: { codigo: 'servicio' } });
    const id = uuidv7();
    await prisma.pedido.create({
      data: {
        id,
        codigo: `it_${n}_${creados.length}`,
        origen: 'portal',
        proceso: 'pedido',
        estado,
        lineaId: l.id,
        tipoOtId: t.id,
        clienteId: CLIENTE,
        campoId: CAMPO_IT.id,
        pozoId: POZO_IT.id,
        rigless: true,
        numeroContrato: 'CT-IT',
        fechaInicioServicio: new Date('2026-11-01T00:00:00Z'),
        fechaFinServicio: new Date('2026-11-03T00:00:00Z'),
        agenteComercialId: ACTOR,
        tecnicoHseId: ACTOR,
      },
    });
    creados.push(id);
    return id;
  };
  const job = (dia: number) => ({
    tipo: 'reporte_job',
    origen: 'fcr',
    ticketRef: 'FCR-116',
    fecha: `2026-11-0${dia}`,
    firmadoPor: 'Operador Uno',
    actividades: [
      {
        fecha: `2026-11-0${dia}`,
        horaInicio: '06:00',
        horaFin: '12:30',
        duracionHoras: 6.5,
        detalle: 'Corrida de herramienta',
        autor: 'Operador Uno',
      },
    ],
  });
  const herramientas = (usos: Array<{ fecha: string; estado: string }>) => ({
    tipo: 'reporte_herramientas',
    origen: 'fcr',
    herramientas: [{ nombre: 'Cargo básico unidad', serie: 'DY-CT-018', codigo: 'CT5104', usos }],
  });
  const estadoDe = async (id: string) =>
    (await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado;

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-docs-test',
      PORT: '3194',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    await sembrarMaestros(admin, MAESTROS);

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'comercial-docs-test' }),
        MessagingModule.forRoot({
          container: 'comercial',
          schema: 'msg_comercial',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        PedidosModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    sinSuscripciones();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (creados.length) {
      const ids = creados;
      await admin.query(
        'DELETE FROM comercial.documento_operativo WHERE pedido_id = ANY($1::uuid[])',
        [ids],
      );
      await admin.query(
        'DELETE FROM comercial.proceso_historial WHERE entidad_id = ANY($1::uuid[])',
        [ids],
      );
      await admin.query('DELETE FROM comercial.pedido WHERE id = ANY($1::uuid[])', [ids]);
    }
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('recibe un Reporte Job: guarda sus actividades y pone el pedido en elaboración operativa', async () => {
    const id = await pedido('fcr');
    const r = await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(envia())
      .send(job(1))
      .expect(201);
    expect(r.body.estadoPedido).toBe('en_elaboracion_operativa');
    expect(r.body.avance).toMatchObject({
      diasEsperados: 3,
      diasConReporteJob: 1,
      completo: false,
    });
    expect(r.body.avance.pendientes).toEqual([
      'Reporte Job de 2 día(s)',
      'el Reporte de Herramientas',
    ]);
    const lista = (
      await http().get(`/api/comercial/pedidos/${id}/documentos-operativos`).set(ve()).expect(200)
    ).body;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      tipo: 'reporte_job',
      origen: 'fcr',
      fecha: '2026-11-01',
      firmadoPor: 'Operador Uno',
    });
    expect(lista[0].actividades[0]).toMatchObject({
      horaInicio: '06:00',
      horaFin: '12:30',
      duracionHoras: 6.5,
    });
    // el seguimiento del pedido quedó con origen "automatico"
    const hist = await prisma.procesoHistorial.findMany({
      where: { entidadId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(hist.map((h) => [h.estadoNuevo, h.origen])).toEqual([
      ['en_operacion', 'automatico'],
      ['en_elaboracion_operativa', 'automatico'],
    ]);
  });

  it('enviar el mismo documento lo REEMPLAZA (idempotente)', async () => {
    const id = await pedido('fcr');
    await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(envia())
      .send(job(1))
      .expect(201);
    const otro = {
      ...job(1),
      actividades: [
        { ...job(1).actividades[0], detalle: 'Corregido' },
        {
          ...job(1).actividades[0],
          horaInicio: '13:00',
          horaFin: '15:00',
          duracionHoras: 2,
          detalle: 'Segunda',
        },
      ],
    };
    await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(envia())
      .send(otro)
      .expect(201);
    const lista = (
      await http().get(`/api/comercial/pedidos/${id}/documentos-operativos`).set(ve()).expect(200)
    ).body;
    expect(lista).toHaveLength(1);
    expect(lista[0].actividades.map((a: { detalle: string }) => a.detalle)).toEqual([
      'Corregido',
      'Segunda',
    ]);
  });

  it('con todos los reportes (3 días + herramientas) el pedido pasa solo a "documentos completos"', async () => {
    const id = await pedido('fcr');
    for (const d of [1, 2, 3]) {
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send(job(d))
        .expect(201);
    }
    expect(await estadoDe(id)).toBe('en_elaboracion_operativa');
    const r = await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(envia())
      .send(
        herramientas([
          { fecha: '2026-11-01', estado: 'operacion' },
          { fecha: '2026-11-02', estado: 'stand_by' },
        ]),
      )
      .expect(201);
    expect(r.body).toMatchObject({
      estadoPedido: 'documentos_completos',
      avance: { completo: true, pendientes: [] },
    });
    expect(await estadoDe(id)).toBe('documentos_completos');
    const av = (
      await http()
        .get(`/api/comercial/pedidos/${id}/documentos-operativos/avance`)
        .set(ve())
        .expect(200)
    ).body;
    expect(av).toMatchObject({
      completo: true,
      diasConReporteJob: 3,
      reporteHerramientasRecibido: true,
    });
  });

  it('Pumping no exige Reporte de Herramientas; una herramienta vendida exige la guía de remisión', async () => {
    const pum = await pedido('pumping');
    for (const d of [1, 2, 3]) {
      await http()
        .post(`/api/comercial/pedidos/${pum}/documentos-operativos`)
        .set(envia())
        .send({ ...job(d), origen: 'pumping' })
        .expect(201);
    }
    expect(await estadoDe(pum)).toBe('documentos_completos');

    const fcr = await pedido('fcr');
    for (const d of [1, 2, 3]) {
      await http()
        .post(`/api/comercial/pedidos/${fcr}/documentos-operativos`)
        .set(envia())
        .send(job(d))
        .expect(201);
    }
    const r = await http()
      .post(`/api/comercial/pedidos/${fcr}/documentos-operativos`)
      .set(envia())
      .send(herramientas([{ fecha: '2026-11-03', estado: 'venta' }]))
      .expect(201);
    expect(r.body.avance).toMatchObject({
      usoVenta: true,
      guiaRequerida: true,
      guiaRegistrada: false,
      completo: false,
    });
    expect(r.body.avance.pendientes).toEqual(['la guía de remisión (hay herramientas vendidas)']);
    expect(await estadoDe(fcr)).toBe('en_elaboracion_operativa');
  });

  it('valida lo que llega y respeta los permisos y el estado del pedido', async () => {
    const id = await pedido('fcr');
    const url = `/api/comercial/pedidos/${id}/documentos-operativos`;
    await http()
      .post(url)
      .set(envia())
      .send({ ...job(1), fecha: undefined })
      .expect(400); // job sin fecha
    await http()
      .post(url)
      .set(envia())
      .send({ ...herramientas([]), fecha: '2026-11-01' })
      .expect(400); // herramientas con fecha
    await http()
      .post(url)
      .set(envia())
      .send({ ...job(1), actividades: [{ ...job(1).actividades[0], fecha: '2026-11-02' }] })
      .expect(400);
    await http()
      .post(url)
      .set(envia())
      .send({ ...job(1), actividades: [{ ...job(1).actividades[0], horaInicio: '25:00' }] })
      .expect(400);
    await http()
      .post(url)
      .set(envia())
      .send({ ...job(1), tipo: 'otro' })
      .expect(400);
    await http().post(url).set(ve()).send(job(1)).expect(403); // solo lectura no envía
    await http().get(url).expect(401);
    await http()
      .post(`/api/comercial/pedidos/${uuidv7()}/documentos-operativos`)
      .set(envia())
      .send(job(1))
      .expect(404);
    // un pedido que aún no está abierto no recibe documentos
    const borrador = await pedido('fcr', 'borrador');
    await http()
      .post(`/api/comercial/pedidos/${borrador}/documentos-operativos`)
      .set(envia())
      .send(job(1))
      .expect(409);
  });

  it('Facturación puede eliminar un documento; sin ese permiso no', async () => {
    const id = await pedido('fcr');
    await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(envia())
      .send(job(1))
      .expect(201);
    const doc = (
      await http().get(`/api/comercial/pedidos/${id}/documentos-operativos`).set(ve()).expect(200)
    ).body[0];
    await http()
      .delete(`/api/comercial/pedidos/${id}/documentos-operativos/${doc.id}`)
      .set(envia())
      .expect(403);
    await http()
      .delete(`/api/comercial/pedidos/${id}/documentos-operativos/${doc.id}`)
      .set(elimina())
      .expect(200);
    await http()
      .delete(`/api/comercial/pedidos/${id}/documentos-operativos/${doc.id}`)
      .set(elimina())
      .expect(404);
    expect(
      (await http().get(`/api/comercial/pedidos/${id}/documentos-operativos`).set(ve()).expect(200))
        .body,
    ).toEqual([]);
  });

  describe('tablas dentro de las actividades y corrección por Facturación', () => {
    const corrige = () => bearer([P.DOCUMENTOS_OPERATIVOS_VER, P.DOCUMENTOS_OPERATIVOS_CORREGIR]);
    const conTabla = (dia: number) => {
      const d = job(dia);
      d.actividades[0] = {
        ...d.actividades[0],
        tablas: [
          {
            titulo: 'Monitoreo',
            columnas: ['Hora', 'Presión'],
            filas: [
              ['06:00', '120'],
              ['07:00', '135'],
            ],
          },
        ],
      } as (typeof d.actividades)[0];
      return d;
    };
    const lista = async (id: string) =>
      (await http().get(`/api/comercial/pedidos/${id}/documentos-operativos`).set(ve()).expect(200))
        .body;

    it('guarda y devuelve las tablas de una actividad (encabezados, filas y celdas)', async () => {
      const id = await pedido('pumping');
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...conTabla(1), origen: 'pumping' })
        .expect(201);
      const [doc] = await lista(id);
      expect(doc.actividades[0].tablas).toEqual([
        {
          titulo: 'Monitoreo',
          columnas: ['Hora', 'Presión'],
          filas: [
            ['06:00', '120'],
            ['07:00', '135'],
          ],
        },
      ]);
    });

    it('rechaza una fila con distinto número de celdas que de encabezados', async () => {
      const id = await pedido('pumping');
      const malo = conTabla(1);
      malo.actividades[0] = {
        ...malo.actividades[0],
        tablas: [{ titulo: 'Monitoreo', columnas: ['Hora', 'Presión'], filas: [['06:00']] }],
      } as (typeof malo.actividades)[0];
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...malo, origen: 'pumping' })
        .expect(400);
    });

    it('Facturación corrige un día; el ticket ya no puede reenviarlo y sin permiso no se puede corregir', async () => {
      const id = await pedido('pumping');
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...job(1), origen: 'pumping' })
        .expect(201);
      const cuerpo = {
        origen: 'pumping',
        fecha: '2026-11-01',
        actividades: [{ ...job(1).actividades[0], detalle: 'Corregido por Facturación' }],
      };
      await http()
        .put(`/api/comercial/pedidos/${id}/documentos-operativos/dia`)
        .set(envia())
        .send(cuerpo)
        .expect(403);
      await http()
        .put(`/api/comercial/pedidos/${id}/documentos-operativos/dia`)
        .set(corrige())
        .send(cuerpo)
        .expect(200);
      const [doc] = await lista(id);
      expect(doc.actividades[0].detalle).toBe('Corregido por Facturación');
      expect(doc.corregidoAt).not.toBeNull();
      expect(doc.corregidoPor).toBe(ACTOR);
      // el ticket reenvía lo suyo: no pisa la corrección
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...job(1), origen: 'pumping' })
        .expect(409);
      expect((await lista(id))[0].actividades[0].detalle).toBe('Corregido por Facturación');
      // otro día no corregido sí se reenvía
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...job(2), origen: 'pumping' })
        .expect(201);
    });

    it('una lista vacía quita el día: deja de contar como reportado y el ticket no lo reenvía', async () => {
      const id = await pedido('pumping');
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...job(1), origen: 'pumping' })
        .expect(201);
      const r = await http()
        .put(`/api/comercial/pedidos/${id}/documentos-operativos/dia`)
        .set(corrige())
        .send({ origen: 'pumping', fecha: '2026-11-01', actividades: [] })
        .expect(200);
      expect(r.body.avance.diasConReporteJob).toBe(0);
      await http()
        .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
        .set(envia())
        .send({ ...job(1), origen: 'pumping' })
        .expect(409);
    });

    it('no se corrige un pedido que ya salió al cliente para firmas, pero sí uno rechazado por el cliente', async () => {
      const cuerpo = {
        origen: 'pumping',
        fecha: '2026-11-01',
        actividades: [{ ...job(1).actividades[0], detalle: 'Ajuste' }],
      };
      const enviado = await pedido('pumping', 'enviado_para_firmas');
      await http()
        .put(`/api/comercial/pedidos/${enviado}/documentos-operativos/dia`)
        .set(corrige())
        .send(cuerpo)
        .expect(409);
      const rechazado = await pedido('pumping', 'rechazado_por_cliente');
      await http()
        .put(`/api/comercial/pedidos/${rechazado}/documentos-operativos/dia`)
        .set(corrige())
        .send(cuerpo)
        .expect(200);
    });
  });
});
