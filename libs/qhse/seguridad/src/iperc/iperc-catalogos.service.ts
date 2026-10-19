import { BadRequestException, Injectable } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { Tx } from '../epi/epi-tipos';
import { PrismaService } from '../prisma/prisma.service';

export const TIPOS_CATALOGO_IPERC = [
  'proceso',
  'zona',
  'clasificacion',
  'generado_en',
  'cargo',
] as const;
export type TipoCatalogoIperc = (typeof TIPOS_CATALOGO_IPERC)[number];

/** Código estable a partir del nombre: minúsculas, sin acentos y con guiones bajos. */
export function codigoDe(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Clave de comparación de un nombre: sin acentos, sin mayúsculas ni espacios de más (el formato real los escribe de varias formas). */
export const claveDe = (nombre: string): string =>
  nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Catálogos de la matriz IPERC (procesos, zonas, clasificaciones de peligro, «generado en» y cargos): consulta y alta por nombre. */
@Injectable()
export class IpercCatalogosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar() {
    const lista = {
      select: { id: true, codigo: true, nombre: true },
      where: { activo: true },
    } as const;
    const [procesos, zonas, clasificaciones, generadoEn, cargos] = await Promise.all([
      this.prisma.ipercProceso.findMany({ ...lista, orderBy: { orden: 'asc' } }),
      this.prisma.ipercZona.findMany({ ...lista, orderBy: { orden: 'asc' } }),
      this.prisma.ipercClasificacionPeligro.findMany({ ...lista, orderBy: { orden: 'asc' } }),
      this.prisma.ipercGeneradoEn.findMany({ ...lista, orderBy: { orden: 'asc' } }),
      this.prisma.ipercCargo.findMany({ ...lista, orderBy: { nombre: 'asc' } }),
    ]);
    return { procesos, zonas, clasificaciones, generadoEn, cargos };
  }

  /**
   * Devuelve el id del elemento con ese nombre (sin distinguir mayúsculas ni acentos) y, si no existe, lo crea. Así la gente puede
   * agregar un proceso, una zona o un cargo nuevo sin duplicar uno que ya existe escrito de otra forma.
   */
  async asegurar(
    tx: Tx,
    tipo: TipoCatalogoIperc,
    nombreCrudo: string,
    actorId: string | null,
  ): Promise<string> {
    const nombre = nombreCrudo.replace(/\s+/g, ' ').trim();
    if (!nombre) throw new BadRequestException('Escriba el nombre');
    const clave = claveDe(nombre);
    const base = { codigo: codigoDe(nombre), createdBy: actorId, updatedBy: actorId };
    const nueva = async <T extends { codigo: string }>(
      existentes: Array<T & { id: string; nombre: string }>,
      crear: (datos: { id: string; codigo: string; nombre: string }) => Promise<unknown>,
    ): Promise<string> => {
      const ya = existentes.find((e) => claveDe(e.nombre) === clave);
      if (ya) return ya.id;
      const codigos = new Set(existentes.map((e) => e.codigo));
      let codigo = base.codigo || 'elemento';
      for (let i = 2; codigos.has(codigo); i++) codigo = `${base.codigo}_${i}`;
      const id = uuidv7();
      await crear({ id, codigo, nombre });
      return id;
    };
    const ordenSiguiente = (existentes: Array<{ orden: number }>) =>
      Math.max(0, ...existentes.map((e) => e.orden)) + 1;
    switch (tipo) {
      case 'proceso': {
        const todos = await tx.ipercProceso.findMany();
        return nueva(todos, (d) =>
          tx.ipercProceso.create({
            data: {
              ...d,
              orden: ordenSiguiente(todos),
              createdBy: base.createdBy,
              updatedBy: base.updatedBy,
            },
          }),
        );
      }
      case 'zona': {
        const todos = await tx.ipercZona.findMany();
        return nueva(todos, (d) =>
          tx.ipercZona.create({
            data: {
              ...d,
              orden: ordenSiguiente(todos),
              createdBy: base.createdBy,
              updatedBy: base.updatedBy,
            },
          }),
        );
      }
      case 'clasificacion': {
        const todos = await tx.ipercClasificacionPeligro.findMany();
        return nueva(todos, (d) =>
          tx.ipercClasificacionPeligro.create({
            data: {
              ...d,
              orden: ordenSiguiente(todos),
              createdBy: base.createdBy,
              updatedBy: base.updatedBy,
            },
          }),
        );
      }
      case 'generado_en': {
        const todos = await tx.ipercGeneradoEn.findMany();
        return nueva(todos, (d) =>
          tx.ipercGeneradoEn.create({
            data: {
              ...d,
              orden: ordenSiguiente(todos),
              createdBy: base.createdBy,
              updatedBy: base.updatedBy,
            },
          }),
        );
      }
      case 'cargo': {
        const todos = await tx.ipercCargo.findMany();
        return nueva(todos, (d) =>
          tx.ipercCargo.create({
            data: { ...d, createdBy: base.createdBy, updatedBy: base.updatedBy },
          }),
        );
      }
    }
  }

  /** Alta desde la pantalla (un proceso, zona, clasificación, «generado en» o cargo nuevo). */
  async agregar(tipo: TipoCatalogoIperc, nombre: string, actorId: string): Promise<{ id: string }> {
    const id = await this.prisma.$transaction((tx) => this.asegurar(tx, tipo, nombre, actorId));
    return { id };
  }
}
