/**
 * Proyector de auditoría contra PostgreSQL real (consumidor invocado sin RabbitMQ). Limpia lo que crea: los registros de
 * auditoría solo los puede borrar dyn_migrator con la limpieza explícita de pruebas.
 *   RUN_INTEGRATION=1 npx nx test auditoria
 */
import { Module } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule } from '@dyn/common';
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { AuditoriaModule } from './auditoria.module';
import { AuditoriaConsumer } from './consumers/auditoria.consumer';
import { PrismaService } from './prisma/prisma.service';

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const APP_DB =
  process.env['TEST_PLATAFORMA_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

run('auditoria: proyector de eventos (base de datos real)', () => {
  jest.setTimeout(60000);
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const sufijo = Date.now();
  const ids: string[] = [];
  const tiposNuevos: string[] = [];
  let modulo: TestingModule;
  let prisma: PrismaService;
  let consumer: AuditoriaConsumer;
  let usuarioId = '';
  let rolCodigo = '';
  let rolId = '';

  const evento = (extra: Partial<EventEnvelope> = {}): EventEnvelope => {
    const id = uuidv7();
    ids.push(id);
    const tipo = `operaciones.pumping.prueba_${sufijo}`;
    if (!tiposNuevos.includes(tipo)) tiposNuevos.push(tipo);
    return {
      id,
      type: tipo,
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'operaciones',
      subject: { type: 'pumping_ticket', id: uuidv7() },
      data: { pedidoId: uuidv7(), ticketNumero: 4531, cliente: 'EP PETROECUADOR' },
      ...extra,
    };
  };

  const filas = (id: string) =>
    prisma.eventoAuditado.findMany({
      where: { id },
      include: { tipoEvento: true, sujetoTipo: true, datos: { include: { claveDato: true } } },
    });

  beforeAll(async () => {
    usuarioId = (await admin.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    const rol = (await admin.query(`SELECT id, codigo FROM identidad.rol LIMIT 1`)).rows[0];
    rolId = rol.id;
    rolCodigo = rol.codigo;
    Object.assign(process.env, {
      SERVICE_NAME: 'auditoria-test',
      PORT: '3198',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    @Module({
      imports: [
        AppConfigModule.forRoot(defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema)),
        CommonModule.forRoot({ serviceName: 'auditoria-test' }),
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        AuditoriaModule,
      ],
    })
    class TestAppModule {}
    jest.spyOn(AuditoriaConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
    modulo = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    await modulo.init();
    prisma = modulo.get(PrismaService);
    consumer = modulo.get(AuditoriaConsumer);
  });

  afterAll(async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL auditoria.limpieza_de_pruebas = 'on'`);
      await c.query(
        `DELETE FROM auditoria.evento_auditado_dato WHERE evento_id = ANY($1::uuid[])`,
        [ids],
      );
      await c.query(`DELETE FROM auditoria.evento_auditado WHERE id = ANY($1::uuid[])`, [ids]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await admin.query(`DELETE FROM auditoria.tipo_evento WHERE codigo = ANY($1::text[])`, [
      tiposNuevos,
    ]);
    await admin.query(`DELETE FROM auditoria.sujeto_tipo WHERE codigo LIKE $1`, [
      `sujeto_prueba_${sufijo}%`,
    ]);
    await admin.query(`DELETE FROM msg_plataforma.inbox WHERE id = ANY($1::uuid[])`, [ids]);
    await admin.end();
    await modulo?.close();
  });

  it('un evento de Pumping queda en el registro con su sujeto, su actor, su rol y las claves de la lista blanca', async () => {
    const e = evento({ actor: { userId: usuarioId, role: rolCodigo } });
    await consumer.consumir(e);
    const [f] = await filas(e.id);
    expect(f).toMatchObject({
      origen: 'operaciones',
      version: 1,
      sujetoId: e.subject.id,
      actorId: usuarioId,
      actorRolId: rolId,
    });
    expect(f.tipoEvento.codigo).toBe(e.type);
    expect(f.sujetoTipo.codigo).toBe('pumping_ticket');
    expect(f.ocurridoAt.toISOString()).toBe(e.occurredAt);
    expect(f.datos.map((d) => [d.claveDato.codigo, d.valor]).sort()).toEqual(
      [
        ['pedido_id', (e.data as { pedidoId: string }).pedidoId],
        ['ticket_numero', '4531'],
      ].sort(),
    );
  });

  it('no guarda campos fuera de la lista blanca ni valores demasiado largos', async () => {
    const e = evento({
      data: { cliente: 'EP PETROECUADOR', pedidoCodigo: 'x'.repeat(201), ticketNumero: 7 },
    });
    await consumer.consumir(e);
    const [f] = await filas(e.id);
    expect(f.datos.map((d) => d.claveDato.codigo)).toEqual(['ticket_numero']);
  });

  it('es idempotente: el mismo evento dos veces deja un solo registro', async () => {
    const e = evento();
    await consumer.consumir(e);
    await consumer.consumir(e);
    expect(await prisma.eventoAuditado.count({ where: { id: e.id } })).toBe(1);
    expect(await prisma.eventoAuditadoDato.count({ where: { eventoId: e.id } })).toBe(2);
  });

  it('sin actor (evento del sistema) o con una cuenta que no existe, se audita con actor nulo', async () => {
    const sistema = evento();
    const desconocido = evento({ actor: { userId: uuidv7(), role: rolCodigo } });
    await consumer.consumir(sistema);
    await consumer.consumir(desconocido);
    for (const e of [sistema, desconocido]) {
      const [f] = await filas(e.id);
      expect(f).toMatchObject({ actorId: null, actorRolId: null });
    }
  });

  it('un rol que no está en identidad deja el actor sin rol', async () => {
    const e = evento({ actor: { userId: usuarioId, role: `rol_inexistente_${sufijo}` } });
    await consumer.consumir(e);
    const [f] = await filas(e.id);
    expect(f).toMatchObject({ actorId: usuarioId, actorRolId: null });
  });

  it('un tipo de evento y de sujeto nuevos se dan de alta una sola vez', async () => {
    const sujetoTipo = `sujeto_prueba_${sufijo}`;
    const a = evento({ subject: { type: sujetoTipo, id: uuidv7() } });
    const b = evento({ subject: { type: sujetoTipo, id: uuidv7() } });
    await consumer.consumir(a);
    await consumer.consumir(b);
    expect(await prisma.tipoEvento.count({ where: { codigo: a.type } })).toBe(1);
    expect(await prisma.sujetoTipo.count({ where: { codigo: sujetoTipo } })).toBe(1);
  });

  it('un evento con sujeto sin id válido se omite sin lanzar y no deja registro', async () => {
    const e = evento({ subject: { type: 'pedido', id: 'no-es-un-uuid' } });
    await expect(consumer.consumir(e)).resolves.toBeUndefined();
    expect(await prisma.eventoAuditado.count({ where: { id: e.id } })).toBe(0);
  });

  it('un evento de un origen desconocido se omite sin lanzar', async () => {
    const e = evento({ source: 'otro' });
    await expect(consumer.consumir(e)).resolves.toBeUndefined();
    expect(await prisma.eventoAuditado.count({ where: { id: e.id } })).toBe(0);
  });
});
