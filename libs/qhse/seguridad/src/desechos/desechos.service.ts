import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador, masMeses } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import { ClasificacionDesecho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { codigoDesecho } from './desechos-consulta.service';
import { DesechosEventosService } from './desechos-eventos.service';

export interface LineaEntrada {
  descripcion: string;
  numeroLote?: string | null;
  codigo: string;
  cantidadGalones: number;
  bultos?: number;
}

export interface RegistrarDesechoEntrada {
  clasificacion: ClasificacionDesecho;
  contenedorId: string;
  /** Solo para un desecho peligroso (CRETIB); uno no peligroso no lleva. */
  caracteristicaIds?: string[];
  descripcion: string;
  pozoId?: string | null;
  ubicacion?: string | null;
  items: LineaEntrada[];
}

/** Desecho creado dentro de una transacción: su id y su consecutivo. */
export interface DesechoCreado {
  id: string;
  numero: number;
}

/**
 * Desechos (HSE-AMBIENTAL-001, DYN-SGI-RE-063). Cualquier trabajador registra; el equipo HSE gestiona el manifiesto y el certificado.
 * El límite de almacenamiento (AM 142: 12 meses desde el registro) y las reglas del ciclo las garantiza la base (CHECK y triggers).
 */
@Injectable()
export class DesechosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DesechosEventosService,
  ) {}

  /** Registra el desecho con sus características y las líneas de la guía. Devuelve lo mínimo (quien reporta puede no ver la bandeja). */
  async registrar(entrada: RegistrarDesechoEntrada, actor: AuthUser) {
    const creado = await this.prisma.$transaction((tx) => this.crearEn(tx, entrada, actor));
    return { id: creado.id, codigo: codigoDesecho(creado.numero), estado: 'almacenado' };
  }

  /**
   * Crea el desecho dentro de una transacción ya abierta (así un derrame en suelo y el desecho que genera se guardan juntos). `derrameId` es
   * el derrame de origen: la base exige que sea de una ubicación que genera desecho y que el desecho sea peligroso.
   */
  async crearEn(
    tx: Tx,
    entrada: RegistrarDesechoEntrada,
    actor: AuthUser,
    derrameId: string | null = null,
  ): Promise<DesechoCreado> {
    const descripcion = texto(entrada.descripcion);
    if (!descripcion) throw new BadRequestException('Describa el desecho');
    if (!entrada.items?.length)
      throw new BadRequestException(
        'La guía necesita al menos una línea (descripción, código y cantidad)',
      );
    const cretib = [...new Set(entrada.caracteristicaIds ?? [])];
    if (entrada.clasificacion === ClasificacionDesecho.peligroso && !cretib.length)
      throw new BadRequestException(
        'Un desecho peligroso necesita al menos una característica CRETIB',
      );
    if (entrada.clasificacion === ClasificacionDesecho.no_peligroso && cretib.length)
      throw new BadRequestException('Un desecho no peligroso no lleva características CRETIB');

    const id = uuidv7();
    const hoy = hoyEcuador();
    const contenedor = await tx.desechoContenedor.findUnique({
      where: { id: entrada.contenedorId },
    });
    if (!contenedor?.activo)
      throw new BadRequestException('El contenedor no existe o está inactivo');
    if (cretib.length) {
      const validas = await tx.desechoCaracteristica.count({
        where: { id: { in: cretib }, activo: true },
      });
      if (validas !== cretib.length)
        throw new BadRequestException('Alguna característica CRETIB no existe o está inactiva');
    }
    if (
      entrada.pozoId &&
      !(await tx.catPozo.count({ where: { id: entrada.pozoId, habilitado: true } }))
    )
      throw new BadRequestException('El pozo no existe o está deshabilitado');
    const almacenado = await tx.desechoEstado.findUniqueOrThrow({
      where: { codigo: 'almacenado' },
    });

    const creado = await tx.desecho.create({
      data: {
        id,
        clasificacion: entrada.clasificacion,
        contenedorId: contenedor.id,
        estadoId: almacenado.id,
        descripcion,
        pozoId: entrada.pozoId ?? null,
        ubicacion: texto(entrada.ubicacion),
        derrameId,
        registradoEl: aFecha(hoy),
        limiteAlmacenamientoHasta: aFecha(masMeses(hoy, 12)),
        createdBy: actor.id,
      },
      select: { numero: true },
    });
    for (const caracteristicaId of cretib)
      await tx.desechoCaracteristicaAsignada.create({
        data: { desechoId: id, caracteristicaId },
      });
    for (const [i, l] of entrada.items.entries()) {
      const d = texto(l.descripcion);
      const c = texto(l.codigo);
      if (!d || !c)
        throw new BadRequestException(
          `La línea ${i + 1} necesita descripción y código del desecho`,
        );
      if (!(l.cantidadGalones > 0))
        throw new BadRequestException(`La cantidad de la línea ${i + 1} debe ser mayor que cero`);
      await tx.desechoItem.create({
        data: {
          id: uuidv7(),
          desechoId: id,
          orden: i + 1,
          descripcion: d,
          numeroLote: texto(l.numeroLote),
          codigo: c,
          cantidadGalones: l.cantidadGalones,
          bultos: l.bultos ?? 0,
          createdBy: actor.id,
        },
      });
    }
    await tx.desechoHistorial.create({
      data: { id: uuidv7(), desechoId: id, estadoNuevoId: almacenado.id, actorId: actor.id },
    });
    await this.eventos.publicar(tx, 'qhse.desecho.registrado', id, actor, {
      ...(derrameId ? { derrameId } : {}),
    });
    return { id, numero: creado.numero };
  }
}
