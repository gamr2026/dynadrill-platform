/**
 * Siembra los 15 roles del sistema y el catálogo de permisos con sus asignaciones por defecto
 * (idempotente) y, si se piden, un superadmin inicial.
 *
 * Los permisos por defecto de un rol se asignan SOLO cuando el permiso se crea. Volver a correr el seed
 * jamás revierte lo que un administrador haya editado desde la app.
 *   npm run db:seed:identidad
 * Variables: DATABASE_URL (usuario app_plataforma) y, opcionalmente,
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD  → crea el superadmin si NO existe (SEED_ADMIN_FORCE=true lo restablece).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { syncPermisos } from '../src/catalog/sync-permisos';
import { PasswordService } from '../src/services/password.service';
import { PERMISSION_CATALOG } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

/** Mismos códigos y nombres que el backend demo (libs/common/src/auth/role-code.ts). */
const ROLES: Array<{ codigo: string; nombre: string; descripcion: string }> = [
  {
    codigo: 'superadmin',
    nombre: 'Superadmin',
    descripcion: 'Acceso total, incluida la administración de usuarios',
  },
  {
    codigo: 'jefe_base',
    nombre: 'Jefe de Base',
    descripcion: 'Acceso total salvo administración de usuarios',
  },
  {
    codigo: 'ingenieria_ventas',
    nombre: 'Ingeniería de Ventas',
    descripcion: 'Alta de Pedidos y catálogos comerciales',
  },
  {
    codigo: 'facturacion',
    nombre: 'Facturación',
    descripcion: 'Prefacturas, guías de remisión y AOT',
  },
  { codigo: 'supervisor', nombre: 'Supervisor', descripcion: 'Supervisa FCR y Pumping' },
  {
    codigo: 'supervisor_pumping',
    nombre: 'Supervisor Pumping',
    descripcion: 'Supervisor exclusivo de Pumping',
  },
  {
    codigo: 'supervisor_operaciones_fcr',
    nombre: 'Supervisor Operaciones FCR',
    descripcion: 'Aprueba la entrada SERVICIOS del flujo FCR',
  },
  { codigo: 'operador', nombre: 'Operador', descripcion: 'Operador de Pumping' },
  { codigo: 'operador_fcr', nombre: 'Operador FCR', descripcion: 'Operador exclusivo de FCR' },
  { codigo: 'bodeguero', nombre: 'Bodeguero', descripcion: 'Inventario y despachos de bodega' },
  {
    codigo: 'jefe_mantenimiento',
    nombre: 'Jefe de Mantenimiento',
    descripcion: 'Gestiona órdenes y sub-órdenes de mantenimiento',
  },
  {
    codigo: 'operador_mantenimiento',
    nombre: 'Operador de Mantenimiento',
    descripcion: 'Ejecuta sub-órdenes (Mecánico o Instrumental)',
  },
  { codigo: 'tecnico_hse', nombre: 'Técnico HSE', descripcion: 'Seguridad, salud y ambiente' },
  {
    codigo: 'gerente_hse',
    nombre: 'Gerente HSE',
    descripcion: 'Aprueba IPERC y viajes de riesgo alto',
  },
  { codigo: 'conductor', nombre: 'Conductor', descripcion: 'Solicita su Gerenciamiento de Viaje' },
];

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL es obligatoria');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(url), max: 2 },
      { schema: 'identidad' },
    ),
  });

  try {
    for (const rol of ROLES) {
      const existing = await prisma.rol.findUnique({ where: { codigo: rol.codigo } });
      if (existing) {
        await prisma.rol.update({
          where: { id: existing.id },
          data: { nombre: rol.nombre, descripcion: rol.descripcion },
        });
      } else {
        await prisma.rol.create({ data: { id: uuidv7(), ...rol } });
      }
    }
    console.log(`roles sembrados: ${ROLES.length}`);

    // Permisos: catálogo al día, asignaciones por defecto solo a permisos nuevos y traspaso de los retirados.
    const sync = await syncPermisos(prisma);
    console.log(
      `permisos: ${PERMISSION_CATALOG.length} en el catálogo (${sync.nuevos} nuevos con ${sync.asignacionesPorDefecto} asignaciones por defecto, ${sync.traspasadas} asignaciones traspasadas, ${sync.retirados} retirados)`,
    );

    const email = process.env['SEED_ADMIN_EMAIL']?.trim().toLowerCase();
    const password = process.env['SEED_ADMIN_PASSWORD'];
    if (email && password) {
      const rol = await prisma.rol.findUniqueOrThrow({ where: { codigo: 'superadmin' } });
      const passwordHash = await new PasswordService().hash(password);
      const existing = await prisma.usuario.findUnique({ where: { email } });
      // Una cuenta que YA existe no se toca: reactivarla o cambiarle la clave contradiría lo que un administrador
      // haya decidido (p. ej. retirar la cuenta inicial). Solo con SEED_ADMIN_FORCE=true se restablece.
      if (existing && process.env['SEED_ADMIN_FORCE'] !== 'true') {
        console.log(
          `superadmin ${email} ya existe: no se modificó (use SEED_ADMIN_FORCE=true para restablecerlo)`,
        );
      } else if (existing) {
        console.log(`superadmin ${email} restablecido (SEED_ADMIN_FORCE=true)`);
        await prisma.usuario.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            rolId: rol.id,
            activo: true,
            intentosFallidos: 0,
            bloqueadoHasta: null,
          },
        });
      } else {
        console.log(`superadmin ${email} creado`);
        await prisma.usuario.create({
          data: {
            id: uuidv7(),
            email,
            username: email.split('@')[0],
            nombre: 'Superadmin',
            passwordHash,
            rolId: rol.id,
            activo: true,
          },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
