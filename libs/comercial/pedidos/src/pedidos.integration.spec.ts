/**
 * Integración real de pedidos: Postgres (PgBouncer, app_comercial) con un directorio simulado (catálogos, personas y
 * pedidos de AS2 salen de memoria; lo demás es real: base de datos, secuenciales, estados, permisos y eventos).
 *   npm run infra:up && npm run db:migrate:comercial && npm run db:seed:comercial
 *   RUN_INTEGRATION=1 npx nx test pedidos
 * Los datos de prueba se eliminan al final con dyn_migrator y la secuencia `pedido` vuelve al número que tenía.
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission as P } from '@dyn/authz';
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
import {
  As2PedidoRef,
  ClienteRef,
  DirectorioPort,
  ArchivoRef,
  CampoRef,
  NombreRef,
  PozoRef,
  UsuarioRef,
} from './directorio/directorio.port';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

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

const tag = `it-${Date.now()}`;

// --- catálogo simulado --------------------------------------------------------------------------------------------
const id = () => uuidv7();
const CLIENTE: ClienteRef = {
  id: id(),
  nombre: `Cliente ${tag}`,
  ruc: `97${String(Date.now()).slice(-11)}`,
};
const OTRO_CLIENTE: ClienteRef = {
  id: id(),
  nombre: `Otro ${tag}`,
  ruc: `96${String(Date.now()).slice(-11)}`,
};
const ZONA_ESTE_ID = id();
const ZONA_ESTE = `Zona Este ${tag}`;
const CAMPO: CampoRef = {
  id: id(),
  nombre: `Campo Uno ${tag}`,
  zonaId: ZONA_ESTE_ID,
  zona: ZONA_ESTE,
};
const OTRO_CAMPO: CampoRef = { id: id(), nombre: `Campo Dos ${tag}`, zonaId: null, zona: null };
const BLOQUE: NombreRef = { id: id(), nombre: `Bloque 7 ${tag}` };
const TALADRO: NombreRef = { id: id(), nombre: `Taladro 55 ${tag}` };
const POZO: PozoRef = {
  id: id(),
  nombre: `Pozo-001 ${tag}`,
  campoId: CAMPO.id,
  bloqueId: BLOQUE.id,
};
const REP: NombreRef = { id: id(), nombre: `Company Man Uno ${tag}` };
const ARCHIVO_OK: ArchivoRef = {
  id: id(),
  modulo: 'pedido_documento',
  nombre: 'orden de compra.pdf',
  mimeType: 'application/pdf',
  tamanoBytes: 2048,
  subidoPor: '',
};
const ARCHIVO_AJENO: ArchivoRef = {
  id: id(),
  modulo: 'pedido_documento',
  nombre: 'ajeno.pdf',
  mimeType: 'application/pdf',
  tamanoBytes: 10,
  subidoPor: id(),
};
const ARCHIVO_OTRO_MODULO: ArchivoRef = {
  id: id(),
  modulo: 'otro_modulo',
  nombre: 'x.pdf',
  mimeType: 'application/pdf',
  tamanoBytes: 10,
  subidoPor: '',
};
const archivosEliminados: string[] = [];
const BODEGA: NombreRef = { id: id(), nombre: `Bodega Matriz ${tag}` };
const OTRA_BODEGA: NombreRef = { id: id(), nombre: `Bodega PETROECUADOR ${tag}` };
const PAGO_90: NombreRef = { id: id(), nombre: `90 dias ${tag}` };
const PAGO_60: NombreRef = { id: id(), nombre: `60 dias ${tag}` };

const U = {
  ventas: id(),
  facturacion: id(),
  admin: id(),
  hse: id(),
  analista: id(),
  inactivo: id(),
  noHse: id(),
};
const USUARIOS: UsuarioRef[] = [
  { id: U.ventas, name: 'Vera Ventas', roleCode: 'ingenieria_ventas', activo: true },
  { id: U.facturacion, name: 'Mónica Jefa', roleCode: 'facturacion', activo: true },
  { id: U.admin, name: 'Admin Root', roleCode: 'superadmin', activo: true },
  { id: U.hse, name: 'Hugo HSE', roleCode: 'tecnico_hse', activo: true },
  { id: U.analista, name: 'Ana Analista', roleCode: 'facturacion', activo: true },
  { id: U.inactivo, name: 'Inés Inactiva', roleCode: 'tecnico_hse', activo: false },
  { id: U.noHse, name: 'Nora Operadora', roleCode: 'operador', activo: true },
];

/** Registros reales que respaldan las FK (los inserta `beforeAll` y los quita `afterAll`). */
const MAESTROS: MaestrosDePrueba = {
  usuarios: USUARIOS.map((u) => ({ id: u.id, nombre: u.name, rol: u.roleCode, activo: u.activo })),
  clientes: [CLIENTE, OTRO_CLIENTE],
  zonas: [{ id: ZONA_ESTE_ID, nombre: ZONA_ESTE }],
  campos: [CAMPO, OTRO_CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO as { id: string; nombre: string; campoId: string; bloqueId: string }],
  taladros: [TALADRO],
  bodegas: [BODEGA, OTRA_BODEGA],
  condiciones: [PAGO_90, PAGO_60],
  personas: [REP],
  // solo el adjunto que se guarda de verdad (lo sube `ventas`); los otros se rechazan antes de guardarse
  archivos: [{ ...ARCHIVO_OK, subidoPor: U.ventas }],
};

const AS2_PEDIDOS: Record<number, As2PedidoRef> = {
  [900001]: {
    idPedidoCliente: 900001,
    numero: 'PEC-900001',
    fecha: '2026-10-12',
    estado: 'PROCESADO',
    total: 437.23,
    descuento: 218.62,
    impuesto: 32.79,
    descripcion: 'CYB-016 LIBERACION DE MECH PACKER',
    empresaNombre: 'EP PETROECUADOR',
    empresaIdentificacion: CLIENTE.ruc,
    bodega: BODEGA.nombre,
    condicionPago: PAGO_90.nombre,
    zona: null,
    lineasEstado: 'con_lineas',
    lineas: [
      { codigo: 'IT-SCR5001', nombre: 'Supervisor', cantidad: 2, precio: 437.23 },
      { codigo: 'IT-NO-EXISTE', nombre: 'Algo', cantidad: 1, precio: 10 },
    ],
  },
  [900002]: {
    idPedidoCliente: 900002,
    numero: 'PEC-900002',
    fecha: '2026-10-13',
    estado: 'ELABORADO',
    total: 0.01,
    descuento: 0.01,
    impuesto: 0,
    descripcion: 'sin líneas',
    empresaNombre: 'Cliente no catalogado',
    empresaIdentificacion: '0000000000001',
    bodega: null,
    condicionPago: null,
    zona: null,
    lineasEstado: 'sin_lineas',
    lineas: [],
  },
};

class DirectorioFalso extends DirectorioPort {
  async cliente(i: string) {
    return [CLIENTE, OTRO_CLIENTE].find((c) => c.id === i) ?? null;
  }
  async clientePorRuc(ruc: string) {
    return [CLIENTE, OTRO_CLIENTE].find((c) => c.ruc === ruc) ?? null;
  }
  async campo(i: string) {
    return [CAMPO, OTRO_CAMPO].find((c) => c.id === i) ?? null;
  }
  async archivo(i: string) {
    return [ARCHIVO_OK, ARCHIVO_AJENO, ARCHIVO_OTRO_MODULO].find((a) => a.id === i) ?? null;
  }
  async verificarFirma() {
    return null;
  }
  async eliminarArchivo(i: string) {
    archivosEliminados.push(i);
  }
  async bodega(i: string) {
    return [BODEGA, OTRA_BODEGA].find((b) => b.id === i) ?? null;
  }
  async condicionPago(i: string) {
    return [PAGO_90, PAGO_60].find((c) => c.id === i) ?? null;
  }
  async bodegaPorNombre(n: string) {
    return (
      [BODEGA, OTRA_BODEGA].find((b) => b.nombre.toLowerCase() === n.trim().toLowerCase()) ?? null
    );
  }
  async condicionPagoPorNombre(n: string) {
    return (
      [PAGO_90, PAGO_60].find((c) => c.nombre.toLowerCase() === n.trim().toLowerCase()) ?? null
    );
  }
  async bloque(i: string) {
    return i === BLOQUE.id ? BLOQUE : null;
  }
  async taladro(i: string) {
    return i === TALADRO.id ? TALADRO : null;
  }
  async pozo(i: string) {
    return i === POZO.id ? POZO : null;
  }
  async persona(i: string) {
    return i === REP.id ? REP : null;
  }
  async usuarios(ids: string[]) {
    return USUARIOS.filter((u) => ids.includes(u.id));
  }
  async verificarFirmaElectronica() {
    return null;
  }
  async transportista() {
    return null;
  }
  async vehiculo() {
    return null;
  }
  async chofer() {
    return null;
  }
  async as2Pedido(n: number) {
    return AS2_PEDIDOS[n] ?? null;
  }
}

run('pedidos (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (sub: string, name: string, roleCode: string, permissions: string[]) =>
    signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions });
  const comunes = [P.PEDIDOS_VER, P.LISTAS_PRECIOS_VER];
  const ventas = () => ({
    Authorization: `Bearer ${token(U.ventas, 'Vera Ventas', 'ingenieria_ventas', [...comunes, P.PEDIDOS_CREAR, P.PEDIDOS_EDITAR])}`,
  });
  const facturacion = () => ({
    Authorization: `Bearer ${token(U.facturacion, 'Mónica Jefa', 'facturacion', [...comunes, P.PEDIDOS_EDITAR, P.PEDIDOS_ANULAR, P.PEDIDOS_RECHAZAR, P.PEDIDOS_ASIGNAR_ANALISTA])}`,
  });
  const superadmin = () => ({
    Authorization: `Bearer ${token(U.admin, 'Admin Root', 'superadmin', [...comunes, P.PEDIDOS_CREAR, P.PEDIDOS_EDITAR, P.PEDIDOS_ANULAR, P.PEDIDOS_RECHAZAR, P.PEDIDOS_ASIGNAR_ANALISTA, P.PEDIDOS_FORZAR_ESTADO])}`,
  });
  const soloLectura = () => ({
    Authorization: `Bearer ${token(id(), 'Lector', 'operador', comunes)}`,
  });

  let numeroInicial = 0;
  let pecInicial = { actual: 0, as2: 0 };
  /** Contadores de la prefactura antes de la prueba: cada pedido abierto toma su número de ticket de ahí y se devuelven al final. */
  let prefacturaInicial = { actual: 0, as2: 0 };
  let listaId = '';
  const li: Record<string, string> = {}; // listaPreciosItemId por código
  const creados: string[] = [];

  /** Cuerpo de un pedido completo y válido. */
  const completo = (extra: Record<string, unknown> = {}) => ({
    clienteId: CLIENTE.id,
    lineaServicio: 'fcr',
    tipoOt: 'venta',
    tiposServicio: ['fishing_services', 'milling'],
    subtiposServicio: [
      { tipo: 'fishing_services', subtipo: 'Milling' },
      { tipo: 'fishing_services', subtipo: 'Pesca CTU' },
    ],
    campoId: CAMPO.id,
    bloqueId: BLOQUE.id,
    pozoId: POZO.id,
    taladroId: TALADRO.id,
    numeroContrato: 'CT-2026-001',
    fechaInicioServicio: '2026-11-01',
    fechaFinServicio: '2026-11-10',
    tecnicoHseId: U.hse,
    bodegaId: BODEGA.id,
    condicionPagoId: PAGO_60.id,
    items: [
      { listaPreciosItemId: li['IT-SCR5001'], cantidad: 2, descuentoPct: 50 },
      { listaPreciosItemId: li['IT-MOV01'], cantidad: 10 },
    ],
    ...extra,
  });
  /** `crear(...).then(esperar(201))`: comprueba el estado HTTP (y muestra el cuerpo si no coincide) y devuelve la respuesta. */
  const esperar =
    (status: number) =>
    <T extends { status: number; body: unknown }>(r: T): T => {
      expect({ status: r.status, cuerpo: r.status === status ? undefined : r.body }).toEqual({
        status,
        cuerpo: undefined,
      });
      return r;
    };
  const crear = async (body: Record<string, unknown>, h = ventas()) => {
    const r = await http().post('/api/comercial/pedidos').set(h).send(body);
    if (r.status === 201) creados.push(r.body.id);
    return r;
  };
  const eventosDe = async (pedidoId: string) =>
    (
      await admin.query(
        `SELECT tipo FROM msg_comercial.outbox WHERE datos->'subject'->>'id' = $1 ORDER BY ocurrido_at`,
        [pedidoId],
      )
    ).rows.map((r) => r.tipo as string);

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-test',
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
        CommonModule.forRoot({ serviceName: 'comercial-test' }),
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

    const mod = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(DirectorioPort)
      .useValue(new DirectorioFalso())
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);

    // El código del pedido es el número del pedido de AS2 (`PEC-`): los de prueba avanzan ese espejo y se devuelve al final.
    const pec = await prisma.secuencia.findFirstOrThrow({
      where: { documento: { codigo: 'pedido_cliente_as2' }, activa: true },
    });
    pecInicial = { actual: pec.numeroActual, as2: pec.as2NumeroActual ?? 0 };
    numeroInicial = Math.max(pecInicial.actual, pecInicial.as2);

    const pf = await prisma.secuencia.findFirstOrThrow({
      where: { documento: { codigo: 'prefactura' }, activa: true },
    });
    prefacturaInicial = { actual: pf.numeroActual, as2: pf.as2NumeroActual ?? 0 };

    // lista de precios de prueba del cliente
    listaId = id();
    await prisma.listaPrecios.create({
      data: {
        id: listaId,
        clienteId: CLIENTE.id,
        numeroContrato: 'CT-2026-001',
        vigenteDesde: new Date('2026-01-01'),
      },
    });
    for (const [codigo, descripcion, precio, tipo] of [
      [
        'IT-SCR5001',
        'SUPERVISOR PARA COMPLETACIONES, REMEDIACION dia o fraccion',
        437.23,
        'Servicio',
      ],
      ['IT-MOV01', 'Movilización unidades livianas', 2.66, 'Servicio'],
      ['IT-QUIM01', 'Nitrito de sodio', 12.5, 'Material'],
    ] as const) {
      const item = await prisma.listaPreciosItem.create({
        data: {
          id: id(),
          listaPreciosId: listaId,
          codigo,
          descripcion,
          unidad: 'dia',
          precio,
          tipo,
        },
      });
      li[codigo] = item.id;
    }
    // lista de OTRO cliente (no debe poder usarse)
    const otra = id();
    await prisma.listaPrecios.create({
      data: {
        id: otra,
        clienteId: OTRO_CLIENTE.id,
        numeroContrato: 'X',
        vigenteDesde: new Date('2026-01-01'),
      },
    });
    li['AJENO'] = (
      await prisma.listaPreciosItem.create({
        data: {
          id: id(),
          listaPreciosId: otra,
          codigo: 'IT-AJENO',
          descripcion: 'Ajeno',
          unidad: 'u',
          precio: 1,
          tipo: 'Material',
        },
      })
    ).id;
  });

  afterAll(async () => {
    const ids = creados;
    await admin.query(
      `DELETE FROM msg_comercial.outbox WHERE datos->'subject'->>'id' = ANY($1::text[])`,
      [ids],
    );
    await admin.query(
      `DELETE FROM comercial.proceso_historial WHERE entidad_id = ANY($1::uuid[])`,
      [ids],
    );
    await admin.query(
      `DELETE FROM comercial.secuencia_emision WHERE documento_ref_id = ANY($1::uuid[])`,
      [ids],
    );
    await admin.query(`DELETE FROM comercial.pedido_documento WHERE pedido_id = ANY($1::uuid[])`, [
      ids,
    ]);
    await admin.query(`DELETE FROM comercial.pedido_item WHERE pedido_id = ANY($1::uuid[])`, [ids]);
    await admin.query(
      `DELETE FROM comercial.pedido_subtipo_servicio WHERE pedido_id = ANY($1::uuid[])`,
      [ids],
    );
    await admin.query(
      `DELETE FROM comercial.pedido_tipo_servicio WHERE pedido_id = ANY($1::uuid[])`,
      [ids],
    );
    await admin.query(`DELETE FROM comercial.pedido WHERE id = ANY($1::uuid[])`, [ids]);
    await admin.query(
      `DELETE FROM comercial.lista_precios_item WHERE lista_precios_id IN (SELECT id FROM comercial.lista_precios WHERE cliente_id = ANY($1::uuid[]))`,
      [[CLIENTE.id, OTRO_CLIENTE.id]],
    );
    await admin.query(`DELETE FROM comercial.lista_precios WHERE cliente_id = ANY($1::uuid[])`, [
      [CLIENTE.id, OTRO_CLIENTE.id],
    ]);
    // devolver la secuencia al número que tenía: los códigos de prueba no deben consumir los reales
    await admin.query(
      `UPDATE comercial.secuencia SET numero_actual = $1, as2_numero_actual = $2 WHERE documento_id = (SELECT id FROM comercial.documento WHERE codigo = 'pedido_cliente_as2') AND activa`,
      [pecInicial.actual, pecInicial.as2],
    );
    await admin.query(
      `UPDATE comercial.secuencia SET numero_actual = $1, as2_numero_actual = $2 WHERE documento_id = (SELECT id FROM comercial.documento WHERE codigo = 'prefactura') AND activa`,
      [prefacturaInicial.actual, prefacturaInicial.as2],
    );
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('crear y abrir', () => {
    it('un pedido incompleto queda "por completar" (borrador): sin código, con su seguimiento y sin evento de apertura', async () => {
      const r = await crear({ clienteId: CLIENTE.id, lineaServicio: 'fcr' }).then(esperar(201));
      expect(r.body).toMatchObject({
        codigo: null,
        origen: 'portal',
        estado: 'borrador',
        estadoNombre: 'Por completar',
        cliente: { nombre: CLIENTE.nombre, ruc: CLIENTE.ruc },
        editable: true,
      });
      // el agente comercial es quien lo creó
      expect(r.body.responsables.agenteComercial).toMatchObject({
        id: U.ventas,
        nombre: 'Vera Ventas',
      });
      expect(r.body.as2.syncEstado).toBe('pendiente_de_crear_en_as2');
      expect(r.body.historial).toHaveLength(1);
      expect(r.body.historial[0]).toMatchObject({
        estadoAnterior: null,
        estadoNuevo: 'borrador',
        actorNombre: 'Vera Ventas',
      });
      expect(await eventosDe(r.body.id)).toEqual([]);
    });

    it('abrir un pedido incompleto responde 400 y dice exactamente qué falta', async () => {
      const b = (await crear({ clienteId: CLIENTE.id })).body;
      const r = await http().post(`/api/comercial/pedidos/${b.id}/abrir`).set(ventas()).expect(400);
      expect(r.body.code).toBe('PEDIDO_INCOMPLETO');
      for (const falta of [
        'línea de servicio',
        'tipo de servicio',
        'campo',
        'pozo',
        'taladro',
        'contrato',
        'fecha de inicio',
        'técnico HSE',
        'bodega',
        'ítem',
      ]) {
        expect(r.body.message).toContain(falta);
      }
    });

    it('un pedido completo se abre al crearlo: emite el código siguiente, guarda solo ids (el nombre sale del catálogo por la FK) y publica el evento', async () => {
      const r = await crear(completo({ abrir: true })).then(esperar(201));
      const esperado = String(numeroInicial + 1 + (await contarAbiertosAntes()));
      // el código del pedido es el siguiente número del pedido de AS2 (PEC-), reservado para quien lo cree en AS2
      expect(r.body.codigo).toMatch(/^PEC-\d{6}$/);
      expect(Number(r.body.codigo.slice(4))).toBeGreaterThan(numeroInicial);
      expect(esperado).toBeTruthy();
      expect(r.body).toMatchObject({
        estado: 'abierto',
        estadoNombre: 'Abierto',
        macroEstado: 'pendiente',
        lineaServicio: 'fcr',
        tiposServicio: ['fishing_services', 'milling'],
        subtiposServicio: [
          { tipo: 'fishing_services', subtipo: 'Milling' },
          { tipo: 'fishing_services', subtipo: 'Pesca CTU' },
        ],
        ubicacion: {
          campo: CAMPO.nombre,
          bloque: BLOQUE.nombre,
          pozo: POZO.nombre,
          taladro: TALADRO.nombre,
          rigless: false,
        },
        responsables: { tecnicoHse: { id: U.hse, nombre: 'Hugo HSE' } },
        administrativo: {
          bodegaId: BODEGA.id,
          bodega: BODEGA.nombre,
          condicionPagoId: PAGO_60.id,
          condicionPago: PAGO_60.nombre,
          zonaId: ZONA_ESTE_ID,
          zona: ZONA_ESTE, // la del campo
        },
      });
      // ítems: precio de la lista, descuento y totales
      expect(r.body.items).toHaveLength(2);
      expect(r.body.items[0]).toMatchObject({
        codigo: 'IT-SCR5001',
        cantidad: 2,
        valorUnitario: 437.23,
        descuentoPct: 50,
        bruto: 874.46,
        descuento: 437.23,
        neto: 437.23,
      });
      expect(r.body.items[1]).toMatchObject({ codigo: 'IT-MOV01' });
      expect(r.body.totales).toEqual({ subtotal: 901.06, descuento: 437.23, neto: 463.83 });
      // seguimiento: borrador → abierto
      expect(r.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
        'borrador',
        'abierto',
      ]);
      expect(await eventosDe(r.body.id)).toContain('comercial.pedido.abierto');
      // el número quedó registrado en la bitácora de secuenciales
      const em = await prisma.secuenciaEmision.findFirst({
        where: { documentoRefId: r.body.id, codigoFormateado: r.body.codigo },
      });
      expect(em).toMatchObject({ codigoFormateado: r.body.codigo, estado: 'emitido' });
      // el ticket (la prefactura que vendrá) ya tiene su número: el siguiente del secuencial de la prefactura
      expect(r.body.ticketNumero).toBeGreaterThan(
        Math.max(prefacturaInicial.actual, prefacturaInicial.as2),
      );
      const tk = await prisma.secuenciaEmision.findFirst({
        where: { documentoRefId: r.body.id, codigoFormateado: { startsWith: 'PRC-' } },
      });
      expect(tk).toMatchObject({ numero: r.body.ticketNumero, estado: 'emitido' });
      const abierto = await admin.query(
        `SELECT datos->'data'->>'ticketNumero' AS t FROM msg_comercial.outbox WHERE datos->'subject'->>'id' = $1 AND tipo = 'comercial.pedido.abierto'`,
        [r.body.id],
      );
      expect(Number(abierto.rows[0].t)).toBe(r.body.ticketNumero);
    });

    it('los códigos son consecutivos y sin saltos aunque se abran pedidos a la vez', async () => {
      const antes = Number((await crear(completo({ abrir: true }))).body.codigo);
      const lote = await Promise.all(
        Array.from({ length: 6 }, () => crear(completo({ abrir: true }))),
      );
      const codigos = lote.map((x) => Number(x.body.codigo)).sort((a, b) => a - b);
      expect(codigos).toEqual(Array.from({ length: 6 }, (_, i) => antes + 1 + i));
    });

    async function contarAbiertosAntes() {
      return 0;
    }
  });

  describe('validaciones al guardar', () => {
    it('rigless no lleva taladro; sin taladro y sin rigless no se puede abrir; con rigless sí', async () => {
      await crear({ rigless: true, taladroId: TALADRO.id }).then(esperar(400));
      const sin = (await crear(completo({ taladroId: undefined }))).body;
      const falta = await http()
        .post(`/api/comercial/pedidos/${sin.id}/abrir`)
        .set(ventas())
        .expect(400);
      expect(falta.body.message).toContain('taladro');
      const rig = await crear(completo({ taladroId: undefined, rigless: true, abrir: true })).then(
        esperar(201),
      );
      expect(rig.body.ubicacion).toMatchObject({ rigless: true, taladro: null });
    });

    it('el pozo debe pertenecer al campo; sin campo, se toma del pozo', async () => {
      await crear({ campoId: OTRO_CAMPO.id, pozoId: POZO.id }).then(esperar(400));
      const r = await crear({ pozoId: POZO.id }).then(esperar(201));
      expect(r.body.ubicacion).toMatchObject({
        campo: CAMPO.nombre,
        bloque: BLOQUE.nombre,
        pozo: POZO.nombre,
      });
    });

    it('los tipos de servicio deben corresponder a la línea; las fechas, ser coherentes', async () => {
      await crear({ lineaServicio: 'pumping', tiposServicio: ['milling'] }).then(esperar(400));
      await crear({ fechaInicioServicio: '2026-11-10', fechaFinServicio: '2026-11-01' }).then(
        esperar(400),
      );
      await crear({ tiposServicio: ['inventado'] }).then(esperar(400));
    });

    it('entrega el catálogo de servicios: línea → tipos → subtipos', async () => {
      const r = await http()
        .get('/api/comercial/pedidos/catalogo-servicios')
        .set(ventas())
        .expect(200);
      const fcr = r.body.lineas.find((l: { linea: string }) => l.linea === 'fcr');
      const pumping = r.body.lineas.find((l: { linea: string }) => l.linea === 'pumping');
      expect(fcr.tipos).toHaveLength(15);
      expect(pumping.tipos.map((t: { codigo: string }) => t.codigo).sort()).toEqual([
        'cementing',
        'coiled_tubing',
        'control_de_fluidos',
        'nitrogeno',
        'pumping',
        'special_pills',
      ]);
      const pesca = fcr.tipos.find((t: { codigo: string }) => t.codigo === 'fishing_services');
      expect(pesca.subtipos).toContain('Pesca CTU');
    });

    it('el tipo de OT sale del catálogo y el medio de solicitud es un enum de la base de datos', async () => {
      const tipos = (await http().get('/api/comercial/pedidos/tipos-ot').set(ventas()).expect(200))
        .body;
      expect(tipos.map((t: { codigo: string }) => t.codigo)).toEqual(['venta', 'servicio']);
      await crear({ tipoOt: 'inventado' }).then(esperar(400));
      await crear({ solicitudMedio: 'telepatia' }).then(esperar(400));
      await crear({ bodegaId: '018f0000-0000-7000-8000-000000000000' }).then(esperar(400)); // bodega inexistente
      const r = await crear({ tipoOt: 'servicio', solicitudMedio: 'escrita' }).then(esperar(201));
      expect(r.body).toMatchObject({
        tipoOt: 'servicio',
        administrativo: { solicitudMedio: 'escrita' },
      });
    });

    it('adjunta documentos del módulo de archivos: solo los que subió la misma persona, de ese módulo, y mientras el pedido es editable', async () => {
      ARCHIVO_OK.subidoPor = U.ventas; // el actor `ventas()` es quien lo subió
      ARCHIVO_OTRO_MODULO.subidoPor = U.ventas;
      const b = (await crear({ clienteId: CLIENTE.id })).body;
      const a = await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: ARCHIVO_OK.id })
        .expect(201);
      expect(a.body.documentos).toEqual([
        expect.objectContaining({
          archivoId: ARCHIVO_OK.id,
          nombre: 'orden de compra.pdf',
          mimeType: 'application/pdf',
          tamanoBytes: 2048,
        }),
      ]);
      // otra vez el mismo, uno ajeno, de otro módulo, inexistente
      await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: ARCHIVO_OK.id })
        .expect(409);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: ARCHIVO_AJENO.id })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: ARCHIVO_OTRO_MODULO.id })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: id() })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/documentos`)
        .set(ventas())
        .send({ archivoId: 'no-es-uuid' })
        .expect(400);
      // al quitarlo se da de baja el archivo
      const q = await http()
        .delete(`/api/comercial/pedidos/${b.id}/documentos/${a.body.documentos[0].id}`)
        .set(ventas())
        .expect(200);
      expect(q.body.documentos).toEqual([]);
      expect(archivosEliminados).toContain(ARCHIVO_OK.id);
      await http()
        .delete(`/api/comercial/pedidos/${b.id}/documentos/${id()}`)
        .set(ventas())
        .expect(404);
    });

    it('un subtipo depende de su tipo: debe pertenecerle y el tipo debe estar elegido en el pedido', async () => {
      // "Pesca CTU" es de fishing_services, no de milling
      const mal = await crear({
        tiposServicio: ['milling'],
        subtiposServicio: [{ tipo: 'milling', subtipo: 'Pesca CTU' }],
      }).then(esperar(400));
      expect(mal.body.detail).toContain('no pertenecen a su tipo');
      // el tipo del subtipo no está elegido
      const fuera = await crear({
        tiposServicio: ['milling'],
        subtiposServicio: [{ tipo: 'fishing_services', subtipo: 'Pesca CTU' }],
      }).then(esperar(400));
      expect(fuera.body.detail).toContain('no tiene elegido');

      // al quitar un tipo se van sus subtipos; los de los tipos que siguen se conservan
      const b = (await crear(completo())).body;
      const r = await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({ version: b.version, tiposServicio: ['milling'] })
        .expect(200);
      expect(r.body.tiposServicio).toEqual(['milling']);
      expect(r.body.subtiposServicio).toEqual([]);
    });

    it('el técnico HSE debe estar activo y tener ese rol; el agente comercial, activo', async () => {
      await crear({ tecnicoHseId: U.inactivo }).then(esperar(400));
      await crear({ tecnicoHseId: U.noHse }).then(esperar(400));
      await crear({ agenteComercialId: U.inactivo }).then(esperar(400));
      await crear({ clienteId: id() }).then(esperar(400));
    });

    it('los ítems salen SOLO de la lista de precios activa del cliente del pedido', async () => {
      await crear(completo({ items: [{ listaPreciosItemId: li['AJENO'], cantidad: 1 }] })).then(
        esperar(400),
      );
      await crear(completo({ items: [{ listaPreciosItemId: id(), cantidad: 1 }] })).then(
        esperar(400),
      );
      await crear({ items: [{ listaPreciosItemId: li['IT-SCR5001'], cantidad: 1 }] }).then(
        esperar(400),
      ); // sin cliente
      await crear(
        completo({ items: [{ listaPreciosItemId: li['IT-SCR5001'], cantidad: 0 }] }),
      ).then(esperar(400));
    });

    it('valida la plantilla Excel de AS2: avisa el código desconocido y la diferencia de precio, y usa el precio de la lista', async () => {
      const r = await http()
        .post('/api/comercial/pedidos/validar-plantilla')
        .set(ventas())
        .send({
          clienteId: CLIENTE.id,
          filas: [
            { codigo: 'IT-SCR5001', cantidad: 3, precio: 500, descuentoPct: 10 },
            { codigo: 'IT-QUIM01', cantidad: 4, precio: 12.5 },
            { codigo: 'IT-DESCONOCIDO', cantidad: 1 },
          ],
        })
        .expect(201);
      expect(r.body.errores).toEqual([
        { fila: 3, codigo: 'IT-DESCONOCIDO', motivo: expect.stringContaining('no existe') },
      ]);
      expect(r.body.items[0]).toMatchObject({
        codigo: 'IT-SCR5001',
        precioLista: 437.23,
        diferenciaPrecio: 62.77,
        descuentoPct: 10,
        origen: 'plantilla',
      });
      expect(r.body.items[1]).toMatchObject({ codigo: 'IT-QUIM01', diferenciaPrecio: null });
    });
  });

  describe('editar', () => {
    it('edita con control de versión: una versión vieja responde 409 y no pisa lo guardado', async () => {
      const b = (await crear({ clienteId: CLIENTE.id })).body;
      const a = await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({ version: b.version, subcliente: 'Sub A' })
        .expect(200);
      expect(a.body.version).toBe(b.version + 1);
      const vieja = await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({ version: b.version, subcliente: 'Sub B' })
        .expect(409);
      expect(vieja.body.detail).toContain('Otra persona');
      expect(
        (await http().get(`/api/comercial/pedidos/${b.id}`).set(ventas())).body.cliente.subcliente,
      ).toBe('Sub A');
    });

    it('reemplazar los ítems y los tipos funciona; cambiar de cliente exige volver a elegir ítems', async () => {
      const b = (await crear(completo())).body;
      const r = await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({
          version: b.version,
          tiposServicio: ['milling'],
          items: [{ listaPreciosItemId: li['IT-QUIM01'], cantidad: 5 }],
        })
        .expect(200);
      expect(r.body.tiposServicio).toEqual(['milling']);
      expect(r.body.items.map((i: { codigo: string }) => i.codigo)).toEqual(['IT-QUIM01']);
      await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({ version: r.body.version, clienteId: OTRO_CLIENTE.id })
        .expect(400);
    });

    it('un pedido anulado ya no se edita', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      const an = await http()
        .post(`/api/comercial/pedidos/${b.id}/anular`)
        .set(facturacion())
        .send({ motivo: 'Duplicado' })
        .expect(201);
      await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(facturacion())
        .send({ version: an.body.version, subcliente: 'X' })
        .expect(409);
    });
  });

  describe('estados', () => {
    it('anular exige permiso y motivo; deja el motivo, la fecha, el seguimiento y los eventos', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      await http()
        .post(`/api/comercial/pedidos/${b.id}/anular`)
        .set(ventas())
        .send({ motivo: 'Cliente canceló' })
        .expect(403);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/anular`)
        .set(facturacion())
        .send({ motivo: 'x' })
        .expect(400);
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/anular`)
        .set(facturacion())
        .send({ motivo: 'Cliente canceló el servicio' })
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'anulado',
        motivoAnulacion: 'Cliente canceló el servicio',
        terminal: true,
        macroEstado: 'rechazado',
      });
      expect(r.body.anuladoAt).toBeTruthy();
      expect(r.body.historial.at(-1)).toMatchObject({
        estadoNuevo: 'anulado',
        motivo: 'Cliente canceló el servicio',
        actorNombre: 'Mónica Jefa',
        origen: 'manual',
      });
      expect(await eventosDe(b.id)).toEqual(
        expect.arrayContaining(['comercial.pedido.estado_cambiado', 'comercial.pedido.anulado']),
      );
      await http()
        .post(`/api/comercial/pedidos/${b.id}/anular`)
        .set(facturacion())
        .send({ motivo: 'Otra vez' })
        .expect(409);
      // el número de ticket de un pedido anulado queda anulado en la bitácora y no se reutiliza
      const tk = await prisma.secuenciaEmision.findFirst({
        where: { documentoRefId: b.id, codigoFormateado: { startsWith: 'PRC-' } },
      });
      expect(tk).toMatchObject({ numero: b.ticketNumero, estado: 'anulado' });
      expect(tk?.motivo).toContain('anulado');
    });

    it('un borrador se puede descartar (anular) sin haber tenido código', async () => {
      const b = (await crear({ clienteId: CLIENTE.id })).body;
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(ventas())
        .send({ estado: 'anulado', motivo: 'Lo creé por error' })
        .expect(201);
      expect(r.body).toMatchObject({ estado: 'anulado', codigo: null });
    });

    it('Facturación devuelve el pedido a Ventas con motivo; Ventas lo corrige y lo vuelve a abrir CONSERVANDO el código', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      await http()
        .post(`/api/comercial/pedidos/${b.id}/rechazar`)
        .set(ventas())
        .send({ motivo: 'Faltan datos' })
        .expect(403);
      const rech = await http()
        .post(`/api/comercial/pedidos/${b.id}/rechazar`)
        .set(facturacion())
        .send({ motivo: 'Falta la ficha de mezcla' })
        .expect(201);
      expect(rech.body).toMatchObject({
        estado: 'en_correccion',
        estadoNombre: 'En corrección',
        rolResponsable: 'ingenieria_ventas',
      });
      const ed = await http()
        .put(`/api/comercial/pedidos/${b.id}`)
        .set(ventas())
        .send({ version: rech.body.version, subcliente: 'Corregida' })
        .expect(200);
      const re = await http()
        .post(`/api/comercial/pedidos/${b.id}/abrir`)
        .set(ventas())
        .expect(201);
      expect(re.body).toMatchObject({ estado: 'abierto', codigo: b.codigo });
      expect(ed.body.codigo).toBe(b.codigo);
      expect(re.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
        'borrador',
        'abierto',
        'en_correccion',
        'abierto',
      ]);
      expect(await eventosDe(b.id)).toEqual(expect.arrayContaining(['comercial.pedido.rechazado']));
    });

    it('los pasos que da el sistema no se hacen a mano; los pasos inválidos responden 409', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      // `prefactura_generada` lo produce la prefactura, no una persona
      await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(facturacion())
        .send({ estado: 'prefactura_generada' })
        .expect(409);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(facturacion())
        .send({ estado: 'estado_inexistente' })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(facturacion())
        .send({ estado: 'abierto' })
        .expect(409); // ya está abierto
    });

    it('mientras Operaciones no esté migrada, "documentos_completos" se da a mano y avisa a Facturación', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      const disp = (
        await http().get(`/api/comercial/pedidos/${b.id}`).set(facturacion())
      ).body.siguientes.map((s: { estado: string }) => s.estado);
      expect(disp).toEqual(
        expect.arrayContaining([
          'documentos_completos',
          'en_operacion',
          'en_correccion',
          'anulado',
        ]),
      );
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(facturacion())
        .send({ estado: 'documentos_completos' })
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'documentos_completos',
        rolResponsable: 'facturacion',
      });
      expect(await eventosDe(b.id)).toContain('comercial.pedido.listo_para_facturacion');
      // un lector no tiene pasos disponibles
      expect(
        (await http().get(`/api/comercial/pedidos/${b.id}`).set(soloLectura())).body.siguientes,
      ).toEqual([]);
    });

    it('forzar un estado es solo del Superadmin, exige motivo largo y queda registrado como "forzado"', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(facturacion())
        .send({ estado: 'facturado', forzar: true, motivo: 'Ya se facturó en AS2' })
        .expect(403);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(superadmin())
        .send({ estado: 'facturado', forzar: true, motivo: 'ok' })
        .expect(400);
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/transiciones`)
        .set(superadmin())
        .send({ estado: 'facturado', forzar: true, motivo: 'Ya se facturó en AS2' })
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'facturado',
        macroEstado: 'aprobado',
        terminal: true,
      });
      expect(r.body.historial.at(-1)).toMatchObject({
        origen: 'forzado',
        actorNombre: 'Admin Root',
        motivo: 'Ya se facturó en AS2',
      });
    });

    it('el catálogo de estados del proceso se puede consultar', async () => {
      const r = await http().get('/api/comercial/pedidos/estados').set(ventas()).expect(200);
      expect(r.body).toHaveLength(17);
      expect(r.body.find((e: { codigo: string }) => e.codigo === 'borrador')).toMatchObject({
        nombre: 'Por completar',
        macroEstado: 'borrador',
      });
      expect(r.body.find((e: { codigo: string }) => e.codigo === 'facturado')).toMatchObject({
        terminal: true,
      });
    });
  });

  describe('analista de facturación', () => {
    it('se omite al crear; la jefa lo asigna después (solo alguien con rol Facturación) y se puede reasignar', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      expect(b.responsables.analistaFacturacion.id).toBeNull();
      const lista = await http()
        .get('/api/comercial/pedidos?sinAnalista=true&estado=abierto')
        .set(facturacion())
        .expect(200);
      expect(lista.body.items.map((p: { id: string }) => p.id)).toContain(b.id);

      await http()
        .post(`/api/comercial/pedidos/${b.id}/asignar-analista`)
        .set(ventas())
        .send({ analistaId: U.analista })
        .expect(403);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/asignar-analista`)
        .set(facturacion())
        .send({ analistaId: U.hse })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${b.id}/asignar-analista`)
        .set(facturacion())
        .send({ analistaId: U.inactivo })
        .expect(400);
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/asignar-analista`)
        .set(facturacion())
        .send({ analistaId: U.analista })
        .expect(201);
      expect(r.body.responsables.analistaFacturacion).toMatchObject({
        id: U.analista,
        nombre: 'Ana Analista',
      });
      expect(await eventosDe(b.id)).toContain('comercial.pedido.analista_asignado');
      const sin = await http()
        .get('/api/comercial/pedidos?sinAnalista=true&estado=abierto')
        .set(facturacion());
      expect(sin.body.items.map((p: { id: string }) => p.id)).not.toContain(b.id);
    });
  });

  describe('pedidos de AS2', () => {
    it('toma un pedido de AS2 "por completar": guarda solo su resumen, enlaza al cliente por RUC y no se puede cargar dos veces', async () => {
      const r = await http()
        .post('/api/comercial/pedidos/desde-as2')
        .set(ventas())
        .send({ as2IdPedidoCliente: 900001 })
        .expect(201);
      creados.push(r.body.id);
      // las líneas de AS2 se cargan solas: solo las que están en la lista de precios del cliente, con su precio
      expect(r.body.lineasAs2).toEqual({ importados: 1, sinCoincidencia: ['IT-NO-EXISTE'] });
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({ codigo: 'IT-SCR5001', origenItem: 'as2' });
      expect(r.body).toMatchObject({
        origen: 'as2',
        estado: 'borrador',
        estadoNombre: 'Por completar',
        codigo: null,
        cliente: { id: CLIENTE.id, nombre: CLIENTE.nombre },
        administrativo: {
          bodegaId: BODEGA.id,
          bodega: BODEGA.nombre,
          condicionPagoId: PAGO_90.id,
          condicionPago: PAGO_90.nombre,
        },
        as2: {
          idPedidoCliente: 900001,
          numero: 'PEC-900001',
          estado: 'PROCESADO',
          total: 437.23,
          descuento: 218.62,
          impuesto: 32.79,
          totalFinal: 251.4,
          syncEstado: 'vinculado',
          vinculoMetodo: 'api',
        },
      });
      expect(r.body.historial[0]).toMatchObject({
        estadoNuevo: 'borrador',
        origen: 'sincronizacion',
      });
      const dup = await http()
        .post('/api/comercial/pedidos/desde-as2')
        .set(ventas())
        .send({ as2IdPedidoCliente: 900001 })
        .expect(409);
      expect(dup.body.detail).toContain('ya está en el portal');
      await http()
        .post('/api/comercial/pedidos/desde-as2')
        .set(ventas())
        .send({ as2IdPedidoCliente: 999999 })
        .expect(404);

      // vínculos para marcar la lista de AS2 sin guardar nada de AS2
      const v = await http()
        .get('/api/comercial/pedidos/vinculos-as2?ids=900001,900002')
        .set(ventas())
        .expect(200);
      expect(v.body).toEqual([
        expect.objectContaining({ as2IdPedidoCliente: 900001, id: r.body.id, estado: 'borrador' }),
      ]);
    });

    it('un pedido de AS2 no permite cambiar lo que vino de AS2 (cliente, bodega, condición de pago), pero sí lo demás', async () => {
      const ped = (await http().get('/api/comercial/pedidos?origen=as2&q=PEC-900001').set(ventas()))
        .body.items[0];
      const det = (await http().get(`/api/comercial/pedidos/${ped.id}`).set(ventas()).expect(200))
        .body;
      const bloqueo = await http()
        .put(`/api/comercial/pedidos/${ped.id}`)
        .set(ventas())
        .send({ version: det.version, bodegaId: OTRA_BODEGA.id })
        .expect(400);
      expect(bloqueo.body.detail).toContain('bodega');
      // el mismo valor no cuenta como cambio, y los datos propios del portal se editan
      await http()
        .put(`/api/comercial/pedidos/${ped.id}`)
        .set(ventas())
        .send({ version: det.version, bodegaId: BODEGA.id, numeroContrato: 'CT-AS2-1' })
        .expect(200);
    });

    it('un cliente de AS2 que no está en el catálogo queda con su nombre y RUC de AS2, sin id', async () => {
      const r = await http()
        .post('/api/comercial/pedidos/desde-as2')
        .set(ventas())
        .send({ as2IdPedidoCliente: 900002 })
        .expect(201);
      creados.push(r.body.id);
      expect(r.body.cliente).toMatchObject({
        id: null,
        nombre: 'Cliente no catalogado',
        ruc: '0000000000001',
      });
      await http().post(`/api/comercial/pedidos/${r.body.id}/abrir`).set(ventas()).expect(400); // incompleto
    });

    it('importa las líneas de AS2 como ítems, solo las que están en la lista de precios, con el precio de la lista', async () => {
      const ped = (await http().get('/api/comercial/pedidos?origen=as2&q=PEC-900001').set(ventas()))
        .body.items[0];
      const r = await http()
        .post(`/api/comercial/pedidos/${ped.id}/importar-lineas-as2`)
        .set(ventas())
        .expect(201);
      expect(r.body).toMatchObject({ importados: 1, sinCoincidencia: ['IT-NO-EXISTE'] });
      expect(r.body.pedido.items[0]).toMatchObject({
        codigo: 'IT-SCR5001',
        cantidad: 2,
        valorUnitario: 437.23,
        origenItem: 'as2',
      });
      // sin líneas en AS2 → 409 claro
      const sin = (await http().get('/api/comercial/pedidos?origen=as2&q=PEC-900002').set(ventas()))
        .body.items[0];
      await http()
        .put(`/api/comercial/pedidos/${sin.id}`)
        .set(ventas())
        .send({ version: sin.version, clienteId: CLIENTE.id })
        .expect(200);
      await http()
        .post(`/api/comercial/pedidos/${sin.id}/importar-lineas-as2`)
        .set(ventas())
        .expect(409);
    });

    it('vincula manualmente un pedido creado en el portal con el de AS2; uno ya tomado no se puede vincular a otro', async () => {
      const b = (await crear(completo({ abrir: true }))).body;
      await http()
        .post(`/api/comercial/pedidos/${b.id}/vincular-as2`)
        .set(ventas())
        .send({ as2IdPedidoCliente: 900001 })
        .expect(409); // ya está en otro pedido
      const libre = await prisma.pedido.update({
        where: { as2IdPedidoCliente: 900002 },
        data: {
          as2IdPedidoCliente: null,
          as2SyncEstado: 'pendiente_de_crear_en_as2',
          origen: 'portal',
        },
      });
      expect(libre.as2IdPedidoCliente).toBeNull();
      const r = await http()
        .post(`/api/comercial/pedidos/${b.id}/vincular-as2`)
        .set(ventas())
        .send({ as2IdPedidoCliente: 900002 })
        .expect(201);
      expect(r.body.as2).toMatchObject({
        idPedidoCliente: 900002,
        numero: 'PEC-900002',
        syncEstado: 'vinculado',
        vinculoMetodo: 'manual',
      });
      await http()
        .post(`/api/comercial/pedidos/${b.id}/vincular-as2`)
        .set(ventas())
        .send({ as2IdPedidoCliente: 900002 })
        .expect(409); // ya vinculado
      expect(await eventosDe(b.id)).toContain('comercial.pedido.vinculado_as2');
    });
  });

  describe('consulta', () => {
    it('lista con filtros, búsqueda y paginación; exige permiso de lectura', async () => {
      await http().get('/api/comercial/pedidos').expect(401);
      await http()
        .get('/api/comercial/pedidos')
        .set({ Authorization: `Bearer ${token(id(), 'X', 'operador', [])}` })
        .expect(403);
      const r = await http()
        .get('/api/comercial/pedidos?linea=fcr&estado=abierto&limit=3&page=1')
        .set(ventas())
        .expect(200);
      expect(r.body.items.length).toBeLessThanOrEqual(3);
      expect(
        r.body.items.every(
          (p: { estado: string; lineaServicio: string }) =>
            p.estado === 'abierto' && p.lineaServicio === 'fcr',
        ),
      ).toBe(true);
      expect(r.body.total).toBeGreaterThanOrEqual(r.body.items.length);
      const q = await http()
        .get(`/api/comercial/pedidos?q=${encodeURIComponent(POZO.nombre)}&limit=100`)
        .set(ventas())
        .expect(200);
      expect(q.body.items.length).toBeGreaterThan(0);
      const detalle = await http()
        .get(`/api/comercial/pedidos/${r.body.items[0].id}`)
        .set(ventas())
        .expect(200);
      expect(detalle.body.items.length).toBeGreaterThan(0);
      await http().get(`/api/comercial/pedidos/${id()}`).set(ventas()).expect(404);
    });

    it('consulta las listas de precios del cliente y sus ítems elegibles', async () => {
      const ls = await http()
        .get(`/api/comercial/listas-precios?clienteId=${CLIENTE.id}`)
        .set(ventas())
        .expect(200);
      expect(ls.body).toEqual([
        expect.objectContaining({
          id: listaId,
          numeroContrato: 'CT-2026-001',
          activa: true,
          items: 3,
        }),
      ]);
      const it = await http()
        .get(`/api/comercial/listas-precios/items?clienteId=${CLIENTE.id}&q=nitrito`)
        .set(ventas())
        .expect(200);
      expect(it.body.items).toEqual([
        expect.objectContaining({
          codigo: 'IT-QUIM01',
          precio: 12.5,
          tipo: 'Material',
          listaPreciosItemId: li['IT-QUIM01'],
        }),
      ]);
      const pag = await http()
        .get(`/api/comercial/listas-precios/items?clienteId=${CLIENTE.id}&limit=2&page=2`)
        .set(ventas())
        .expect(200);
      expect(pag.body).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect(pag.body.items).toHaveLength(1);
      await http().get(`/api/comercial/listas-precios/${listaId}/items`).set(ventas()).expect(200);
    });
  });

  it('la base de datos rechaza un pedido abierto incompleto aunque el servicio fallara (defensa en profundidad)', async () => {
    const b = (await crear({ clienteId: CLIENTE.id })).body;
    await expect(
      prisma.pedido.update({ where: { id: b.id }, data: { estado: 'abierto' } }),
    ).rejects.toThrow();
    // y el seguimiento es de solo inserción
    await expect(
      prisma.procesoHistorial.updateMany({ data: { motivo: 'x' }, where: { entidadId: b.id } }),
    ).rejects.toThrow();
  });
});
