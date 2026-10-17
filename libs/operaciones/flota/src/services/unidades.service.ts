import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { CategoriaPeso, Prisma, TipoUnidad } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { LECTURA_DE_TIPO, LecturasService, type ActorLectura } from './lecturas.service';

export interface UnidadEntrada {
  codigo: string;
  nombre: string;
  tipo: TipoUnidad;
  categoriaPeso?: CategoriaPeso | null;
  vehiculoId?: string | null;
  proveedorMantenimientoId?: string | null;
  fechaMatricula?: string | null;
  caducidadMatricula?: string | null;
  caducidadPoliza?: string | null;
  vigenciaOtroDocumento?: string | null;
  responsablePatrimonialId?: string | null;
  predeterminada?: boolean;
  nota?: string | null;
  /** Horómetro (servicio) o kilometraje (transporte) de arranque; sin él la unidad no genera alertas hasta su primera lectura. */
  lecturaInicial?: number | null;
}

/** Lo que se puede cambiar de una unidad ya creada: no su código ni su tipo (cambiarían el sentido de sus lecturas). */
export type UnidadCambios = Partial<Omit<UnidadEntrada, 'codigo' | 'tipo' | 'lecturaInicial'>>;

export interface FiltroUnidades {
  tipo?: TipoUnidad;
  /** `true` (por omisión) solo las activas; `false` solo las dadas de baja; `todas` ambas. */
  activa?: boolean | 'todas';
  q?: string;
}

const fechaDia = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type UnidadConRelaciones = Prisma.UnidadGetPayload<{
  include: {
    vehiculo: { include: { tipoVehiculo: true } };
    proveedorMantenimiento: true;
    responsablePatrimonial: true;
  };
}>;

const INCLUIR = {
  vehiculo: { include: { tipoVehiculo: true } },
  proveedorMantenimiento: true,
  responsablePatrimonial: true,
} as const;

/** Unidades de Dynadrill: alta, ficha, patrimonio y baja lógica. Las lecturas y los preventivos tienen su propio servicio. */
@Injectable()
export class UnidadesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lecturas: LecturasService,
    private readonly bus: EventBus,
  ) {}

  async listar(f: FiltroUnidades = {}) {
    const q = f.q?.trim();
    const unidades = await this.prisma.unidad.findMany({
      where: {
        ...(f.tipo ? { tipo: f.tipo } : {}),
        ...(f.activa === 'todas' ? {} : { activa: f.activa ?? true }),
        ...(q
          ? {
              OR: [
                { codigo: { contains: q, mode: 'insensitive' } },
                { nombre: { contains: q, mode: 'insensitive' } },
                { vehiculo: { placa: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: INCLUIR,
      orderBy: { codigo: 'asc' },
    });
    const vigentes = await this.lecturas.vigentes(unidades.map((u) => u.id));
    return unidades.map((u) => this.presentar(u, vigentes.get(u.id)));
  }

  async obtener(id: string) {
    const u = await this.prisma.unidad.findUnique({ where: { id }, include: INCLUIR });
    if (!u) throw new NotFoundException('La unidad no existe');
    const vigentes = await this.lecturas.vigentes([id]);
    return this.presentar(u, vigentes.get(id));
  }

  async crear(e: UnidadEntrada, actor: ActorLectura) {
    const codigo = e.codigo.trim().toUpperCase();
    this.validar(e.tipo, e.categoriaPeso ?? null, e.lecturaInicial ?? null);
    await this.validarReferencias(this.prisma, e);
    const id = await this.prisma.$transaction(async (tx) => {
      const existe = await tx.unidad.findUnique({ where: { codigo }, select: { id: true } });
      if (existe) {
        throw new ConflictException({
          message: `Ya existe una unidad con el código ${codigo}`,
          code: 'codigo_duplicado',
        });
      }
      const nueva = await tx.unidad.create({
        data: {
          id: uuidv7(),
          codigo,
          nombre: e.nombre.trim(),
          tipo: e.tipo,
          categoriaPeso: e.categoriaPeso ?? null,
          vehiculoId: e.vehiculoId ?? null,
          proveedorMantenimientoId: e.proveedorMantenimientoId ?? null,
          fechaMatricula: fechaDia(e.fechaMatricula),
          caducidadMatricula: fechaDia(e.caducidadMatricula),
          caducidadPoliza: fechaDia(e.caducidadPoliza),
          vigenciaOtroDocumento: fechaDia(e.vigenciaOtroDocumento),
          responsablePatrimonialId: e.responsablePatrimonialId ?? null,
          predeterminada: e.predeterminada ?? false,
          nota: e.nota?.trim() || null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      const lectura = LECTURA_DE_TIPO[e.tipo];
      if (lectura && e.lecturaInicial != null) {
        await this.lecturas.registrar(
          nueva.id,
          { tipo: lectura, valor: e.lecturaInicial, fuente: 'carga_inicial' },
          actor,
          tx,
        );
      }
      await this.bus.publish(
        tx,
        createEvent({
          type: 'flota.unidad.creada',
          source: 'flota',
          subject: { type: 'flota_unidad', id: nueva.id },
          data: { unidadId: nueva.id, codigo, tipo: e.tipo },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return nueva.id;
    });
    return this.obtener(id);
  }

  async actualizar(id: string, c: UnidadCambios, actor: ActorLectura) {
    const actual = await this.prisma.unidad.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('La unidad no existe');
    const categoria = c.categoriaPeso === undefined ? actual.categoriaPeso : c.categoriaPeso;
    this.validar(actual.tipo, categoria, null);
    await this.validarReferencias(this.prisma, c, id);
    const data: Prisma.UnidadUncheckedUpdateInput = { updatedBy: actor.id, updatedAt: new Date() };
    if (c.nombre !== undefined) data.nombre = c.nombre.trim();
    if (c.categoriaPeso !== undefined) data.categoriaPeso = c.categoriaPeso;
    if (c.vehiculoId !== undefined) data.vehiculoId = c.vehiculoId;
    if (c.proveedorMantenimientoId !== undefined)
      data.proveedorMantenimientoId = c.proveedorMantenimientoId;
    if (c.fechaMatricula !== undefined) data.fechaMatricula = fechaDia(c.fechaMatricula);
    if (c.caducidadMatricula !== undefined)
      data.caducidadMatricula = fechaDia(c.caducidadMatricula);
    if (c.caducidadPoliza !== undefined) data.caducidadPoliza = fechaDia(c.caducidadPoliza);
    if (c.vigenciaOtroDocumento !== undefined)
      data.vigenciaOtroDocumento = fechaDia(c.vigenciaOtroDocumento);
    if (c.responsablePatrimonialId !== undefined)
      data.responsablePatrimonialId = c.responsablePatrimonialId;
    if (c.predeterminada !== undefined) data.predeterminada = c.predeterminada;
    if (c.nota !== undefined) data.nota = c.nota?.trim() || null;
    await this.prisma.unidad.update({ where: { id }, data });
    return this.obtener(id);
  }

  /** Baja lógica y reactivación. Una unidad dada de baja no recibe lecturas ni preventivos nuevos. */
  async cambiarActiva(id: string, activa: boolean, actor: ActorLectura) {
    const actual = await this.prisma.unidad.findUnique({ where: { id }, select: { id: true } });
    if (!actual) throw new NotFoundException('La unidad no existe');
    await this.prisma.unidad.update({
      where: { id },
      data: { activa, updatedBy: actor.id, updatedAt: new Date() },
    });
    return this.obtener(id);
  }

  private validar(
    tipo: TipoUnidad,
    categoria: CategoriaPeso | null,
    lecturaInicial: number | null,
  ) {
    if (categoria && tipo !== 'transporte') {
      throw new BadRequestException({
        message: 'La categoría de peso (pesado o liviano) solo aplica a las unidades de transporte',
        code: 'categoria_no_aplica',
      });
    }
    if (lecturaInicial !== null && !LECTURA_DE_TIPO[tipo]) {
      throw new BadRequestException({
        message:
          'Las unidades auxiliares se controlan por tiempo: no llevan horómetro ni kilometraje',
        code: 'unidad_sin_lectura',
      });
    }
  }

  /** Comprueba que el vehículo, el proveedor y el responsable existan y que el vehículo no esté ya ligado a otra unidad. */
  private async validarReferencias(
    db: Prisma.TransactionClient | PrismaService,
    e: UnidadCambios,
    propiaId?: string,
  ) {
    if (e.vehiculoId) {
      const v = await db.catVehiculo.findUnique({
        where: { id: e.vehiculoId },
        include: { unidad: true },
      });
      if (!v)
        throw new BadRequestException({
          message: 'El vehículo del catálogo no existe',
          code: 'vehiculo_invalido',
        });
      if (v.unidad && v.unidad.id !== propiaId) {
        throw new ConflictException({
          message: `Ese vehículo ya es la unidad ${v.unidad.codigo}`,
          code: 'vehiculo_ya_ligado',
        });
      }
    }
    if (e.proveedorMantenimientoId) {
      const p = await db.proveedorMantenimiento.findUnique({
        where: { id: e.proveedorMantenimientoId },
      });
      if (!p?.activo)
        throw new BadRequestException({
          message: 'El proveedor de mantenimiento no existe o está inactivo',
          code: 'proveedor_invalido',
        });
    }
    if (e.responsablePatrimonialId) {
      const u = await db.idUsuario.findUnique({ where: { id: e.responsablePatrimonialId } });
      if (!u?.activo)
        throw new BadRequestException({
          message: 'El responsable patrimonial no es una cuenta activa',
          code: 'responsable_invalido',
        });
    }
  }

  private presentar(
    u: UnidadConRelaciones,
    vigentes?: {
      horometro?: { valor: number; leidaAt: Date };
      odometro?: { valor: number; leidaAt: Date };
    },
  ) {
    return {
      id: u.id,
      codigo: u.codigo,
      nombre: u.nombre,
      tipo: u.tipo,
      categoriaPeso: u.categoriaPeso,
      activa: u.activa,
      predeterminada: u.predeterminada,
      nota: u.nota,
      vehiculo: u.vehiculo
        ? {
            id: u.vehiculo.id,
            placa: u.vehiculo.placa,
            marca: u.vehiculo.marca,
            modelo: u.vehiculo.modelo,
            anio: u.vehiculo.anio,
            tipoVehiculo: u.vehiculo.tipoVehiculo?.nombre ?? null,
          }
        : null,
      proveedorMantenimiento: u.proveedorMantenimiento
        ? { id: u.proveedorMantenimiento.id, nombre: u.proveedorMantenimiento.nombre }
        : null,
      responsablePatrimonial: u.responsablePatrimonial
        ? { id: u.responsablePatrimonial.id, nombre: u.responsablePatrimonial.nombre }
        : null,
      documentos: {
        fechaMatricula: dia(u.fechaMatricula),
        caducidadMatricula: dia(u.caducidadMatricula),
        caducidadPoliza: dia(u.caducidadPoliza),
        vigenciaOtroDocumento: dia(u.vigenciaOtroDocumento),
      },
      horometro: vigentes?.horometro ?? null,
      odometro: vigentes?.odometro ?? null,
    };
  }
}
