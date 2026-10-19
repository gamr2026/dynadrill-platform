/**
 * Integración real de avisos: Postgres (PgBouncer, app_plataforma). Los destinatarios y la salida de correo son simulados;
 * se prueba sobre todo la garantía de que TODO correo sale solo a la dirección de redirección. Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx nx test avisos
 */
import { INestApplication, Injectable, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { avisosEnvSchema } from './avisos.config';
import { AvisosModule } from './avisos.module';
import { EventosConAvisoConsumer } from './consumers/eventos-con-aviso.consumer';
import { CorreoSeguroService } from './mail/correo-seguro.service';
import { CorreoSaliente, MailPort } from './mail/mail.port';
import { Destinatario, DestinatariosPort } from './puertos/destinatarios.port';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_PLATAFORMA_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const REDIRECCION = 'prueba.redireccion@digitec.test';
const CESAR: Destinatario = {
  id: uuidv7(),
  nombre: 'Cesar Vinicio Saeteros Andrade',
  email: 'cesar.real@dynadrill.test',
  cargo: 'Jefe de base',
  rolNombre: 'Jefe de Base',
};
const OTRO: Destinatario = {
  id: uuidv7(),
  nombre: 'Otra Persona',
  email: 'otra.persona@dynadrill.test',
  cargo: 'Jefe de base',
  rolNombre: 'Jefe de Base',
};

/** Quiénes tienen el rol en la prueba: se cambia desde cada caso. */
const SUPERVISORA: Destinatario = {
  id: uuidv7(),
  nombre: 'Sara Supervisora',
  email: 'sara@dynadrill.test',
  cargo: 'Supervisor',
  rolNombre: 'Supervisor',
};
const OPERADOR: Destinatario = {
  id: uuidv7(),
  nombre: 'Oscar Operador',
  email: 'oscar@dynadrill.test',
  cargo: 'Operador',
  rolNombre: 'Operador',
};
const OTRO_OPERADOR: Destinatario = {
  id: uuidv7(),
  nombre: 'Olga No Elegida',
  email: 'olga@dynadrill.test',
  cargo: 'Operador',
  rolNombre: 'Operador',
};
const personas: {
  jefe_base: Destinatario[];
  supervisor: Destinatario[];
  operador: Destinatario[];
} = {
  jefe_base: [CESAR, OTRO],
  supervisor: [SUPERVISORA],
  operador: [OPERADOR, OTRO_OPERADOR],
};

/** Cuentas reales: el aviso y la bitácora de correos apuntan a la cuenta con FK a identidad. */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [CESAR, OTRO, SUPERVISORA, OPERADOR, OTRO_OPERADOR].map((d) => ({
    id: d.id,
    nombre: d.nombre,
    rol:
      d === SUPERVISORA
        ? 'supervisor'
        : d === OPERADOR || d === OTRO_OPERADOR
          ? 'operador'
          : 'jefe_base',
  })),
};

@Injectable()
class DestinatariosFalso extends DestinatariosPort {
  async activosPorRol(rol: string): Promise<Destinatario[]> {
    return (personas as Record<string, Destinatario[]>)[rol] ?? [];
  }
  async activosPorIds(ids: string[]): Promise<Destinatario[]> {
    return Object.values(personas)
      .flat()
      .filter((p) => ids.includes(p.id));
  }
}

const salida: { enviados: CorreoSaliente[]; falla: string | null } = { enviados: [], falla: null };
class MailFalso extends MailPort {
  async enviar(c: CorreoSaliente): Promise<void> {
    if (salida.falla) throw new Error(salida.falla);
    salida.enviados.push(c);
  }
}

run('avisos: campanita y correo (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let consumer: EventosConAvisoConsumer;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const como = (p: Destinatario) => ({
    Authorization: `Bearer ${signer.sign({ sub: p.id, email: p.email, name: p.nombre, roleId: 'r', roleCode: 'jefe_base', permissions: [] })}`,
  });
  const eventos: string[] = [];

  const ticketCreado = (
    extra: Record<string, unknown> = {},
    tipo = 'operaciones.pumping.ticket_creado',
  ): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    return {
      id,
      type: tipo,
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'operaciones',
      subject: { type: 'pumping_ticket', id: uuidv7() },
      data: {
        ticketId: 'tk-123',
        ticketNumero: 4531,
        pedidoCodigo: 'PED-004999',
        cliente: 'EP PETROECUADOR',
        campo: 'SACHA',
        pozo: 'ESTACION NORTE 2',
        taladro: 'RIGLESS',
        servicios: 'Control fluidos, Nitrogeno',
        fechaInicioServicio: '2026-11-05',
        ...extra,
      },
    };
  };

  beforeEach(() => {
    salida.enviados = [];
    salida.falla = null;
    personas.jefe_base = [CESAR, OTRO];
    personas.supervisor = [SUPERVISORA];
    personas.operador = [OPERADOR, OTRO_OPERADOR];
  });

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'avisos-test',
      PORT: '3197',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
      MAIL_REDIRECT_TO: REDIRECCION,
      APP_URL: 'http://portal.test',
    });
    const envSchema = defineEnv(
      baseEnvSchema,
      databaseEnvSchema,
      jwtVerifyEnvSchema,
      avisosEnvSchema,
    );
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'avisos-test' }),
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        AvisosModule.forRoot({ destinatarios: DestinatariosFalso }),
      ],
    })
    class TestAppModule {}
    jest
      .spyOn(EventosConAvisoConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(MailPort)
      .useValue(new MailFalso())
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(EventosConAvisoConsumer);
  });

  afterAll(async () => {
    await admin.query('DELETE FROM avisos.aviso WHERE usuario_id = ANY($1::uuid[])', [
      MAESTROS.usuarios!.map((u) => u.id),
    ]);
    await admin.query('DELETE FROM avisos.correo_aviso WHERE evento_id = ANY($1::uuid[])', [
      eventos,
    ]);
    await admin.query('DELETE FROM msg_plataforma.inbox WHERE id = ANY($1::uuid[])', [eventos]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('un evento con regla avisa a cada persona con el rol: campanita y correo con el texto de su cargo', async () => {
    const e = ticketCreado();
    await consumer.consumir(e);
    // campanita: uno por persona, con los datos del evento y el enlace al ticket
    const avisos = await prisma.aviso.findMany({
      where: { eventoId: e.id },
      orderBy: { usuarioId: 'asc' },
    });
    expect(avisos).toHaveLength(2);
    const deCesar = avisos.find((a) => a.usuarioId === CESAR.id)!;
    expect(deCesar).toMatchObject({
      titulo: 'Nuevo pedido de Pumping: PED-004999',
      detalle: 'EP PETROECUADOR · Pozo ESTACION NORTE 2 — pendiente de revisión inicial',
      enlace: '/modulos/operativo/pumping/pedidos/tk-123',
      tono: 'warning',
      leidoAt: null,
    });
    // correo: uno por persona, personalizado con su nombre y su cargo
    expect(salida.enviados).toHaveLength(2);
    const cesar = salida.enviados.find((c) => c.html.includes('Cesar Vinicio'))!;
    expect(cesar.asunto).toBe(
      '[PRUEBA] Nuevo pedido de Pumping para revisar: PED-004999 — EP PETROECUADOR',
    );
    expect(cesar.html).toContain('Hola Cesar Vinicio Saeteros Andrade');
    expect(cesar.html).toContain('Como <strong>Jefe de base</strong>');
    expect(cesar.html).toContain('Ticket');
    expect(cesar.texto).toContain('Ticket: 4531');
    for (const dato of [
      '4531',
      'PED-004999',
      'EP PETROECUADOR',
      'SACHA',
      'ESTACION NORTE 2',
      'RIGLESS',
      'Control fluidos, Nitrogeno',
      '2026-11-05',
    ]) {
      expect(cesar.html).toContain(dato);
    }
    expect(cesar.html).toContain(
      'href="http://portal.test/modulos/operativo/pumping/pedidos/tk-123"',
    );
    expect(cesar.texto).toContain('Como Jefe de base');
    expect(cesar.texto).toContain('http://portal.test/modulos/operativo/pumping/pedidos/tk-123');
    // bitácora: a quién habría llegado y a dónde salió de verdad
    const bitacora = await prisma.correoAviso.findMany({ where: { eventoId: e.id } });
    expect(bitacora.map((b) => [b.usuarioId, b.enviadoA, b.estado]).sort()).toEqual(
      [
        [CESAR.id, REDIRECCION, 'enviado'],
        [OTRO.id, REDIRECCION, 'enviado'],
      ].sort(),
    );
  });

  it('la asignación avisa solo a las cuentas elegidas (no a todo el rol), cada una con la plantilla de su rol de asignación', async () => {
    const e = ticketCreado(
      {
        asignadoPor: 'Cesar Saeteros',
        supervisor: 'Sara Supervisora',
        operadores: 'Oscar Operador',
        unidades: 'GSI6538',
        asignados: [
          { usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' },
          { usuarioId: OPERADOR.id, rolCodigo: 'operador' },
        ],
      },
      'operaciones.pumping.asignacion_realizada',
    );
    await consumer.consumir(e);
    const avisos = await prisma.aviso.findMany({ where: { eventoId: e.id } });
    expect(avisos.map((a) => a.usuarioId).sort()).toEqual([SUPERVISORA.id, OPERADOR.id].sort());
    expect(avisos.find((a) => a.usuarioId === SUPERVISORA.id)?.titulo).toBe(
      'Asignado como supervisor: PED-004999',
    );
    expect(avisos.find((a) => a.usuarioId === OPERADOR.id)?.titulo).toBe(
      'Asignado como operador: PED-004999',
    );
    expect(salida.enviados).toHaveLength(2);
    expect(salida.enviados.every((c) => c.para === REDIRECCION)).toBe(true);
    const oscar = salida.enviados.find((c) => c.html.includes('Hola Oscar Operador'))!;
    expect(oscar.html).toContain('Su supervisor es <strong>Sara Supervisora</strong>');
    expect(oscar.html).toContain('GSI6538');
    expect(salida.enviados.some((c) => c.html.includes('Olga No Elegida'))).toBe(false);
    await admin.query('DELETE FROM avisos.aviso WHERE usuario_id = ANY($1::uuid[])', [
      [SUPERVISORA.id, OPERADOR.id],
    ]);
  });

  it('Mantenimiento: la unidad devuelta avisa al Jefe de Base con la unidad y el estado final, sin nombres de personas', async () => {
    const e = ticketCreado(
      {
        ordenCodigo: 'RU-000123',
        unidad: 'GSI6538',
        estadoFinal: 'con_restricciones',
        estadoFinalNombre: 'Con restricciones',
      },
      'operaciones.mantenimiento.orden.retornada',
    );
    await consumer.consumir(e);
    const avisos = await prisma.aviso.findMany({ where: { eventoId: e.id } });
    expect(avisos.map((a) => a.usuarioId).sort()).toEqual([CESAR.id, OTRO.id].sort());
    expect(avisos[0].titulo).toBe('Unidad devuelta: GSI6538');
    expect(avisos[0].detalle).toBe('Con restricciones · orden RU-000123');
    expect(
      salida.enviados.every((c) => c.asunto.includes('GSI6538') && !c.html.includes('{{')),
    ).toBe(true);
  });

  it('al terminar el traslado de salida se avisa solo al supervisor asignado', async () => {
    const e = ticketCreado(
      {
        reportadoPor: 'Oscar Operador',
        unidades: 'GSI6538',
        asignados: [{ usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' }],
      },
      'operaciones.pumping.salida_reportada',
    );
    await consumer.consumir(e);
    const avisos = await prisma.aviso.findMany({ where: { eventoId: e.id } });
    expect(avisos.map((a) => a.usuarioId)).toEqual([SUPERVISORA.id]);
    expect(avisos[0].titulo).toBe('Salida reportada: PED-004999');
    expect(salida.enviados).toHaveLength(1);
    expect(salida.enviados[0].html).toContain('Oscar Operador');
    expect(salida.enviados[0].html).toContain('Revisión de reportes de salida');
    await admin.query('DELETE FROM avisos.aviso WHERE usuario_id = $1', [SUPERVISORA.id]);
  });

  it('GARANTÍA: todo correo sale únicamente a la dirección de redirección; la de la persona nunca es destinataria', async () => {
    await consumer.consumir(ticketCreado());
    expect(salida.enviados.length).toBeGreaterThan(0);
    for (const c of salida.enviados) {
      expect(c.para).toBe(REDIRECCION);
      expect(Object.keys(c).sort()).toEqual(['asunto', 'html', 'para', 'texto']); // sin cc ni copia oculta
    }
    // la persona real aparece solo como texto informativo ("habría llegado a")
    const html = salida.enviados.map((c) => c.html).join(' ');
    expect(html).toContain(
      'Habría llegado a Cesar Vinicio Saeteros Andrade &lt;cesar.real@dynadrill.test&gt;',
    );
    expect(salida.enviados.every((c) => c.asunto.startsWith('[PRUEBA] '))).toBe(true);
    expect(app.get(CorreoSeguroService).destinoReal).toBe(REDIRECCION);
  });

  it('no avisa dos veces por el mismo evento, aunque llegue repetido', async () => {
    const e = ticketCreado();
    await consumer.consumir(e);
    await consumer.consumir(e);
    expect(salida.enviados).toHaveLength(2);
    expect(await prisma.aviso.count({ where: { eventoId: e.id } })).toBe(2);
    expect(await prisma.correoAviso.count({ where: { eventoId: e.id } })).toBe(2);
  });

  it('sin nadie activo con el rol: no hay campanita, pero el correo de prueba sale igual y lo dice', async () => {
    personas.jefe_base = [];
    const e = ticketCreado();
    await consumer.consumir(e);
    expect(await prisma.aviso.count({ where: { eventoId: e.id } })).toBe(0);
    expect(salida.enviados).toHaveLength(1);
    expect(salida.enviados[0].para).toBe(REDIRECCION);
    expect(salida.enviados[0].html).toContain('No había ninguna persona activa con ese rol');
    const b = await prisma.correoAviso.findFirstOrThrow({ where: { eventoId: e.id } });
    expect(b).toMatchObject({ usuarioId: null, enviadoA: REDIRECCION, estado: 'enviado' });
  });

  it('si el correo no sale, la campanita queda y la falla se anota (sin tumbar el evento)', async () => {
    salida.falla = 'SMTP caído';
    personas.jefe_base = [CESAR];
    const e = ticketCreado();
    await consumer.consumir(e);
    expect(await prisma.aviso.count({ where: { eventoId: e.id } })).toBe(1);
    const b = await prisma.correoAviso.findFirstOrThrow({ where: { eventoId: e.id } });
    expect(b).toMatchObject({ estado: 'fallido', error: 'SMTP caído', enviadoA: REDIRECCION });
  });

  it('los datos del evento se escapan en el HTML: un nombre con etiquetas no llega como código', async () => {
    personas.jefe_base = [CESAR];
    await consumer.consumir(ticketCreado({ cliente: '<script>alert(1)</script> S.A.' }));
    const html = salida.enviados[0].html;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; S.A.');
  });

  it('un evento sin regla no avisa a nadie', async () => {
    const e = ticketCreado({}, 'operaciones.pumping.otro_hecho');
    await consumer.consumir(e);
    expect(salida.enviados).toHaveLength(0);
    expect(await prisma.aviso.count({ where: { eventoId: e.id } })).toBe(0);
  });

  it('la campanita muestra solo lo propio y sin leer; leer uno o todos los saca de la lista; lo ajeno no se toca', async () => {
    personas.jefe_base = [CESAR, OTRO];
    const e = ticketCreado();
    await consumer.consumir(e);
    const mios = (await http().get('/api/avisos').set(como(CESAR)).expect(200)).body as Array<{
      id: string;
      titulo: string;
      enlace: string;
    }>;
    const nuevo = mios.find((a) => a.titulo === 'Nuevo pedido de Pumping: PED-004999')!;
    expect(nuevo.enlace).toBe('/modulos/operativo/pumping/pedidos/tk-123');
    // lo de la otra persona no se ve ni se puede leer
    const delOtro = (await http().get('/api/avisos').set(como(OTRO)).expect(200)).body as Array<{
      id: string;
    }>;
    expect(delOtro.some((a) => a.id === nuevo.id)).toBe(false);
    await http().post(`/api/avisos/${delOtro[0].id}/leer`).set(como(CESAR)).expect(403);
    await http().post(`/api/avisos/${uuidv7()}/leer`).set(como(CESAR)).expect(404);
    // leer uno
    await http().post(`/api/avisos/${nuevo.id}/leer`).set(como(CESAR)).expect(200);
    const despues = (await http().get('/api/avisos').set(como(CESAR)).expect(200)).body as Array<{
      id: string;
    }>;
    expect(despues.some((a) => a.id === nuevo.id)).toBe(false);
    // leer todos
    await consumer.consumir(ticketCreado());
    const r = await http().post('/api/avisos/leer-todos').set(como(CESAR)).expect(200);
    expect(r.body.leidos).toBeGreaterThan(0);
    expect((await http().get('/api/avisos').set(como(CESAR)).expect(200)).body).toEqual([]);
    // la otra persona conserva los suyos
    expect(
      ((await http().get('/api/avisos').set(como(OTRO)).expect(200)).body as unknown[]).length,
    ).toBeGreaterThan(0);
    await http().get('/api/avisos').expect(401);
  });

  it('sin una dirección de redirección válida el servicio no se puede construir (no sale ningún correo)', () => {
    expect(
      () => new CorreoSeguroService(new MailFalso(), { redirigirA: '', appUrl: 'http://x' }),
    ).toThrow('MAIL_REDIRECT_TO');
    expect(
      () =>
        new CorreoSeguroService(new MailFalso(), {
          redirigirA: 'no-es-correo',
          appUrl: 'http://x',
        }),
    ).toThrow('MAIL_REDIRECT_TO');
  });
});
