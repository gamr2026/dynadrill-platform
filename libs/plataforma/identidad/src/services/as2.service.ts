import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { As2Port } from '../as2/as2.port';
import { EmpleadosAs2QueryDto } from '../dto/as2.dto';

const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Consultas de la copia local de AS2 (la escritura la hace solo `As2SyncService`). */
@Injectable()
export class As2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly as2: As2Port,
  ) {}

  async estado() {
    const [ultima, ultimaOk, empleados, activos, vinculados] = await Promise.all([
      this.prisma.sincronizacionAs2.findFirst({ orderBy: { iniciadaAt: 'desc' } }),
      this.prisma.sincronizacionAs2.findFirst({
        where: { estado: 'ok' },
        orderBy: { iniciadaAt: 'desc' },
      }),
      this.prisma.empleadoAs2.count(),
      this.prisma.empleadoAs2.count({ where: { activo: true } }),
      this.prisma.empleadoAs2.count({ where: { perfiles: { some: {} } } }),
    ]);
    return {
      configurado: await this.as2.disponible(),
      empleados,
      activos,
      conCuenta: vinculados,
      ultimaCorrida: ultima,
      ultimaCorridaExitosaAt: ultimaOk?.finalizadaAt ?? null,
    };
  }

  sincronizaciones(limit = 20) {
    return this.prisma.sincronizacionAs2.findMany({
      orderBy: { iniciadaAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  async empleados(q: EmpleadosAs2QueryDto) {
    const where: Prisma.EmpleadoAs2WhereInput = {};
    if (q.activo !== undefined) where.activo = q.activo === 'true';
    if (q.q) {
      where.OR = [
        { nombres: { contains: q.q, mode: 'insensitive' } },
        { apellidos: { contains: q.q, mode: 'insensitive' } },
        { cedula: { contains: q.q } },
        { cargo: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    const [total, items] = await Promise.all([
      this.prisma.empleadoAs2.count({ where }),
      this.prisma.empleadoAs2.findMany({
        where,
        orderBy: [{ apellidos: 'asc' }, { nombres: 'asc' }],
        take: q.limit ?? 50,
        skip: q.offset ?? 0,
        include: { perfiles: { select: { usuarioId: true } } },
      }),
    ]);
    return {
      total,
      items: items.map((e) => ({
        id: e.id,
        as2EmpleadoId: e.as2EmpleadoId,
        cedula: e.cedula,
        nombres: e.nombres,
        apellidos: e.apellidos,
        genero: e.genero,
        cargo: e.cargo,
        departamento: e.departamento,
        sucursal: e.sucursal,
        tipoContrato: e.tipoContrato,
        fechaIngreso: dia(e.fechaIngreso),
        fechaSalida: dia(e.fechaSalida),
        activo: e.activo,
        correoAs2: e.correoAs2,
        usuarioId: e.perfiles[0]?.usuarioId ?? null,
        sincronizadoAt: e.sincronizadoAt,
      })),
    };
  }

  async historial(id: string) {
    const emp = await this.prisma.empleadoAs2.findUnique({ where: { id }, select: { id: true } });
    if (!emp) throw new NotFoundException(`Empleado ${id} no existe`);
    const filas = await this.prisma.empleadoAs2Historial.findMany({
      where: { empleadoId: id },
      orderBy: [{ detectadoAt: 'desc' }, { campo: 'asc' }],
      take: 500,
    });
    return filas.map((h) => ({
      campo: h.campo,
      valorAnterior: h.valorAnterior,
      valorNuevo: h.valorNuevo,
      detectadoAt: h.detectadoAt,
    }));
  }
}
