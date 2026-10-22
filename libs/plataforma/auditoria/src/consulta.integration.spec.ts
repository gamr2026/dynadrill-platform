/**
 * API de consulta de auditoría contra PostgreSQL real: línea de tiempo, búsqueda y permisos.
 *   RUN_INTEGRATION=1 npx nx test auditoria
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { AuditoriaConsumer } from './consumers/auditoria.consumer';
import { PrismaService } from './prisma/prisma.service';
import { arrancarApp, limpiar, MIGRATOR_DB, sobre } from './testing/arranque';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

run('auditoria: consulta (base de datos real)', () => {
  jest.setTimeout(60000);
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const sufijo = Date.now();
  const eventos: string[] = [];
  const tipos: string[] = [];
  const sujetoTipos = [`pedido_prueba_${sufijo}`, `ticket_prueba_${sufijo}`];
  let app: INestApplication;
  let consumer: AuditoriaConsumer;
  let prisma: PrismaService;
  let ver: string;
  let sinPermiso: string;
  let usuarioId = '';
  let rolCodigo = '';
  const tipo = (nombre: string) => {
    const t = `operaciones.prueba.${nombre}_${sufijo}`;
    if (!tipos.includes(t)) tipos.push(t);
    return t;
  };
  const http = () => request(app.getHttpServer());
  const consulta = (ruta: string) =>
    http().get(`/api/auditoria/${ruta}`).set('Authorization', `Bearer ${ver}`);

  const pedidoId = uuidv7();
  const ticketId = uuidv7();
  const instante = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, min)).toISOString();

  beforeAll(async () => {
    usuarioId = (await admin.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    rolCodigo = (await admin.query(`SELECT codigo FROM identidad.rol LIMIT 1`)).rows[0].codigo;
    const a = await arrancarApp('3199');
    ({ app, consumer, prisma } = a);
    ver = a.token(usuarioId, [Permission.AUDITORIA_VER]);
    sinPermiso = a.token(usuarioId, []);

    const hechos = [
      // el pedido, su ticket y un hecho de otro pedido que no debe aparecer
      sobre(
        tipo('pedido_abierto'),
        { type: sujetoTipos[0], id: pedidoId },
        {
          occurredAt: instante(1),
          actor: { userId: usuarioId, role: rolCodigo },
          data: { pedidoCodigo: `PED-${sufijo}` },
        },
      ),
      sobre(
        tipo('ticket_creado'),
        { type: sujetoTipos[1], id: ticketId },
        {
          occurredAt: instante(2),
          data: { pedidoId, ticketId, ticketNumero: 77 },
        },
      ),
      sobre(
        tipo('ticket_cerrado'),
        { type: sujetoTipos[1], id: ticketId },
        {
          occurredAt: instante(3),
          source: 'flota',
          data: { pedidoId, ticketId },
        },
      ),
      sobre(
        tipo('pedido_abierto'),
        { type: sujetoTipos[0], id: uuidv7() },
        { occurredAt: instante(4) },
      ),
    ];
    for (const h of hechos) {
      eventos.push(h.id);
      await consumer.consumir(h);
    }
  });

  afterAll(async () => {
    await limpiar(admin, { eventos, tipos, sujetoTipos });
    await admin.end();
    await app.close();
  });

  it('exige un token y el permiso de auditoría', async () => {
    await http().get('/api/auditoria/eventos').expect(401);
    for (const ruta of ['eventos', `linea-de-tiempo?sujetoTipo=pedido&sujetoId=${uuidv7()}`]) {
      await http()
        .get(`/api/auditoria/${ruta}`)
        .set('Authorization', `Bearer ${sinPermiso}`)
        .expect(403);
    }
  });

  it('no ofrece ninguna escritura: la historia no se edita', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete'] as const) {
      const r = await http()
        [metodo]('/api/auditoria/eventos')
        .set('Authorization', `Bearer ${ver}`);
      expect(r.status).toBe(404);
    }
  });

  it('la línea de tiempo del pedido va en orden cronológico e incluye los hechos de su ticket', async () => {
    const r = await consulta(
      `linea-de-tiempo?sujetoTipo=${sujetoTipos[0]}&sujetoId=${pedidoId}`,
    ).expect(200);
    // el sujeto «pedido» de la prueba no es `pedido` real: solo cuenta lo que lo tiene como sujeto
    expect(r.body.items.map((i: { tipo: string }) => i.tipo)).toEqual([tipo('pedido_abierto')]);
    expect(r.body.items[0]).toMatchObject({
      origen: 'operaciones',
      sujeto: { tipo: sujetoTipos[0], id: pedidoId },
      actor: { id: usuarioId, rol: { codigo: rolCodigo } },
      datos: { pedido_codigo: `PED-${sufijo}` },
    });
  });

  it('para un pedido real, la línea de tiempo suma los hechos que lo nombran (los de sus tickets)', async () => {
    // mismo caso con el tipo real `pedido`: los hechos de las pruebas llevan pedido_id = pedidoId
    const propio = sobre(
      tipo('pedido_aprobado'),
      { type: 'pedido', id: pedidoId },
      { occurredAt: instante(5) },
    );
    eventos.push(propio.id);
    await consumer.consumir(propio);
    const r = await consulta(`linea-de-tiempo?sujetoTipo=pedido&sujetoId=${pedidoId}`).expect(200);
    expect(r.body.items.map((i: { tipo: string }) => i.tipo)).toEqual([
      tipo('ticket_creado'),
      tipo('ticket_cerrado'),
      tipo('pedido_aprobado'),
    ]);
    expect(r.body.total).toBe(3);
  });

  it('pagina la línea de tiempo', async () => {
    const r = await consulta(
      `linea-de-tiempo?sujetoTipo=pedido&sujetoId=${pedidoId}&limite=2&pagina=2`,
    ).expect(200);
    expect(r.body).toMatchObject({ total: 3, pagina: 2, limite: 2 });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].tipo).toBe(tipo('pedido_aprobado'));
  });

  it('busca por actor, tipo, origen y clave de negocio; lo más reciente primero', async () => {
    const porActor = await consulta(
      `eventos?actorId=${usuarioId}&tipo=${tipo('pedido_abierto')}`,
    ).expect(200);
    expect(porActor.body.items.map((i: { id: string }) => i.id)).toContain(eventos[0]);

    const porOrigen = await consulta(`eventos?origen=flota&tipo=${tipo('ticket_cerrado')}`).expect(
      200,
    );
    expect(porOrigen.body.total).toBe(1);

    const porClave = await consulta(`eventos?clave=pedido_id&valor=${pedidoId}`).expect(200);
    // solo los hechos que traen pedido_id en sus datos (el del propio pedido no lo trae: lo tiene como sujeto)
    expect(porClave.body.items.map((i: { tipo: string }) => i.tipo)).toEqual([
      tipo('ticket_cerrado'),
      tipo('ticket_creado'),
    ]);
    const porCodigo = await consulta(`eventos?clave=pedido_codigo&valor=PED-${sufijo}`).expect(200);
    expect(porCodigo.body.total).toBe(1);
  });

  it('filtra por rango de fechas', async () => {
    const r = await consulta(
      `eventos?clave=pedido_id&valor=${pedidoId}&desde=${instante(3)}&hasta=${instante(3)}`,
    ).expect(200);
    expect(r.body.items.map((i: { tipo: string }) => i.tipo)).toEqual([tipo('ticket_cerrado')]);
  });

  it('rechaza filtros inválidos con un mensaje claro', async () => {
    await consulta('linea-de-tiempo?sujetoTipo=pedido').expect(400);
    await consulta('linea-de-tiempo?sujetoTipo=pedido&sujetoId=no-es-uuid').expect(400);
    await consulta('eventos?origen=marte').expect(400);
    await consulta('eventos?actorId=no-es-uuid').expect(400);
    await consulta('eventos?limite=9999').expect(400);
    const clave = await consulta('eventos?clave=pedido_id').expect(400);
    expect(clave.body.detail ?? clave.body.message).toMatch(/clave de negocio/);
    const fechas = await consulta(`eventos?desde=${instante(9)}&hasta=${instante(1)}`).expect(400);
    expect(JSON.stringify(fechas.body)).toMatch(/desde/);
    await consulta(`eventos?sujetoTipo=pedido`).expect(400);
  });

  it('el registro de los hechos es el mismo que ve la base', async () => {
    expect(await prisma.eventoAuditado.count({ where: { id: { in: eventos } } })).toBe(
      eventos.length,
    );
  });
});
