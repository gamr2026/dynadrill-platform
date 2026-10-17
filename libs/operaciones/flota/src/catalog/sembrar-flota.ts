import { uuidv7 } from '@dyn/utils';
import type { PrismaClient, TipoServicioPreventivo, TipoUnidad } from '../generated/client';

/**
 * Catálogos y unidades iniciales de Flota (idempotente). Las reglas son las del Plan de Mantenimiento 2026 (MAN-002). Las unidades
 * son las de la demo (`main`, `prisma/seed.ts`) con sus lecturas y últimos preventivos, para que el portal arranque con los mismos
 * equipos. La carga NO inventa responsables: los preventivos históricos quedan sin cuenta responsable.
 */

export const REGLAS_PREVENTIVAS = [
  {
    codigo: 'servicio_a',
    tipoUnidad: 'servicio',
    tipoServicio: 'a',
    metrica: 'horas',
    intervalo: 250,
    tolerancia: 30,
    descripcion: 'Tipo A (250 h): aceites, filtros, inspección visual y pruebas',
  },
  {
    codigo: 'servicio_b',
    tipoUnidad: 'servicio',
    tipoServicio: 'b',
    metrica: 'horas',
    intervalo: 2000,
    tolerancia: 50,
    descripcion: 'Tipo B (2.000 h): incluye el A, más transmisiones, cajas e hidráulico',
  },
  {
    codigo: 'servicio_tiempo',
    tipoUnidad: 'servicio',
    tipoServicio: null,
    metrica: 'dias',
    intervalo: 180,
    tolerancia: 0,
    descripcion: '6 meses sin alcanzar el tipo A (250 h): mantenimiento por tiempo',
  },
  {
    codigo: 'auxiliar_tiempo',
    tipoUnidad: 'auxiliar',
    tipoServicio: null,
    metrica: 'dias',
    intervalo: 180,
    tolerancia: 0,
    descripcion: 'Mantenimiento semestral del equipo auxiliar',
  },
  {
    codigo: 'transporte_km',
    tipoUnidad: 'transporte',
    tipoServicio: null,
    metrica: 'km',
    intervalo: 5000,
    tolerancia: 500,
    descripcion: 'Cada 5.000 km: vehículo de transporte',
  },
] as const;

export const PROVEEDORES_INICIALES = ['Lubricentro Norte S.A.'] as const;

interface PreventivoSemilla {
  tipoServicio: TipoServicioPreventivo | null;
  fecha: string;
  valor: number | null;
  proveedor?: string;
}

interface UnidadSemilla {
  codigo: string;
  nombre: string;
  tipo: TipoUnidad;
  categoriaPeso?: 'pesado' | 'liviano';
  /** Horómetro (servicio) u odómetro (transporte) actual. */
  lectura?: number;
  /** Placa del catálogo `catalogos.vehiculo` (sin guion) con la que se liga, si ya existe allí. */
  placa?: string;
  fechaMatricula?: string;
  caducidadMatricula?: string;
  caducidadPoliza?: string;
  predeterminada?: boolean;
  preventivos: PreventivoSemilla[];
}

export const UNIDADES_INICIALES: UnidadSemilla[] = [
  {
    codigo: 'PUM-07',
    nombre: 'Unidad de Bombeo PUM-07',
    tipo: 'servicio',
    lectura: 1480,
    preventivos: [
      { tipoServicio: 'b', fecha: '2025-01-15', valor: 0 },
      { tipoServicio: 'a', fecha: '2026-05-10', valor: 1250 },
    ],
  },
  {
    codigo: 'PUM-15',
    nombre: 'Unidad de Bombeo PUM-15',
    tipo: 'servicio',
    lectura: 3950,
    preventivos: [
      { tipoServicio: 'b', fecha: '2025-08-01', valor: 2000 },
      { tipoServicio: 'a', fecha: '2026-07-20', valor: 3750 },
    ],
  },
  {
    codigo: '4-CTV-03',
    nombre: 'Unidad CTU 4-CTV-03',
    tipo: 'servicio',
    lectura: 5620,
    preventivos: [
      { tipoServicio: 'b', fecha: '2025-11-10', valor: 4000 },
      { tipoServicio: 'a', fecha: '2026-08-01', valor: 5500 },
    ],
  },
  {
    codigo: 'PMP-14',
    nombre: 'Unidad de Bombeo PMP-14',
    tipo: 'servicio',
    lectura: 2210,
    preventivos: [
      { tipoServicio: 'b', fecha: '2026-05-12', valor: 2000 },
      { tipoServicio: 'a', fecha: '2026-06-25', valor: 2100 },
    ],
  },
  {
    codigo: 'PUM-03',
    nombre: 'Unidad de Bombeo PUM-03',
    tipo: 'servicio',
    lectura: 2870,
    preventivos: [
      { tipoServicio: 'b', fecha: '2025-09-18', valor: 1500 },
      { tipoServicio: 'a', fecha: '2026-07-05', valor: 2700 },
    ],
  },
  {
    // Cisterna: unidad de servicio sin horómetro; solo cuenta la regla por tiempo.
    codigo: 'CIS-02',
    nombre: 'Cisterna CIS-02',
    tipo: 'servicio',
    preventivos: [{ tipoServicio: 'a', fecha: '2026-01-20', valor: null }],
  },
  {
    codigo: 'GEN-01',
    nombre: 'Generador auxiliar GEN-01',
    tipo: 'auxiliar',
    preventivos: [{ tipoServicio: null, fecha: '2026-03-15', valor: null }],
  },
  {
    codigo: 'GEN-02',
    nombre: 'Generador auxiliar GEN-02',
    tipo: 'auxiliar',
    preventivos: [{ tipoServicio: null, fecha: '2025-12-01', valor: null }],
  },
  {
    codigo: 'CAM-04',
    nombre: 'Camioneta CAM-04',
    tipo: 'transporte',
    categoriaPeso: 'liviano',
    lectura: 87400,
    placa: 'PBA1234',
    fechaMatricula: '2026-01-10',
    caducidadMatricula: '2027-01-10',
    caducidadPoliza: '2027-03-01',
    predeterminada: true,
    preventivos: [
      {
        tipoServicio: null,
        fecha: '2026-07-10',
        valor: 85000,
        proveedor: 'Lubricentro Norte S.A.',
      },
    ],
  },
  {
    codigo: 'CAM-08',
    nombre: 'Camión CAM-08',
    tipo: 'transporte',
    categoriaPeso: 'pesado',
    lectura: 142800,
    placa: 'PCB5678',
    fechaMatricula: '2026-01-15',
    caducidadMatricula: '2027-01-15',
    caducidadPoliza: '2027-04-15',
    preventivos: [{ tipoServicio: null, fecha: '2026-06-20', valor: 138000 }],
  },
];

const fecha = (s: string | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export async function sembrarFlota(prisma: PrismaClient) {
  const reglas = await prisma.reglaPreventiva.createMany({
    data: REGLAS_PREVENTIVAS.map((r) => ({ ...r })),
    skipDuplicates: true,
  });
  let proveedores = 0;
  for (const nombre of PROVEEDORES_INICIALES) {
    const hay = await prisma.proveedorMantenimiento.findUnique({ where: { nombre } });
    if (hay) continue;
    await prisma.proveedorMantenimiento.create({ data: { id: uuidv7(), nombre } });
    proveedores++;
  }
  let unidades = 0;
  for (const u of UNIDADES_INICIALES) {
    if (await prisma.unidad.findUnique({ where: { codigo: u.codigo }, select: { id: true } }))
      continue;
    // Se liga al vehículo del catálogo por la placa, solo si ya existe y no lo usa otra unidad.
    const vehiculo = u.placa
      ? await prisma.catVehiculo.findFirst({
          where: { placa: u.placa, unidad: null },
          select: { id: true },
        })
      : null;
    const id = uuidv7();
    await prisma.$transaction(async (tx) => {
      await tx.unidad.create({
        data: {
          id,
          codigo: u.codigo,
          nombre: u.nombre,
          tipo: u.tipo,
          categoriaPeso: u.categoriaPeso ?? null,
          vehiculoId: vehiculo?.id ?? null,
          fechaMatricula: fecha(u.fechaMatricula),
          caducidadMatricula: fecha(u.caducidadMatricula),
          caducidadPoliza: fecha(u.caducidadPoliza),
          predeterminada: u.predeterminada ?? false,
        },
      });
      const tipoLectura =
        u.tipo === 'servicio' ? 'horometro' : u.tipo === 'transporte' ? 'odometro' : null;
      for (const p of u.preventivos) {
        let lecturaId: string | null = null;
        if (tipoLectura && p.valor !== null) {
          lecturaId = uuidv7();
          await tx.unidadLectura.create({
            data: {
              id: lecturaId,
              unidadId: id,
              tipo: tipoLectura,
              valor: p.valor,
              leidaAt: new Date(`${p.fecha}T12:00:00.000Z`),
              fuente: 'carga_inicial',
            },
          });
        }
        const proveedor = p.proveedor
          ? await tx.proveedorMantenimiento.findUnique({ where: { nombre: p.proveedor } })
          : null;
        await tx.unidadPreventivo.create({
          data: {
            id: uuidv7(),
            unidadId: id,
            tipoServicio: p.tipoServicio,
            fecha: fecha(p.fecha) as Date,
            lecturaId,
            ejecutadoPor: proveedor ? 'tercero' : 'interno',
            origen: 'carga_inicial',
            proveedorMantenimientoId: proveedor?.id ?? null,
          },
        });
      }
      if (tipoLectura && u.lectura !== undefined) {
        await tx.unidadLectura.create({
          data: {
            id: uuidv7(),
            unidadId: id,
            tipo: tipoLectura,
            valor: u.lectura,
            leidaAt: new Date(),
            fuente: 'carga_inicial',
          },
        });
      }
    });
    unidades++;
  }
  return { reglas: reglas.count, proveedores, unidades };
}
