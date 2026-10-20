import { randomUUID } from 'node:crypto';
/**
 * Ayuda de las pruebas de integración: las FK a `catalogos` e `identidad` exigen que los ids existan de verdad. Esto inserta
 * (con dyn_migrator) los registros maestros mínimos que usa cada prueba y los quita al final. Solo para pruebas.
 */
import type { Pool } from 'pg';

export interface MaestrosDePrueba {
  usuarios?: Array<{ id: string; nombre: string; rol: string; activo?: boolean }>;
  clientes?: Array<{ id: string; nombre: string; ruc: string | null }>;
  zonas?: Array<{ id: string; nombre: string }>;
  campos?: Array<{ id: string; nombre: string; zonaId?: string | null }>;
  bloques?: Array<{ id: string; nombre: string }>;
  pozos?: Array<{ id: string; nombre: string; campoId: string; bloqueId: string }>;
  taladros?: Array<{ id: string; nombre: string }>;
  bodegas?: Array<{ id: string; nombre: string }>;
  condiciones?: Array<{ id: string; nombre: string }>;
  personas?: Array<{ id: string; nombre: string; tipo?: string }>;
  transportistas?: Array<{ id: string; nombre: string; identificacion: string }>;
  vehiculos?: Array<{ id: string; placa: string; transportistaId?: string | null }>;
  choferes?: Array<{ id: string; nombre: string; transportistaId: string }>;
  /** Archivos subidos (módulo `archivos`): los adjuntos y las firmas del pedido apuntan a ellos con FK. */
  archivos?: Array<{
    id: string;
    modulo: string;
    nombre: string;
    mimeType: string;
    tamanoBytes: number;
    subidoPor: string;
  }>;
}

/** Inserta los maestros (si un id ya existe, no lo toca). */
export async function sembrarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const roles = new Map<string, string>(
    (await admin.query('SELECT id, codigo FROM identidad.rol')).rows.map(
      (r: { id: string; codigo: string }) => [r.codigo, r.id],
    ),
  );
  for (const u of m.usuarios ?? []) {
    const rolId = roles.get(u.rol);
    if (!rolId) throw new Error(`El rol ${u.rol} no existe en identidad.rol`);
    await admin.query(
      `INSERT INTO identidad.usuario (id, email, username, nombre, rol_id, activo)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [u.id, `${u.id}@test.local`, u.id, u.nombre, rolId, u.activo ?? true],
    );
  }
  for (const z of m.zonas ?? []) {
    await admin.query(
      'INSERT INTO catalogos.zona (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [z.id, z.nombre],
    );
  }
  for (const c of m.clientes ?? []) {
    await admin.query(
      `INSERT INTO catalogos.cliente (id, tipo_identificacion, identificacion, nombre_comercial, nombre_fiscal)
       VALUES ($1, 'ruc', $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.ruc ?? c.id, c.nombre],
    );
  }
  for (const c of m.campos ?? []) {
    await admin.query(
      'INSERT INTO catalogos.campo (id, nombre, zona_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [c.id, c.nombre, c.zonaId ?? null],
    );
  }
  for (const b of m.bloques ?? []) {
    await admin.query(
      'INSERT INTO catalogos.bloque (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [b.id, b.nombre],
    );
  }
  for (const p of m.pozos ?? []) {
    await admin.query(
      'INSERT INTO catalogos.pozo (id, codigo, nombre_completo, campo_id, bloque_id) VALUES ($1, $2, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [p.id, p.nombre, p.campoId, p.bloqueId],
    );
  }
  for (const t of m.taladros ?? []) {
    await admin.query(
      'INSERT INTO catalogos.taladro (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [t.id, t.nombre],
    );
  }
  for (const b of m.bodegas ?? []) {
    await admin.query(
      'INSERT INTO catalogos.bodega (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [b.id, b.nombre],
    );
  }
  for (const c of m.condiciones ?? []) {
    await admin.query(
      'INSERT INTO catalogos.condicion_pago (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [c.id, c.nombre],
    );
  }
  for (const p of m.personas ?? []) {
    await admin.query(
      'INSERT INTO catalogos.persona_contacto (id, tipo, nombre) VALUES ($1, $2::catalogos.tipo_persona, $3) ON CONFLICT (id) DO NOTHING',
      [p.id, p.tipo ?? 'representante_campo', p.nombre],
    );
  }
  for (const a of m.archivos ?? []) {
    await admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       SELECT $1::uuid, mo.id, $3::text, $4::text, $5::bigint, repeat('a', 64), 'prueba/' || $1::text, 'omitido', $6::uuid
         FROM archivos.modulo_archivo mo WHERE mo.codigo = $2::text
       ON CONFLICT (id) DO NOTHING`,
      [a.id, a.modulo, a.nombre, a.mimeType, a.tamanoBytes, a.subidoPor],
    );
  }
  for (const t of m.transportistas ?? []) {
    await admin.query(
      `INSERT INTO catalogos.transportista (id, nombre_fiscal, tipo_identificacion, identificacion)
       VALUES ($1, $2, 'ruc', $3) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.nombre, t.identificacion],
    );
  }
  for (const v of m.vehiculos ?? []) {
    await admin.query(
      'INSERT INTO catalogos.vehiculo (id, placa, transportista_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [v.id, v.placa, v.transportistaId ?? null],
    );
  }
  for (const c of m.choferes ?? []) {
    await admin.query(
      "INSERT INTO catalogos.chofer (id, transportista_id, licencia, nombre) VALUES ($1, $2, 'L-TEST', $3) ON CONFLICT (id) DO NOTHING",
      [c.id, c.transportistaId, c.nombre],
    );
  }
}

/** Quita lo sembrado, en el orden inverso. Lo que aún esté referenciado por otro dato se deja (no es un error de la prueba). */
export async function quitarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const quitar = async (tabla: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      await admin.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]).catch(() => undefined);
    }
  };
  await quitar(
    'archivos.archivo',
    m.archivos?.map((x) => x.id),
  );
  await quitar(
    'catalogos.chofer',
    m.choferes?.map((x) => x.id),
  );
  await quitar(
    'catalogos.vehiculo',
    m.vehiculos?.map((x) => x.id),
  );
  await quitar(
    'catalogos.transportista',
    m.transportistas?.map((x) => x.id),
  );
  await quitar(
    'catalogos.persona_contacto',
    m.personas?.map((x) => x.id),
  );
  await quitar(
    'catalogos.condicion_pago',
    m.condiciones?.map((x) => x.id),
  );
  await quitar(
    'catalogos.bodega',
    m.bodegas?.map((x) => x.id),
  );
  await quitar(
    'catalogos.taladro',
    m.taladros?.map((x) => x.id),
  );
  await quitar(
    'catalogos.pozo',
    m.pozos?.map((x) => x.id),
  );
  await quitar(
    'catalogos.bloque',
    m.bloques?.map((x) => x.id),
  );
  await quitar(
    'catalogos.campo',
    m.campos?.map((x) => x.id),
  );
  await quitar(
    'catalogos.zona',
    m.zonas?.map((x) => x.id),
  );
  await quitar(
    'catalogos.cliente',
    m.clientes?.map((x) => x.id),
  );
  // Una cuenta que aún está referenciada no se puede borrar: se desactiva para que no aparezca en las listas de personas del portal
  // (las pruebas corren contra la base local real y antes dejaban cientos de cuentas @test.local activas).
  for (const id of m.usuarios?.map((x) => x.id) ?? []) {
    await admin
      .query('DELETE FROM identidad.usuario WHERE id = $1', [id])
      .catch(() =>
        admin
          .query('UPDATE identidad.usuario SET activo = false WHERE id = $1', [id])
          .catch(() => undefined),
      );
  }
}

/**
 * Una guía de remisión emitida para el pedido (con un transportista y un lugar de despacho que ya existan): sin ella la prefactura no se
 * envía a firmas. Las pruebas que solo necesitan «que haya guía» la usan; quitarlas con `quitarGuiasDePrueba`.
 */
export async function emitirGuiaDePrueba(
  admin: Pool,
  pedidoId: string,
  actorId: string,
): Promise<void> {
  const t = (
    await admin.query(
      'SELECT id, nombre_fiscal AS nombre, identificacion FROM catalogos.transportista ORDER BY nombre_fiscal LIMIT 1',
    )
  ).rows[0];
  let lugar = (await admin.query('SELECT id FROM comercial.lugar_despacho ORDER BY nombre LIMIT 1'))
    .rows[0]?.id as string | undefined;
  if (!lugar) {
    lugar = (
      await admin.query(
        "INSERT INTO comercial.lugar_despacho (id, nombre) VALUES (gen_random_uuid(), 'Lugar de prueba') RETURNING id",
      )
    ).rows[0].id;
  }
  await admin.query(
    `INSERT INTO comercial.guia_remision (id, pedido_id, numero, codigo, emision_id, fecha, lugar_origen_id, transportista_id,
                                          transportista_nombre, transportista_identificacion, emitida_por)
     VALUES (gen_random_uuid(), $1, 1, $2, gen_random_uuid(), current_date, $3, $4, $5, $6, $7)`,
    [pedidoId, `GIT-${randomUUID()}`, lugar, t.id, t.nombre, t.identificacion, actorId],
  );
}

export async function quitarGuiasDePrueba(admin: Pool, pedidos: string[]): Promise<void> {
  await admin.query(
    "DELETE FROM comercial.guia_remision WHERE pedido_id = ANY($1::uuid[]) AND codigo LIKE 'GIT-%'",
    [pedidos],
  );
}
