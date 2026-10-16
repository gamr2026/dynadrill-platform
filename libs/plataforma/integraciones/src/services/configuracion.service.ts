import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { marcadoresInvalidos, secretosUsados } from '../engine/plantilla';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActualizarProveedorDto,
  CrearVersionDto,
  EjecucionesQueryDto,
} from '../dto/integraciones.dto';

type Json = Prisma.InputJsonValue;

/**
 * Administración de la configuración de integraciones: ver, editar el proveedor, crear versiones nuevas de una
 * operación y activarlas. Todo cambio queda en `cambio` (quién, qué, antes y después). Nunca expone valores de
 * secretos, solo sus nombres.
 */
@Injectable()
export class ConfiguracionService {
  constructor(private readonly prisma: PrismaService) {}

  async listar() {
    const proveedores = await this.prisma.proveedor.findMany({
      orderBy: { codigo: 'asc' },
      include: {
        autenticacion: { select: { tipo: true } },
        operaciones: { select: { codigo: true, version: true, activa: true } },
      },
    });
    return proveedores.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      baseUrl: p.baseUrl,
      ambiente: p.ambiente,
      formato: p.formato,
      activo: p.activo,
      autenticacion: p.autenticacion?.tipo ?? 'ninguna',
      operacionesActivas: p.operaciones
        .filter((o) => o.activa)
        .map((o) => `${o.codigo} v${o.version}`),
    }));
  }

  async detalle(codigo: string) {
    const p = await this.prisma.proveedor.findUnique({
      where: { codigo },
      include: {
        autenticacion: true,
        operaciones: {
          orderBy: [{ codigo: 'asc' }, { version: 'desc' }],
          include: { mapeos: { orderBy: [{ orden: 'asc' }, { destino: 'asc' }] } },
        },
      },
    });
    if (!p) throw new NotFoundException(`El proveedor "${codigo}" no existe`);
    return {
      ...p,
      // Solo los NOMBRES de los secretos; los valores viven fuera de la base de datos.
      autenticacion: p.autenticacion
        ? {
            tipo: p.autenticacion.tipo,
            config: p.autenticacion.config,
            secretos: Object.keys(p.autenticacion.secretos as object),
          }
        : null,
    };
  }

  async actualizarProveedor(codigo: string, dto: ActualizarProveedorDto, actorId: string) {
    const antes = await this.prisma.proveedor.findUnique({ where: { codigo } });
    if (!antes) throw new NotFoundException(`El proveedor "${codigo}" no existe`);
    const { variables, ...resto } = dto;
    const datos: Prisma.ProveedorUpdateInput = {
      ...resto,
      ...(variables !== undefined ? { variables: variables as Json } : {}),
      updatedBy: actorId,
    };
    return this.prisma.$transaction(async (tx) => {
      const despues = await tx.proveedor.update({ where: { codigo }, data: datos });
      await this.cambio(
        tx,
        'proveedor',
        antes.id,
        'actualizado',
        plano(antes),
        plano(despues),
        actorId,
      );
      return plano(despues);
    });
  }

  async crearVersion(proveedor: string, codigo: string, dto: CrearVersionDto, actorId: string) {
    const prov = await this.prisma.proveedor.findUnique({
      where: { codigo: proveedor },
      include: { autenticacion: true },
    });
    if (!prov) throw new NotFoundException(`El proveedor "${proveedor}" no existe`);
    this.validar(dto, prov.autenticacion?.secretos as Record<string, string> | undefined);

    return this.prisma.$transaction(async (tx) => {
      const ultima = await tx.operacion.aggregate({
        where: { proveedorId: prov.id, codigo },
        _max: { version: true },
      });
      const version = (ultima._max.version ?? 0) + 1;
      const op = await tx.operacion.create({
        data: {
          id: uuidv7(),
          proveedorId: prov.id,
          codigo,
          version,
          activa: false,
          descripcion: dto.descripcion ?? null,
          metodo: dto.metodo,
          ruta: dto.ruta,
          cabeceras: dto.cabeceras ? (plano(dto.cabeceras) as Json) : Prisma.JsonNull,
          cuerpo:
            dto.cuerpo === undefined || dto.cuerpo === null ? Prisma.JsonNull : plano(dto.cuerpo),
          paginacion: dto.paginacion ? (plano(dto.paginacion) as Json) : Prisma.JsonNull,
          rutaResultados: dto.rutaResultados ?? '',
          requiereAuth: dto.requiereAuth ?? true,
          createdBy: actorId,
        },
      });
      await tx.mapeoCampo.createMany({
        data: dto.mapeos.map((m, i) => ({
          id: uuidv7(),
          operacionId: op.id,
          destino: m.destino,
          origen: m.origen,
          transformacion: m.transformacion ?? null,
          obligatorio: m.obligatorio ?? false,
          orden: i,
        })),
      });
      await this.cambio(
        tx,
        'operacion',
        op.id,
        'version_creada',
        null,
        { proveedor, codigo, version },
        actorId,
      );
      return { id: op.id, proveedor, codigo, version, activa: false };
    });
  }

  /** Deja activa esta versión y desactiva la que lo estaba, en una sola transacción. */
  async activar(operacionId: string, actorId: string) {
    const op = await this.prisma.operacion.findUnique({
      where: { id: operacionId },
      include: { proveedor: { select: { codigo: true } } },
    });
    if (!op) throw new NotFoundException('La operación no existe');
    return this.prisma.$transaction(async (tx) => {
      const anterior = await tx.operacion.findFirst({
        where: { proveedorId: op.proveedorId, codigo: op.codigo, activa: true },
        select: { id: true, version: true },
      });
      if (anterior?.id === op.id) return { id: op.id, version: op.version, activa: true };
      if (anterior)
        await tx.operacion.update({ where: { id: anterior.id }, data: { activa: false } });
      await tx.operacion.update({ where: { id: op.id }, data: { activa: true } });
      await this.cambio(
        tx,
        'operacion',
        op.id,
        'activada',
        { version: anterior?.version ?? null },
        { proveedor: op.proveedor.codigo, codigo: op.codigo, version: op.version },
        actorId,
      );
      return { id: op.id, version: op.version, activa: true };
    });
  }

  async ejecuciones(q: EjecucionesQueryDto) {
    const filas = await this.prisma.ejecucion.findMany({
      where: q.proveedor ? { operacion: { proveedor: { codigo: q.proveedor } } } : {},
      orderBy: { iniciadaAt: 'desc' },
      take: q.limit ?? 50,
      include: {
        operacion: {
          select: { codigo: true, version: true, proveedor: { select: { codigo: true } } },
        },
      },
    });
    return filas.map((e) => ({
      id: e.id,
      proveedor: e.operacion.proveedor.codigo,
      operacion: e.operacion.codigo,
      version: e.operacion.version,
      iniciadaAt: e.iniciadaAt,
      duracionMs: e.duracionMs,
      estado: e.estado,
      httpStatus: e.httpStatus,
      registros: e.registros,
      omitidos: e.omitidos,
      error: e.error,
      solicitadoPor: e.solicitadoPor,
    }));
  }

  cambios(entidadId: string) {
    return this.prisma.cambio.findMany({
      where: { entidadId },
      orderBy: { realizadoAt: 'desc' },
      take: 100,
    });
  }

  // -----------------------------------------------------------------------------------------------------------

  /** Una versión no se guarda si sus plantillas tienen marcadores inexistentes o usan secretos no declarados. */
  private validar(dto: CrearVersionDto, secretos: Record<string, string> | undefined): void {
    const errores: string[] = [];
    const plantillas = [dto.ruta, dto.cabeceras, dto.cuerpo];
    for (const mal of plantillas.flatMap((p) => marcadoresInvalidos(p))) {
      errores.push(`marcador desconocido ${mal} (use param, var, secreto o pagina)`);
    }
    const declarados = new Set(Object.keys(secretos ?? {}));
    for (const s of plantillas.flatMap((p) => secretosUsados(p))) {
      if (!declarados.has(s)) {
        errores.push(`el secreto "${s}" no está declarado en la autenticación del proveedor`);
      }
    }
    const destinos = dto.mapeos.map((m) => m.destino);
    if (new Set(destinos).size !== destinos.length)
      errores.push('hay destinos repetidos en el mapeo');
    if (dto.metodo === 'GET' && dto.cuerpo !== undefined && dto.cuerpo !== null) {
      errores.push('una operación GET no lleva cuerpo');
    }
    if (errores.length) throw new BadRequestException(errores);
  }

  private cambio(
    tx: Prisma.TransactionClient,
    entidad: string,
    entidadId: string,
    accion: string,
    antes: unknown,
    despues: unknown,
    actorId: string,
  ) {
    return tx.cambio.create({
      data: {
        id: uuidv7(),
        entidad,
        entidadId,
        accion,
        antes: (antes ?? Prisma.JsonNull) as Json,
        despues: (despues ?? Prisma.JsonNull) as Json,
        realizadoPor: actorId,
      },
    });
  }
}

/** Copia serializable (fechas como texto) para guardar en la bitácora. */
function plano(valor: unknown): Json {
  return JSON.parse(JSON.stringify(valor)) as Json;
}
