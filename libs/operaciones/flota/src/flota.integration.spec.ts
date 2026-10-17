/**
 * Integración real de Flota (tramo F1): Postgres (PgBouncer, app_operaciones). Unidades, lecturas, preventivos y alertas. Limpia lo que
 * crea.
 *   RUN_INTEGRATION=1 npx jest --config libs/operaciones/flota/jest.config.cts   (o: npx nx test flota)
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
import { FlotaModule } from './flota.module';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_OPERACIONES_DATABASE_URL'] ??
  'postgresql://app_operaciones:dev_app_operaciones@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const P = Permission;
const dia = (d: Date) => d.toISOString().slice(0, 10);
const haceDias = (k: number) => dia(new Date(Date.now() - k * 86_400_000));

const JEFE_MANT = { id: uuidv7(), nombre: 'Mario Jefe de Mantenimiento' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const RESPONSABLE = { id: uuidv7(), nombre: 'Ruth Responsable' };
const INACTIVO = { id: uuidv7(), nombre: 'Ivan Inactivo' };
const VEHICULO = { id: uuidv7(), placa: `FL${String(n).slice(-5)}A` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE_MANT.id, nombre: JEFE_MANT.nombre, rol: 'jefe_mantenimiento' },
    { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: 'operador' },
    { id: RESPONSABLE.id, nombre: RESPONSABLE.nombre, rol: 'jefe_mantenimiento' },
    { id: INACTIVO.id, nombre: INACTIVO.nombre, rol: 'operador', activo: false },
  ],
  vehiculos: [VEHICULO],
};

const PERMISOS_JEFE = [
  P.UNIDADES_VER,
  P.UNIDADES_CREAR,
  P.UNIDADES_EDITAR,
  P.UNIDADES_INACTIVAR,
  P.LECTURAS_REGISTRAR,
  P.PREVENTIVOS_REGISTRAR,
  P.LECTURAS_ANULAR,
  P.PREVENTIVOS_ANULAR,
  P.PROVEEDORES_MANTENIMIENTO_GESTIONAR,
];

run('Flota F1: unidades, lecturas y preventivos (base de datos real)', () => {
  jest.setTimeout(120000);
  let app: INestApplication;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const jefe = () => token('jefe_mantenimiento', JEFE_MANT.nombre, PERMISOS_JEFE, JEFE_MANT.id);
  const operador = () => token('operador', OPERADOR.nombre, [P.UNIDADES_VER], OPERADOR.id);

  const unidades: string[] = [];
  const proveedores: string[] = [];
  let seq = 0;
  const codigo = (p: string) => `${p}-${String(n).slice(-6)}${seq++}`;

  const crear = async (cuerpo: Record<string, unknown>) => {
    const r = await http().post('/api/operaciones/flota/unidades').set(jefe()).send(cuerpo);
    if (r.status === 201) unidades.push(r.body.id);
    return r;
  };
  const lectura = (id: string, cuerpo: Record<string, unknown>) =>
    http().post(`/api/operaciones/flota/unidades/${id}/lecturas`).set(jefe()).send(cuerpo);
  const preventivo = (id: string, cuerpo: Record<string, unknown>) =>
    http().post(`/api/operaciones/flota/unidades/${id}/preventivos`).set(jefe()).send(cuerpo);
  interface AlertaHttp {
    unidad: { id: string };
    reglaCodigo: string;
    consumido: number;
    restante: number;
    nivel: string;
    enVentana: boolean;
  }
  const alertasDe = async (id: string): Promise<AlertaHttp[]> => {
    const r = await http().get('/api/operaciones/flota/unidades/alertas').set(jefe()).expect(200);
    return (r.body as AlertaHttp[]).filter((a) => a.unidad.id === id);
  };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'operaciones-test',
      PORT: '3197',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'operaciones-test' }),
        MessagingModule.forRoot({
          container: 'operaciones',
          schema: 'msg_operaciones',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        FlotaModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
  });

  afterAll(async () => {
    if (unidades.length) {
      await admin.query(
        "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'unidadId' = ANY($1::text[])",
        [unidades],
      );
      await admin.query('DELETE FROM flota.unidad WHERE id = ANY($1::uuid[])', [unidades]);
    }
    if (proveedores.length)
      await admin.query('DELETE FROM flota.proveedor_mantenimiento WHERE id = ANY($1::uuid[])', [
        proveedores,
      ]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('permisos', () => {
    it('sin token 401; sin el permiso 403; quien solo ve no puede crear', async () => {
      await http().get('/api/operaciones/flota/unidades').expect(401);
      await http()
        .get('/api/operaciones/flota/unidades')
        .set(token('ingenieria_ventas', 'Vera', [], uuidv7()))
        .expect(403);
      await http().get('/api/operaciones/flota/unidades').set(operador()).expect(200);
      await http()
        .post('/api/operaciones/flota/unidades')
        .set(operador())
        .send({ codigo: 'X-1', nombre: 'Xx', tipo: 'servicio' })
        .expect(403);
      await http()
        .post('/api/operaciones/flota/proveedores-mantenimiento')
        .set(operador())
        .send({ nombre: 'Proveedor X' })
        .expect(403);
    });
  });

  describe('carga inicial', () => {
    it('trae las unidades de la demo con su horómetro y sus reglas preventivas', async () => {
      const r = await http().get('/api/operaciones/flota/unidades?q=PUM-07').set(operador()).expect(200);
      const pum07 = r.body.find((u: { codigo: string }) => u.codigo === 'PUM-07');
      expect(pum07).toMatchObject({ tipo: 'servicio', activa: true });
      expect(pum07.horometro.valor).toBe(1480);
      const reglas = await admin.query('SELECT codigo FROM flota.regla_preventiva ORDER BY codigo');
      expect(reglas.rows.map((x: { codigo: string }) => x.codigo)).toEqual([
        'auxiliar_tiempo',
        'servicio_a',
        'servicio_b',
        'servicio_tiempo',
        'transporte_km',
      ]);
    });

    it('filtra por tipo y no lista las unidades dadas de baja por omisión', async () => {
      const r = await http().get('/api/operaciones/flota/unidades?tipo=auxiliar').set(operador()).expect(200);
      expect(r.body.length).toBeGreaterThanOrEqual(2);
      expect(r.body.every((u: { tipo: string }) => u.tipo === 'auxiliar')).toBe(true);
    });
  });

  describe('alta y edición de unidades', () => {
    it('crea una unidad de servicio con su horómetro inicial y la lee con su ficha', async () => {
      const c = codigo('FLT');
      const r = await crear({ codigo: c.toLowerCase(), nombre: 'Unidad de prueba', tipo: 'servicio', lecturaInicial: 100 }).then(
        (x) => x,
      );
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ codigo: c, tipo: 'servicio', activa: true });
      expect(r.body.horometro.valor).toBe(100);
      expect(r.body.odometro).toBeNull();
      const ficha = await http().get(`/api/operaciones/flota/unidades/${r.body.id}`).set(operador()).expect(200);
      expect(ficha.body.codigo).toBe(c);
    });

    it('rechaza el código repetido (409), la categoría de peso fuera de transporte y la lectura en auxiliares (400)', async () => {
      const c = codigo('FLD');
      await crear({ codigo: c, nombre: 'Primera', tipo: 'auxiliar' }).then((r) => expect(r.status).toBe(201));
      const dup = await crear({ codigo: c, nombre: 'Segunda', tipo: 'auxiliar' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('codigo_duplicado');
      const cat = await crear({ codigo: codigo('FLC'), nombre: 'Con categoría', tipo: 'servicio', categoriaPeso: 'pesado' });
      expect(cat.status).toBe(400);
      expect(cat.body.code).toBe('categoria_no_aplica');
      const aux = await crear({ codigo: codigo('FLA'), nombre: 'Aux con lectura', tipo: 'auxiliar', lecturaInicial: 5 });
      expect(aux.status).toBe(400);
      expect(aux.body.code).toBe('unidad_sin_lectura');
    });

    it('liga un vehículo del catálogo una sola vez y devuelve sus datos de matrícula con JOIN', async () => {
      const t = await crear({
        codigo: codigo('FLV'),
        nombre: 'Camioneta de prueba',
        tipo: 'transporte',
        categoriaPeso: 'liviano',
        vehiculoId: VEHICULO.id,
        lecturaInicial: 50000,
        caducidadPoliza: '2027-03-01',
      });
      expect(t.status).toBe(201);
      expect(t.body.vehiculo).toMatchObject({ id: VEHICULO.id, placa: VEHICULO.placa });
      expect(t.body.documentos.caducidadPoliza).toBe('2027-03-01');
      expect(t.body.odometro.valor).toBe(50000);
      const otra = await crear({ codigo: codigo('FLW'), nombre: 'Otra', tipo: 'transporte', vehiculoId: VEHICULO.id });
      expect(otra.status).toBe(409);
      expect(otra.body.code).toBe('vehiculo_ya_ligado');
      const inexistente = await crear({ codigo: codigo('FLX'), nombre: 'Otra', tipo: 'transporte', vehiculoId: uuidv7() });
      expect(inexistente.status).toBe(400);
    });

    it('edita el patrimonio, no cambia el tipo y da de baja y reactiva la unidad', async () => {
      const u = await crear({ codigo: codigo('FLE'), nombre: 'Editable', tipo: 'transporte', categoriaPeso: 'liviano' });
      const e = await http()
        .patch(`/api/operaciones/flota/unidades/${u.body.id}`)
        .set(jefe())
        .send({ nombre: 'Editada', categoriaPeso: 'pesado', responsablePatrimonialId: RESPONSABLE.id, nota: 'ok', caducidadMatricula: '2027-05-05' })
        .expect(200);
      expect(e.body).toMatchObject({ nombre: 'Editada', categoriaPeso: 'pesado', nota: 'ok' });
      expect(e.body.responsablePatrimonial).toEqual({ id: RESPONSABLE.id, nombre: RESPONSABLE.nombre });
      expect(e.body.documentos.caducidadMatricula).toBe('2027-05-05');
      // borrar con null
      const sinNota = await http().patch(`/api/operaciones/flota/unidades/${u.body.id}`).set(jefe()).send({ nota: null }).expect(200);
      expect(sinNota.body.nota).toBeNull();
      // el tipo no se cambia (campo no admitido)
      await http().patch(`/api/operaciones/flota/unidades/${u.body.id}`).set(jefe()).send({ tipo: 'servicio' }).expect(400);
      // responsable inactivo
      const mal = await http().patch(`/api/operaciones/flota/unidades/${u.body.id}`).set(jefe()).send({ responsablePatrimonialId: INACTIVO.id });
      expect(mal.status).toBe(400);
      // baja y reactivación
      const baja = await http().patch(`/api/operaciones/flota/unidades/${u.body.id}/activa`).set(jefe()).send({ activa: false }).expect(200);
      expect(baja.body.activa).toBe(false);
      const lista = await http().get(`/api/operaciones/flota/unidades?q=${u.body.codigo}`).set(operador()).expect(200);
      expect(lista.body).toHaveLength(0);
      const todas = await http().get(`/api/operaciones/flota/unidades?q=${u.body.codigo}&activa=todas`).set(operador()).expect(200);
      expect(todas.body).toHaveLength(1);
      // una unidad de baja no recibe preventivos
      const p = await preventivo(u.body.id, { fecha: haceDias(1), valor: 1, ejecutadoPor: 'interno' });
      expect(p.status).toBe(400);
      expect(p.body.code).toBe('unidad_inactiva');
      await http().patch(`/api/operaciones/flota/unidades/${u.body.id}/activa`).set(jefe()).send({ activa: true }).expect(200);
    });
  });

  describe('lecturas', () => {
    it('la lectura vigente es la última; una menor que la anterior se rechaza; el historial va de la más reciente a la más antigua', async () => {
      const u = await crear({ codigo: codigo('FLL'), nombre: 'Lecturas', tipo: 'servicio', lecturaInicial: 100 });
      const id = u.body.id;
      await lectura(id, { tipo: 'horometro', valor: 150 }).then((r) => expect(r.status).toBe(201));
      await lectura(id, { tipo: 'horometro', valor: 180 }).then((r) => expect(r.status).toBe(201));
      const menor = await lectura(id, { tipo: 'horometro', valor: 170 });
      expect(menor.status).toBe(409);
      expect(menor.body.code).toBe('lectura_menor_que_la_anterior');
      const ficha = await http().get(`/api/operaciones/flota/unidades/${id}`).set(operador()).expect(200);
      expect(ficha.body.horometro.valor).toBe(180);
      const h = await http().get(`/api/operaciones/flota/unidades/${id}/lecturas`).set(operador()).expect(200);
      expect(h.body.map((x: { valor: number }) => x.valor)).toEqual([180, 150, 100]);
      expect(h.body[0]).toMatchObject({ fuente: 'manual', registradaPor: { id: JEFE_MANT.id } });
      expect(h.body[2].fuente).toBe('carga_inicial');
    });

    it('rechaza una lectura entre dos que no la admiten, la futura y la de otro tipo; las auxiliares no llevan lectura', async () => {
      const u = await crear({ codigo: codigo('FLM'), nombre: 'Línea de tiempo', tipo: 'servicio', lecturaInicial: 100 });
      const id = u.body.id;
      await lectura(id, { tipo: 'horometro', valor: 300 }).then((r) => expect(r.status).toBe(201));
      const hace1h = new Date(Date.now() - 3600_000).toISOString();
      const mayor = await lectura(id, { tipo: 'horometro', valor: 400, leidaAt: hace1h });
      // la de hace 1 h con 400 queda ANTES de la de 300 (ahora): es mayor que una posterior
      expect(mayor.status).toBe(409);
      expect(mayor.body.code).toBe('lectura_mayor_que_la_posterior');
      const futura = await lectura(id, { tipo: 'horometro', valor: 500, leidaAt: new Date(Date.now() + 86_400_000).toISOString() });
      expect(futura.status).toBe(400);
      expect(futura.body.code).toBe('lectura_futura');
      const otroTipo = await lectura(id, { tipo: 'odometro', valor: 500 });
      expect(otroTipo.status).toBe(400);
      expect(otroTipo.body.code).toBe('lectura_de_otro_tipo');
      const aux = await crear({ codigo: codigo('FLN'), nombre: 'Auxiliar', tipo: 'auxiliar' });
      const sinLectura = await lectura(aux.body.id, { tipo: 'horometro', valor: 1 });
      expect(sinLectura.status).toBe(400);
      expect(sinLectura.body.code).toBe('unidad_sin_lectura');
      await lectura(id, { tipo: 'horometro', valor: -1 }).then((r) => expect(r.status).toBe(400));
    });

    it('publica flota.unidad.lectura_registrada con source flota en la misma transacción', async () => {
      const u = await crear({ codigo: codigo('FLO'), nombre: 'Eventos', tipo: 'transporte' });
      await lectura(u.body.id, { tipo: 'odometro', valor: 1234.5 }).then((r) => expect(r.status).toBe(201));
      const ev = await admin.query(
        "SELECT datos FROM msg_operaciones.outbox WHERE tipo = 'flota.unidad.lectura_registrada' AND datos->'data'->>'unidadId' = $1",
        [u.body.id],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].datos).toMatchObject({
        source: 'flota',
        subject: { type: 'flota_unidad', id: u.body.id },
        data: { tipo: 'odometro', valor: 1234.5, fuente: 'manual' },
        actor: { userId: JEFE_MANT.id },
      });
      const creada = await admin.query(
        "SELECT 1 FROM msg_operaciones.outbox WHERE tipo = 'flota.unidad.creada' AND datos->'data'->>'unidadId' = $1",
        [u.body.id],
      );
      expect(creada.rows).toHaveLength(1);
    });
  });

  describe('preventivos y alertas', () => {
    it('servicio: el tipo B reinicia el contador del A y la lectura del preventivo queda en el historial', async () => {
      const u = await crear({ codigo: codigo('FLP'), nombre: 'Preventivos', tipo: 'servicio', lecturaInicial: 0 });
      const id = u.body.id;
      // sin ningún preventivo: vencido desde cero
      let a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 0, nivel: 'verde' });
      await lectura(id, { tipo: 'horometro', valor: 1000 }).then((r) => expect(r.status).toBe(201));
      a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 1000, nivel: 'rojo' });

      // A a las 1000 h (ya es la lectura vigente: no se duplica el valor, se registra la lectura del mantenimiento)
      const pa = await preventivo(id, { tipoServicio: 'a', fecha: dia(new Date()), valor: 1000, ejecutadoPor: 'interno' });
      expect(pa.status).toBe(201);
      expect(pa.body).toMatchObject({ tipoServicio: 'a', valor: 1000, ejecutadoPor: 'interno' });
      await lectura(id, { tipo: 'horometro', valor: 1230 }).then((r) => expect(r.status).toBe(201));
      a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 230, restante: 20, nivel: 'amarillo' });
      expect(a.find((x) => x.reglaCodigo === 'servicio_b')).toMatchObject({ consumido: 1230, nivel: 'verde' });

      // B a las 1300 h: reinicia también el A
      const pb = await preventivo(id, { tipoServicio: 'b', fecha: dia(new Date()), valor: 1300, ejecutadoPor: 'interno', observaciones: ' cambio de cajas ' });
      expect(pb.status).toBe(201);
      expect(pb.body.observaciones).toBe('cambio de cajas');
      a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 0, nivel: 'verde' });
      expect(a.find((x) => x.reglaCodigo === 'servicio_b')).toMatchObject({ consumido: 0, nivel: 'verde' });

      const hist = await http().get(`/api/operaciones/flota/unidades/${id}/preventivos`).set(operador()).expect(200);
      expect(hist.body).toHaveLength(2);
      expect(hist.body[0]).toMatchObject({ tipoServicio: 'b', valor: 1300, responsable: { id: JEFE_MANT.id } });
      const lecs = await http().get(`/api/operaciones/flota/unidades/${id}/lecturas`).set(operador()).expect(200);
      expect(lecs.body.filter((l: { fuente: string }) => l.fuente === 'mantenimiento')).toHaveLength(2);
      const ev = await admin.query(
        "SELECT 1 FROM msg_operaciones.outbox WHERE tipo = 'flota.unidad.preventivo_registrado' AND datos->'data'->>'unidadId' = $1",
        [id],
      );
      expect(ev.rows).toHaveLength(2);
    });

    it('transporte: cada 5.000 km con ventana de 500 km', async () => {
      const u = await crear({ codigo: codigo('FLK'), nombre: 'Transporte', tipo: 'transporte', categoriaPeso: 'pesado', lecturaInicial: 85000 });
      const id = u.body.id;
      expect(await alertasDe(id)).toEqual([]); // sin preventivo previo no hay base de cálculo
      await preventivo(id, { fecha: haceDias(2), valor: 85000, ejecutadoPor: 'interno' }).then((r) => expect(r.status).toBe(201));
      await lectura(id, { tipo: 'odometro', valor: 87400 }).then((r) => expect(r.status).toBe(201));
      let a = await alertasDe(id);
      expect(a[0]).toMatchObject({ reglaCodigo: 'transporte_km', consumido: 2400, restante: 2600, nivel: 'verde' });
      await lectura(id, { tipo: 'odometro', valor: 90100 }).then((r) => expect(r.status).toBe(201));
      a = await alertasDe(id);
      expect(a[0]).toMatchObject({ restante: -100, nivel: 'amarillo', enVentana: true });
      await lectura(id, { tipo: 'odometro', valor: 90600 }).then((r) => expect(r.status).toBe(201));
      a = await alertasDe(id);
      expect(a[0].nivel).toBe('rojo');
    });

    it('auxiliar y servicio sin horómetro: mantenimiento por tiempo (6 meses)', async () => {
      const aux = await crear({ codigo: codigo('FLG'), nombre: 'Generador', tipo: 'auxiliar' });
      await preventivo(aux.body.id, { fecha: haceDias(200), ejecutadoPor: 'interno' }).then((r) => expect(r.status).toBe(201));
      const a = await alertasDe(aux.body.id);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ reglaCodigo: 'auxiliar_tiempo', consumido: 200, restante: -20, nivel: 'rojo' });

      // una unidad de servicio que nunca tuvo horómetro (cisterna) se controla solo por tiempo
      const cis = await crear({ codigo: codigo('FLS'), nombre: 'Cisterna', tipo: 'servicio' });
      await preventivo(cis.body.id, { tipoServicio: 'a', fecha: haceDias(100), ejecutadoPor: 'interno' }).then((r) => expect(r.status).toBe(201));
      const ac = await alertasDe(cis.body.id);
      expect(ac.map((x) => x.reglaCodigo)).toEqual(['servicio_tiempo']);
      expect(ac[0]).toMatchObject({ consumido: 100, restante: 80, nivel: 'verde' });
    });

    it('valida el preventivo: tipo A/B, lectura, proveedor del tercero, responsable y fecha', async () => {
      const s = await crear({ codigo: codigo('FLQ'), nombre: 'Servicio', tipo: 'servicio', lecturaInicial: 10 });
      const t = await crear({ codigo: codigo('FLR'), nombre: 'Transporte', tipo: 'transporte', lecturaInicial: 10 });
      const x = await crear({ codigo: codigo('FLU'), nombre: 'Auxiliar', tipo: 'auxiliar' });
      const hoy = dia(new Date());
      const casos: Array<[string, Record<string, unknown>, string]> = [
        [s.body.id, { fecha: hoy, valor: 20, ejecutadoPor: 'interno' }, 'tipo_servicio_requerido'],
        [t.body.id, { tipoServicio: 'a', fecha: hoy, valor: 20, ejecutadoPor: 'interno' }, 'tipo_servicio_no_aplica'],
        [t.body.id, { fecha: hoy, ejecutadoPor: 'interno' }, 'lectura_requerida'],
        [x.body.id, { fecha: hoy, valor: 5, ejecutadoPor: 'interno' }, 'unidad_sin_lectura'],
        [s.body.id, { tipoServicio: 'a', fecha: hoy, valor: 20, ejecutadoPor: 'tercero' }, 'proveedor_requerido'],
        [s.body.id, { tipoServicio: 'a', fecha: hoy, valor: 20, ejecutadoPor: 'interno', responsableId: INACTIVO.id }, 'responsable_invalido'],
        [s.body.id, { tipoServicio: 'a', fecha: dia(new Date(Date.now() + 3 * 86_400_000)), valor: 20, ejecutadoPor: 'interno' }, 'fecha_futura'],
      ];
      for (const [id, cuerpo, code] of casos) {
        const r = await preventivo(id, cuerpo);
        expect([r.status, r.body.code]).toEqual([400, code]);
      }
      // nada quedó registrado por los intentos fallidos
      const filas = await admin.query('SELECT count(*)::int AS n FROM flota.unidad_preventivo WHERE unidad_id = ANY($1::uuid[])', [[s.body.id, t.body.id, x.body.id]]);
      expect(filas.rows[0].n).toBe(0);
    });

    it('un mantenimiento de tercero lleva su proveedor y el responsable por omisión es quien lo registra', async () => {
      const prov = await http().post('/api/operaciones/flota/proveedores-mantenimiento').set(jefe()).send({ nombre: ` Taller IT ${n} ` }).expect(201);
      proveedores.push(prov.body.id);
      expect(prov.body.nombre).toBe(`Taller IT ${n}`);
      const dup = await http().post('/api/operaciones/flota/proveedores-mantenimiento').set(jefe()).send({ nombre: `Taller IT ${n}` });
      expect(dup.status).toBe(409);
      const u = await crear({ codigo: codigo('FLT'), nombre: 'Con tercero', tipo: 'transporte', lecturaInicial: 1000, proveedorMantenimientoId: prov.body.id });
      expect(u.body.proveedorMantenimiento).toEqual({ id: prov.body.id, nombre: `Taller IT ${n}` });
      const p = await preventivo(u.body.id, { fecha: haceDias(1), valor: 1000, ejecutadoPor: 'tercero', proveedorMantenimientoId: prov.body.id, responsableId: RESPONSABLE.id });
      expect(p.status).toBe(201);
      const h = await http().get(`/api/operaciones/flota/unidades/${u.body.id}/preventivos`).set(operador()).expect(200);
      expect(h.body[0]).toMatchObject({ ejecutadoPor: 'tercero', proveedor: { id: prov.body.id }, responsable: { id: RESPONSABLE.id } });
      // se desactiva y deja de ofrecerse
      await http().patch(`/api/operaciones/flota/proveedores-mantenimiento/${prov.body.id}`).set(jefe()).send({ activo: false }).expect(200);
      const lista = await http().get('/api/operaciones/flota/proveedores-mantenimiento').set(operador()).expect(200);
      expect(lista.body.some((x: { id: string }) => x.id === prov.body.id)).toBe(false);
    });

    it('las alertas se filtran por nivel y salen de la más urgente a la menos', async () => {
      const r = await http().get('/api/operaciones/flota/unidades/alertas?nivel=rojo').set(operador()).expect(200);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body.every((a: { nivel: string }) => a.nivel === 'rojo')).toBe(true);
      const todas = await http().get('/api/operaciones/flota/unidades/alertas').set(operador()).expect(200);
      const orden = { rojo: 0, amarillo: 1, verde: 2 } as Record<string, number>;
      const niveles = todas.body.map((a: { nivel: string }) => orden[a.nivel]);
      expect([...niveles].sort((p: number, q: number) => p - q)).toEqual(niveles);
    });
  });

  describe('reglas de la base de datos y anulaciones', () => {
    const appPool = () => new Pool({ connectionString: APP_DB, max: 1 });
    const rechaza = async (q: Promise<unknown>, codigo: string) => {
      await expect(q).rejects.toMatchObject({ code: codigo });
    };
    const anularLectura = (lecturaId: string, motivo = 'Error de digitación') =>
      http().post(`/api/operaciones/flota/lecturas/${lecturaId}/anular`).set(jefe()).send({ motivo });
    const anularPreventivo = (id: string) =>
      http().post(`/api/operaciones/flota/preventivos/${id}/anular`).set(jefe()).send({ motivo: 'Se registró en la unidad equivocada' });

    it('CHECK: la categoría de peso solo existe en transporte', async () => {
      await rechaza(
        admin.query(
          "INSERT INTO flota.unidad (id, codigo, nombre, tipo, categoria_peso) VALUES ($1, $2, 'x', 'servicio', 'pesado')",
          [uuidv7(), `CHK${n}`],
        ),
        '23514',
      );
    });

    it('CHECK: un mantenimiento de tercero exige proveedor y el registrado por la aplicación exige responsable', async () => {
      const u = await crear({ codigo: codigo('FLZ'), nombre: 'Checks', tipo: 'auxiliar' });
      await rechaza(
        admin.query(
          "INSERT INTO flota.unidad_preventivo (id, unidad_id, fecha, ejecutado_por, responsable_id) VALUES ($1, $2, CURRENT_DATE, 'tercero', $3)",
          [uuidv7(), u.body.id, RESPONSABLE.id],
        ),
        '23514',
      );
      await rechaza(
        admin.query(
          "INSERT INTO flota.unidad_preventivo (id, unidad_id, fecha, ejecutado_por, origen) VALUES ($1, $2, CURRENT_DATE, 'interno', 'aplicacion')",
          [uuidv7(), u.body.id],
        ),
        '23514',
      );
    });

    it('FK compuesta: el tipo de lectura debe ser el de la unidad (y las auxiliares no llevan)', async () => {
      const serv = await crear({ codigo: codigo('FLY'), nombre: 'Servicio', tipo: 'servicio' });
      const aux = await crear({ codigo: codigo('FLX'), nombre: 'Aux', tipo: 'auxiliar' });
      const ins = (unidad: string, tipo: string) =>
        admin.query(
          "INSERT INTO flota.unidad_lectura (id, unidad_id, tipo, valor, leida_at, fuente) VALUES ($1, $2, $3::flota.tipo_lectura, 1, now(), 'manual')",
          [uuidv7(), unidad, tipo],
        );
      await rechaza(ins(serv.body.id, 'odometro'), '23503');
      await rechaza(ins(aux.body.id, 'horometro'), '23503');
      await ins(serv.body.id, 'horometro');
    });

    it('historia inmutable y mínimo privilegio: la aplicación no modifica ni borra lecturas, mantenimientos ni anulaciones', async () => {
      const u = await crear({ codigo: codigo('FLI'), nombre: 'Inmutable', tipo: 'servicio', lecturaInicial: 10 });
      await preventivo(u.body.id, { tipoServicio: 'a', fecha: dia(new Date()), valor: 20, ejecutadoPor: 'interno' }).then((r) => expect(r.status).toBe(201));
      const pool = appPool();
      try {
        for (const sql of [
          'UPDATE flota.unidad_lectura SET valor = 0',
          'DELETE FROM flota.unidad_lectura',
          'UPDATE flota.unidad_preventivo SET observaciones = null',
          'DELETE FROM flota.unidad_preventivo',
          'UPDATE flota.unidad_lectura_anulacion SET motivo = null',
          'UPDATE flota.unidad_preventivo_anulacion SET motivo = null',
        ]) {
          await rechaza(pool.query(sql), '42501');
        }
        await rechaza(pool.query('SELECT transportista_id FROM catalogos.vehiculo LIMIT 1'), '42501');
        await pool.query('SELECT id, placa, anio FROM catalogos.vehiculo LIMIT 1');
      } finally {
        await pool.end();
      }
    });

    it('anular una lectura la saca de la vigente y de la línea de tiempo; la que respalda un preventivo vigente no se anula', async () => {
      const u = await crear({ codigo: codigo('FLJ'), nombre: 'Anulaciones', tipo: 'servicio', lecturaInicial: 100 });
      const id = u.body.id;
      const mala = await lectura(id, { tipo: 'horometro', valor: 9000 });
      expect(mala.status).toBe(201);
      await anularLectura(mala.body.id, 'no').then((r) => expect(r.status).toBe(400));
      await http().post(`/api/operaciones/flota/lecturas/${mala.body.id}/anular`).set(operador()).send({ motivo: 'Error de digitación' }).expect(403);
      await anularLectura(mala.body.id).then((r) => expect(r.status).toBe(201));
      const dos = await anularLectura(mala.body.id);
      expect([dos.status, dos.body.code]).toEqual([409, 'lectura_ya_anulada']);
      const ficha = await http().get(`/api/operaciones/flota/unidades/${id}`).set(operador()).expect(200);
      expect(ficha.body.horometro.valor).toBe(100);
      await lectura(id, { tipo: 'horometro', valor: 150 }).then((r) => expect(r.status).toBe(201));
      const hist = await http().get(`/api/operaciones/flota/unidades/${id}/lecturas`).set(operador()).expect(200);
      expect(hist.body.find((l: { id: string }) => l.id === mala.body.id).anulada).toMatchObject({ motivo: 'Error de digitación' });

      const p = await preventivo(id, { tipoServicio: 'a', fecha: dia(new Date()), valor: 200, ejecutadoPor: 'interno' });
      expect(p.status).toBe(201);
      const enUso = await anularLectura(p.body.lecturaId);
      expect([enUso.status, enUso.body.code]).toEqual([409, 'lectura_en_uso']);
      let a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 0 });
      await anularPreventivo(p.body.id).then((r) => expect(r.status).toBe(201));
      const otra = await anularPreventivo(p.body.id);
      expect([otra.status, otra.body.code]).toEqual([409, 'preventivo_ya_anulado']);
      a = await alertasDe(id);
      expect(a.find((x) => x.reglaCodigo === 'servicio_a')).toMatchObject({ consumido: 200 });
      await anularLectura(p.body.lecturaId).then((r) => expect(r.status).toBe(201));
      const ph = await http().get(`/api/operaciones/flota/unidades/${id}/preventivos`).set(operador()).expect(200);
      expect(ph.body[0]).toMatchObject({ origen: 'aplicacion', anulado: { motivo: 'Se registró en la unidad equivocada' } });
      const ev = await admin.query(
        "SELECT tipo FROM msg_operaciones.outbox WHERE tipo IN ('flota.unidad.lectura_anulada','flota.unidad.preventivo_anulado') AND datos->'data'->>'unidadId' = $1",
        [id],
      );
      expect(ev.rows).toHaveLength(3);
    });

    it('los preventivos de la carga inicial quedan marcados como tales', async () => {
      const r = await admin.query(
        "SELECT count(*)::int AS n FROM flota.unidad_preventivo p JOIN flota.unidad u ON u.id = p.unidad_id WHERE u.codigo = 'PUM-07' AND p.origen = 'carga_inicial' AND p.responsable_id IS NULL",
      );
      expect(r.rows[0].n).toBe(2);
    });
  });
});
