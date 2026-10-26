import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador } from '../comun/fechas';
import { firmaDeUnaLinea } from '../comun/firma';
import { texto, type Tx } from '../epi/epi-tipos';
import { RolFirmaDesecho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { DesechosConsultaService } from './desechos-consulta.service';
import { DesechosEventosService } from './desechos-eventos.service';

/** Guía de remisión: el transporte y las horas que imprime el formato DYN-SGI-RE-063 (todo opcional hasta que se conoce). */
export interface GuiaEntrada {
  clienteId?: string | null;
  solicitadoPor?: string | null;
  transportistaCompania?: string | null;
  conductorNombre?: string | null;
  conductorCedula?: string | null;
  vehiculo?: string | null;
  placas?: string | null;
  horaSalida?: string | null;
  horaLlegada?: string | null;
}

export interface GenerarManifiestoEntrada extends GuiaEntrada {
  numero: string;
  gestorNombre: string;
  /** Licencia ambiental vigente del gestor (SUIA): obligatoria para generar el manifiesto. */
  gestorLicenciaSuia: string;
}

export interface FirmaEntrada {
  /** Quien firma en papel cuando no tiene cuenta (conductor o gestor): obligatorios para «transportado por» y «recibido por». */
  firmanteNombre?: string | null;
  firmanteCedula?: string | null;
}

const hora = (v: string | null | undefined, campo: string): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(`La ${campo} no es una fecha y hora válida`);
  return d;
};

/**
 * Manifiesto único y sus tres firmas («despachado por», «transportado por», «recibido por»). Generarlo pasa el desecho a con manifiesto;
 * cada firma es «de una línea» (D6): la cuenta con la sesión y la hora del servidor, más el nombre y la cédula de quien firma en papel
 * cuando es un tercero. Las reglas las garantiza además la base (triggers y CHECK).
 */
@Injectable()
export class DesechosManifiestoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DesechosEventosService,
    private readonly consulta: DesechosConsultaService,
  ) {}

  async generar(id: string, entrada: GenerarManifiestoEntrada, actor: AuthUser) {
    const numero = texto(entrada.numero);
    const gestor = texto(entrada.gestorNombre);
    const licencia = texto(entrada.gestorLicenciaSuia);
    if (!numero || !gestor || !licencia)
      throw new BadRequestException(
        'Para generar el manifiesto indique el número, el gestor y su licencia ambiental (SUIA)',
      );
    const guia = await this.guiaValidada(this.prisma, entrada);
    await this.prisma
      .$transaction(async (tx) => {
        const d = await this.desecho(tx, id);
        if (d.estado.codigo !== 'almacenado')
          throw new ConflictException('El manifiesto se genera con el desecho almacenado');
        if (await tx.desechoManifiesto.count({ where: { numero } }))
          throw new ConflictException('Ya existe un manifiesto con ese número');
        await tx.desechoManifiesto.create({
          data: {
            id: uuidv7(),
            desechoId: id,
            numero,
            fecha: aFecha(hoyEcuador()),
            gestorNombre: gestor,
            gestorLicenciaSuia: licencia,
            ...guia,
            createdBy: actor.id,
          },
        });
        const manifiesto = await tx.desechoEstado.findUniqueOrThrow({
          where: { codigo: 'con_manifiesto' },
        });
        const cambio = await tx.desecho.updateMany({
          where: { id, estadoId: d.estadoId },
          data: { estadoId: manifiesto.id, updatedBy: actor.id },
        });
        if (cambio.count !== 1)
          throw new ConflictException('El desecho cambió; recargue e intente de nuevo');
        await tx.desechoHistorial.create({
          data: {
            id: uuidv7(),
            desechoId: id,
            estadoAnteriorId: d.estadoId,
            estadoNuevoId: manifiesto.id,
            actorId: actor.id,
          },
        });
        await this.eventos.publicar(tx, 'qhse.desecho.manifiesto_generado', id, actor);
      })
      .catch(this.numeroRepetido);
    return this.consulta.detalle(id);
  }

  /** Completa el transporte y las horas de la guía mientras falten firmas. */
  async actualizarGuia(id: string, entrada: GuiaEntrada, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.manifiesto(tx, id);
      if ((await tx.desechoFirma.count({ where: { manifiestoId: m.id } })) >= 3)
        throw new ConflictException('El manifiesto ya tiene las tres firmas y no se modifica');
      const guia = await this.guiaValidada(tx, entrada);
      if (!Object.keys(guia).length) throw new BadRequestException('No hay nada que actualizar');
      const salida = (guia['horaSalida'] as Date | null | undefined) ?? m.horaSalida;
      const llegada = (guia['horaLlegada'] as Date | null | undefined) ?? m.horaLlegada;
      if (salida && llegada && llegada < salida)
        throw new BadRequestException('La hora de llegada no puede ser anterior a la de salida');
      await tx.desechoManifiesto.update({
        where: { id: m.id },
        data: { ...guia, updatedBy: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  async firmar(id: string, rol: RolFirmaDesecho, entrada: FirmaEntrada, actor: AuthUser) {
    const tercero = rol !== RolFirmaDesecho.despachado_por;
    const nombre = tercero ? texto(entrada.firmanteNombre) : null;
    const cedula = tercero ? texto(entrada.firmanteCedula) : null;
    if (tercero && (!nombre || !cedula))
      throw new BadRequestException(
        'Indique el nombre y la cédula de quien firma el manifiesto en papel',
      );
    await this.prisma.$transaction(async (tx) => {
      const m = await this.manifiesto(tx, id);
      const d = await this.desecho(tx, id);
      if (d.estado.codigo !== 'con_manifiesto')
        throw new ConflictException('Solo se firma el manifiesto de un desecho con manifiesto');
      if (await tx.desechoFirma.count({ where: { manifiestoId: m.id, rol } }))
        throw new ConflictException('Esa firma ya está registrada');
      const firma = await tx.desechoFirma.create({
        data: {
          id: uuidv7(),
          manifiestoId: m.id,
          rol,
          registradoPor: actor.id,
          firmanteNombre: nombre,
          firmanteCedula: cedula,
        },
      });
      const firmadas = await tx.desechoFirma.count({ where: { manifiestoId: m.id } });
      await this.eventos.publicar(tx, 'qhse.desecho.firmado', id, actor, {
        rolFirma: rol,
        firmasRegistradas: firmadas,
        firmasCompletas: firmadas === 3,
        // evidencia (contrato 4.14); el firmante en papel (nombre y cédula) se guarda aquí porque Firmas no tiene dónde
        ...firmaDeUnaLinea('qhse_desecho', id, rol, actor.id, firma.firmadoAt, nombre ?? '', cedula ?? ''),
      });
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async desecho(tx: Tx, id: string) {
    const d = await tx.desecho.findUnique({
      where: { id },
      select: { estadoId: true, estado: { select: { codigo: true } } },
    });
    if (!d) throw new NotFoundException('El desecho no existe');
    return d;
  }

  private async manifiesto(tx: Tx, desechoId: string) {
    const m = await tx.desechoManifiesto.findUnique({ where: { desechoId } });
    if (!m) throw new NotFoundException('El desecho todavía no tiene manifiesto');
    return m;
  }

  /** Solo los campos que vienen (un valor vacío limpia el campo); valida el cliente y que la llegada no sea anterior a la salida. */
  private async guiaValidada(db: Pick<Tx, 'catCliente'>, e: GuiaEntrada) {
    const datos: Record<string, string | Date | null> = {};
    const textos = [
      'solicitadoPor',
      'transportistaCompania',
      'conductorNombre',
      'conductorCedula',
      'vehiculo',
      'placas',
    ] as const;
    for (const k of textos) if (e[k] !== undefined) datos[k] = texto(e[k]);
    if (e.clienteId !== undefined) {
      if (e.clienteId && !(await db.catCliente.count({ where: { id: e.clienteId } })))
        throw new BadRequestException('El cliente no existe');
      datos['clienteId'] = e.clienteId ?? null;
    }
    if (e.horaSalida !== undefined) datos['horaSalida'] = hora(e.horaSalida, 'hora de salida');
    if (e.horaLlegada !== undefined) datos['horaLlegada'] = hora(e.horaLlegada, 'hora de llegada');
    const salida = datos['horaSalida'];
    const llegada = datos['horaLlegada'];
    if (salida instanceof Date && llegada instanceof Date && llegada < salida)
      throw new BadRequestException('La hora de llegada no puede ser anterior a la de salida');
    return datos;
  }

  /** Dos peticiones simultáneas con el mismo número: la base rechaza la segunda con un mensaje claro. */
  private readonly numeroRepetido = (e: unknown): never => {
    if (e instanceof Error && e.message.includes('desecho_manifiesto_numero_key'))
      throw new ConflictException('Ya existe un manifiesto con ese número');
    throw e;
  };
}
