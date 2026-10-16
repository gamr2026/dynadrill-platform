import { uuidv7 } from '@dyn/utils';
import { Prisma, PrismaClient, type TransformacionCampo } from '../generated/client';

type Json = Prisma.InputJsonValue;
type Cliente = Pick<PrismaClient, 'proveedor' | 'autenticacion' | 'operacion' | 'mapeoCampo'>;

interface Mapeo {
  destino: string;
  origen: string;
  transformacion?: TransformacionCampo;
  obligatorio?: boolean;
}

/** Consulta genérica de AS2 (`ConsultaJPQL`): campos a proyectar, filtro de organización y orden estable. */
const consulta = (campos: string[], orden: string, conOrganizacion: boolean): Json => ({
  campos,
  filtros: conOrganizacion
    ? [{ campo: 'idOrganizacion', valor: '{{var.idOrganizacion}}', operador: '=' }]
    : [],
  camposOrden: [{ nombre: orden, orden: 1 }],
});

const PAGINACION: Json = {
  tipo: 'offset',
  tamano: 1000,
  inicio: 0,
  campoDesde: 'primerResultado',
  campoTamano: 'resultadoMaximo',
};

const EMPLEADOS: Mapeo[] = [
  { destino: 'idEmpleado', origen: 'idEmpleado', transformacion: 'entero', obligatorio: true },
  {
    destino: 'cedula',
    origen: 'empresa.identificacion',
    transformacion: 'texto',
    obligatorio: true,
  },
  { destino: 'nombres', origen: 'nombres', transformacion: 'texto' },
  { destino: 'apellidos', origen: 'apellidos', transformacion: 'texto' },
  { destino: 'genero', origen: 'genero', transformacion: 'texto' },
  { destino: 'cargo', origen: 'cargoEmpleado.nombre', transformacion: 'texto' },
  { destino: 'departamento', origen: 'departamento.nombre', transformacion: 'texto' },
  { destino: 'sucursal', origen: 'sucursal.nombre', transformacion: 'texto' },
  { destino: 'tipoContrato', origen: 'tipoContrato.nombre', transformacion: 'texto' },
  { destino: 'fechaIngreso', origen: 'fechaIngreso', transformacion: 'fecha_ms_ec' },
  { destino: 'fechaSalida', origen: 'fechaSalida', transformacion: 'fecha_ms_ec' },
];

const USUARIOS: Mapeo[] = [
  {
    destino: 'identificacion',
    origen: 'identificacion',
    transformacion: 'texto',
    obligatorio: true,
  },
  { destino: 'email', origen: 'email', transformacion: 'texto' },
];

/**
 * Configuración inicial de AS2 (el ERP): lo que antes estaba escrito en código. Solo lectura, y solo los campos
 * de perfil: nunca sueldo, discapacidad ni cargas. Idempotente: si el proveedor ya existe NO se toca nada, para
 * no deshacer lo que un administrador haya ajustado.
 *
 * @returns `true` si lo creó, `false` si ya existía.
 */
export async function sembrarAs2(
  db: Cliente,
  opciones: { baseUrl?: string; idOrganizacion?: number } = {},
): Promise<boolean> {
  if (await db.proveedor.findUnique({ where: { codigo: 'as2' }, select: { id: true } }))
    return false;

  const proveedorId = uuidv7();
  await db.proveedor.create({
    data: {
      id: proveedorId,
      codigo: 'as2',
      nombre: 'AS2 (ERP de Dynadrill)',
      // Sin URL configurada queda inactivo hasta que un administrador la complete.
      baseUrl: (opciones.baseUrl ?? 'http://as2.invalid/AS2/rest').replace(/\/+$/, ''),
      ambiente: 'produccion',
      formato: 'json',
      timeoutMs: 30000,
      reintentos: 1,
      variables: { idOrganizacion: opciones.idOrganizacion ?? 1 },
      activo: Boolean(opciones.baseUrl),
    },
  });
  await db.autenticacion.create({
    data: {
      id: uuidv7(),
      proveedorId,
      tipo: 'bearer_login',
      config: { operacion: 'login', campoToken: 'token', vidaSegundos: 600 },
      // Nombre lógico → nombre de la variable de entorno (después, del Key Vault).
      secretos: { usuario: 'AS2_USER', clave: 'AS2_PASSWORD' },
    },
  });

  const operaciones: Array<{
    codigo: string;
    descripcion: string;
    ruta: string;
    cuerpo: Json;
    paginacion?: Json;
    requiereAuth?: boolean;
    mapeos: Mapeo[];
  }> = [
    {
      codigo: 'login',
      descripcion: 'Inicia sesión y devuelve un token JWT',
      ruta: '/v2/usuarios/login',
      cuerpo: {
        nombreUsuario: '{{secreto.usuario}}',
        clave: '{{secreto.clave}}',
        idOrganizacion: '{{var.idOrganizacion}}',
        sistema: 'API',
      },
      requiereAuth: false,
      mapeos: [],
    },
    {
      codigo: 'listar_empleados',
      descripcion: 'Empleados (solo campos de perfil). Activo = sin fecha de salida.',
      ruta: '/v2/catalogors/empleado',
      cuerpo: consulta(
        [
          'idEmpleado',
          'nombres',
          'apellidos',
          'genero',
          'empresa.identificacion',
          'cargoEmpleado.nombre',
          'departamento.nombre',
          'sucursal.nombre',
          'tipoContrato.nombre',
          'fechaIngreso',
          'fechaSalida',
        ],
        'idEmpleado',
        true,
      ),
      paginacion: PAGINACION,
      mapeos: EMPLEADOS,
    },
    {
      codigo: 'listar_usuarios',
      descripcion: 'Usuarios de AS2: cédula y correo, para cruzar con los empleados',
      ruta: '/v2/usuarios',
      cuerpo: consulta(['idUsuario', 'email', 'identificacion'], 'idUsuario', false),
      paginacion: PAGINACION,
      mapeos: USUARIOS,
    },
  ];

  for (const o of operaciones) {
    const id = uuidv7();
    await db.operacion.create({
      data: {
        id,
        proveedorId,
        codigo: o.codigo,
        version: 1,
        activa: true,
        descripcion: o.descripcion,
        metodo: 'POST',
        ruta: o.ruta,
        cuerpo: o.cuerpo,
        paginacion: o.paginacion ?? Prisma.JsonNull,
        rutaResultados: '',
        requiereAuth: o.requiereAuth ?? true,
      },
    });
    if (o.mapeos.length) {
      await db.mapeoCampo.createMany({
        data: o.mapeos.map((m, i) => ({
          id: uuidv7(),
          operacionId: id,
          destino: m.destino,
          origen: m.origen,
          transformacion: m.transformacion ?? null,
          obligatorio: m.obligatorio ?? false,
          orden: i,
        })),
      });
    }
  }
  return true;
}
