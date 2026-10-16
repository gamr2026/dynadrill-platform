/**
 * Migra roles y usuarios del backend demo (SQLite) a `identidad` (PostgreSQL). Idempotente.
 *   npm run db:migrate-demo:identidad                      (usa DEMO_DB_PATH o la ruta por defecto)
 *   DEMO_DB_PATH=ruta/a/dynadrill.db npm run db:migrate-demo:identidad
 *
 * - Cada rol/usuario conserva su id numérico en `legacy_id` (el gateway lo usa para traducir tokens).
 * - Los roles se enlazan por `code`; los usuarios por `legacy_id` o, si no, por email.
 * - Los hashes bcrypt se copian tal cual: las mismas contraseñas siguen funcionando y se cambian a
 *   Argon2id en el primer login. Un usuario ya existente NUNCA pierde su hash actual.
 * - Imprime un informe con lo creado, lo actualizado y lo que no pudo resolver.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

interface DemoRole {
  id: number;
  code: string;
  name: string;
}
type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const bool = (v: unknown) => (v === null || v === undefined ? null : Number(v) === 1);
const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** SQLite guarda las fechas de Prisma como milisegundos Unix enteros (o ISO en datos viejos). */
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

async function main() {
  const dbPath = resolve(process.env['DEMO_DB_PATH'] ?? '../dynadrill-backend/prisma/dynadrill.db');
  if (!existsSync(dbPath)) throw new Error(`No existe la base de la demo: ${dbPath}`);
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL es obligatoria');

  const demo = new DatabaseSync(dbPath, { readOnly: true });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(url), max: 2 },
      { schema: 'identidad' },
    ),
  });

  const report = {
    rolesEnlazados: 0,
    rolesSinEquivalente: [] as string[],
    usuariosCreados: 0,
    usuariosActualizados: 0,
    usuariosOmitidos: [] as string[],
  };

  try {
    // 1) Roles: se enlazan por code; el seed ya creó los 17 del sistema.
    const nuevoPorCodigo = new Map((await prisma.rol.findMany()).map((r) => [r.codigo, r]));
    const roleCodeByLegacyId = new Map<number, string>();
    const demoRoles = demo
      .prepare('SELECT id, code, name FROM roles ORDER BY id')
      .all() as unknown as DemoRole[];
    for (const r of demoRoles) {
      roleCodeByLegacyId.set(r.id, r.code);
      const nuevo = nuevoPorCodigo.get(r.code);
      if (!nuevo) {
        report.rolesSinEquivalente.push(`${r.code} (id demo ${r.id})`);
        continue;
      }
      if (nuevo.legacyId !== r.id) {
        await prisma.rol.update({ where: { id: nuevo.id }, data: { legacyId: r.id } });
      }
      report.rolesEnlazados += 1;
    }

    // 2) Usuarios
    const users = demo.prepare('SELECT * FROM users ORDER BY id').all() as Row[];
    for (const u of users) {
      const legacyId = int(u['id']) as number;
      const email = String(u['email']).trim().toLowerCase();
      const roleCode = roleCodeByLegacyId.get(int(u['roleId']) as number);
      const rol = roleCode ? nuevoPorCodigo.get(roleCode) : undefined;
      if (!rol) {
        report.usuariosOmitidos.push(
          `${email}: su rol (id demo ${String(u['roleId'])}) no tiene equivalente`,
        );
        continue;
      }

      const existing =
        (await prisma.usuario.findUnique({ where: { legacyId } })) ??
        (await prisma.usuario.findUnique({ where: { email } }));

      if (existing) {
        // Ya migrado (o creado antes): solo se completa el enlace; jamás se pisa clave, rol ni estado.
        if (existing.legacyId !== legacyId) {
          await prisma.usuario.update({ where: { id: existing.id }, data: { legacyId } });
        }
        report.usuariosActualizados += 1;
        continue;
      }

      const username = String(u['username']).trim();
      const clash = await prisma.usuario.findUnique({ where: { username } });
      if (clash) {
        report.usuariosOmitidos.push(`${email}: el username "${username}" ya lo usa otro usuario`);
        continue;
      }

      const rrhh = {
        cedula: str(u['cedula']),
        tipoIdentificacion: str(u['tipoIdentificacion']),
        nacionalidad: str(u['nacionalidad']),
        apellidos: str(u['apellidos']),
        nombres: str(u['nombres']),
        cargo: str(u['cargo']),
        departamento: str(u['departamento']),
        area: str(u['area']),
        fechaIngreso: date(u['fechaIngreso']),
        fechaSalida: date(u['fechaSalida']),
        causaSalida: str(u['causaSalidaEmpleado']),
        tipoContrato: str(u['tipoContrato']),
        sucursal: str(u['sucursal']),
        tipoDiscapacidad: str(u['tipoDiscapacidad']),
        cargasActivas: int(u['cargasActivas']),
        categoria: str(u['categoria']),
        centroCosto: str(u['centroCosto']),
        empleadoActivo: bool(u['empleadoActivo']),
      };
      const tieneRrhh = Object.values(rrhh).some((v) => v !== null);

      await prisma.usuario.create({
        data: {
          id: uuidv7(),
          legacyId,
          email,
          username,
          nombre: String(u['name']),
          telefono: str(u['phone']),
          passwordHash: str(u['passwordHash']),
          rolId: rol.id,
          activo: bool(u['status']) ?? true,
          especialidad: str(u['specialty']),
          createdAt: date(u['createdAt']) ?? new Date(),
          updatedAt: date(u['updatedAt']) ?? new Date(),
          ...(tieneRrhh ? { perfil: { create: { id: uuidv7(), ...rrhh } } } : {}),
        },
      });
      report.usuariosCreados += 1;
    }

    console.log(`Base de la demo: ${dbPath}`);
    console.log(`Roles enlazados: ${report.rolesEnlazados}`);
    if (report.rolesSinEquivalente.length) {
      console.log(`Roles de la demo sin equivalente: ${report.rolesSinEquivalente.join(', ')}`);
    }
    console.log(
      `Usuarios creados: ${report.usuariosCreados} | ya existentes (enlazados): ${report.usuariosActualizados} | omitidos: ${report.usuariosOmitidos.length}`,
    );
    for (const o of report.usuariosOmitidos) console.log(`  - omitido: ${o}`);
    console.log(`Total en la demo: ${users.length}`);
  } finally {
    demo.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
