import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import {
  EstadoEmergencia,
  MedioTransporteMedevac,
  NivelConsciencia,
  TriageColor,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmergenciasConsultaService } from './emergencias-consulta.service';
import { EmergenciasEventosService } from './emergencias-eventos.service';

export interface RegistrarHeridoEntrada {
  nombreCompleto: string;
  cedula?: string | null;
  triage: TriageColor;
  mecanismoLesion: string;
  lesiones?: string | null;
  tratamientoCampo?: string | null;
}

export interface ActualizarHeridoEntrada {
  triage?: TriageColor;
  lesiones?: string | null;
  tratamientoCampo?: string | null;
}

export interface SignosEntrada {
  pulso?: number | null;
  presionSistolica?: number | null;
  presionDiastolica?: number | null;
  respiracion?: number | null;
  consciencia?: NivelConsciencia | null;
}

export interface DatosMedevacEntrada {
  medioTransporte?: MedioTransporteMedevac | null;
  hospitalId?: string | null;
  etaMinutos?: number | null;
}

const ETIQUETA_TRIAGE: Record<TriageColor, string> = {
  rojo: 'rojo (inmediato)',
  amarillo: 'amarillo (urgente)',
  verde: 'verde (menor)',
  negro: 'negro (fallecido)',
};

/**
 * Heridos, triage médico por color y MEDEVAC (HSE-TRIAGE-001). El orden de la evacuación (activar → medio y hospital → hospital notificado →
 * transferido) lo exige la base; el servicio da el mensaje claro. Cada acción deja su línea en el cronómetro y su evento (sin el nombre ni la
 * cédula del herido: solo ids).
 */
@Injectable()
export class EmergenciasHeridosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EmergenciasEventosService,
    private readonly consulta: EmergenciasConsultaService,
  ) {}

  // ---------------------------------------------------------------------------------------------------- hospitales

  hospitales() {
    return this.prisma.emergenciaHospital.findMany({
      where: { activo: true },
      orderBy: [{ ciudad: 'asc' }, { nombre: 'asc' }],
      select: { id: true, nombre: true, ciudad: true, telefono: true },
    });
  }

  /** Agrega un hospital al catálogo (el equipo HSE lo amplía). */
  async agregarHospital(
    e: { nombre: string; ciudad: string; telefono?: string | null },
    actor: AuthUser,
  ) {
    const nombre = texto(e.nombre);
    const ciudad = texto(e.ciudad);
    if (!nombre || !ciudad)
      throw new BadRequestException('Indique el nombre y la ciudad del hospital');
    try {
      const h = await this.prisma.emergenciaHospital.create({
        data: { id: uuidv7(), nombre, ciudad, telefono: texto(e.telefono), createdBy: actor.id },
        select: { id: true, nombre: true, ciudad: true, telefono: true },
      });
      return h;
    } catch (error) {
      if (error instanceof Error && error.message.includes('emergencia_hospital_nombre_key'))
        throw new ConflictException('Ese hospital ya está en el catálogo');
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------------ heridos

  async registrar(id: string, e: RegistrarHeridoEntrada, actor: AuthUser) {
    const nombre = texto(e.nombreCompleto);
    const mecanismo = texto(e.mecanismoLesion);
    if (!nombre || !mecanismo)
      throw new BadRequestException('Indique el nombre del herido y cómo se lesionó');
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const heridoId = uuidv7();
      await tx.herido.create({
        data: {
          id: heridoId,
          emergenciaId: id,
          nombreCompleto: nombre,
          cedula: texto(e.cedula),
          triage: e.triage,
          mecanismoLesion: mecanismo,
          lesiones: texto(e.lesiones),
          tratamientoCampo: texto(e.tratamientoCampo),
          createdBy: actor.id,
        },
      });
      await tx.heridoTriageHistorial.create({
        data: { id: uuidv7(), heridoId, triage: e.triage, actorId: actor.id },
      });
      await this.eventos.linea(
        tx,
        id,
        `Herido registrado con triage ${ETIQUETA_TRIAGE[e.triage]}`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.herido_registrado', id, actor, {
        heridoId,
        triage: e.triage,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Cambia el triage o completa las lesiones y el tratamiento en campo. */
  async actualizar(id: string, heridoId: string, e: ActualizarHeridoEntrada, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const h = await this.herido(tx, id, heridoId);
      const cambiaTriage = e.triage !== undefined && e.triage !== h.triage;
      if (cambiaTriage && e.triage === TriageColor.negro && h.medevacAt)
        throw new ConflictException(
          'Un herido con MEDEVAC activado no se puede pasar a fallecido: cierre primero la evacuación',
        );
      if (!cambiaTriage && e.lesiones === undefined && e.tratamientoCampo === undefined)
        throw new BadRequestException('No hay nada que actualizar');
      await tx.herido.update({
        where: { id: heridoId },
        data: {
          ...(cambiaTriage ? { triage: e.triage } : {}),
          ...(e.lesiones === undefined ? {} : { lesiones: texto(e.lesiones) }),
          ...(e.tratamientoCampo === undefined
            ? {}
            : { tratamientoCampo: texto(e.tratamientoCampo) }),
          updatedBy: actor.id,
        },
      });
      if (cambiaTriage && e.triage) {
        await tx.heridoTriageHistorial.create({
          data: { id: uuidv7(), heridoId, triage: e.triage, actorId: actor.id },
        });
        await this.eventos.linea(
          tx,
          id,
          `Triage de un herido cambiado de ${ETIQUETA_TRIAGE[h.triage]} a ${ETIQUETA_TRIAGE[e.triage]}`,
          actor,
        );
        await this.eventos.publicar(tx, 'qhse.emergencia.herido_triage_actualizado', id, actor, {
          heridoId,
          triage: e.triage,
          triageAnterior: h.triage,
        });
      }
    });
    return this.consulta.detalle(id);
  }

  /** Toma de signos vitales: cada una es un registro nuevo (pulso, presión, respiración o consciencia). */
  async registrarSignos(id: string, heridoId: string, e: SignosEntrada, actor: AuthUser) {
    const medidas = [e.pulso, e.presionSistolica, e.respiracion, e.consciencia];
    if (medidas.every((m) => m === undefined || m === null))
      throw new BadRequestException(
        'Registre al menos una medida: pulso, presión, respiración o consciencia',
      );
    const sistolica = e.presionSistolica ?? null;
    const diastolica = e.presionDiastolica ?? null;
    if ((sistolica === null) !== (diastolica === null))
      throw new BadRequestException(
        'La presión arterial se registra completa: sistólica y diastólica',
      );
    if (sistolica !== null && diastolica !== null && sistolica < diastolica)
      throw new BadRequestException('La presión sistólica no puede ser menor que la diastólica');
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      await this.herido(tx, id, heridoId);
      await tx.heridoSignosVitales.create({
        data: {
          id: uuidv7(),
          heridoId,
          registradoPor: actor.id,
          pulso: e.pulso ?? null,
          presionSistolica: e.presionSistolica ?? null,
          presionDiastolica: e.presionDiastolica ?? null,
          respiracion: e.respiracion ?? null,
          consciencia: e.consciencia ?? null,
        },
      });
      await this.eventos.linea(tx, id, 'Signos vitales de un herido registrados', actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------ MEDEVAC

  /** Activa el MEDEVAC de un herido (lesión que amenaza la vida, atención hospitalaria en menos de 2 horas, no tratable en campo). */
  async activarMedevac(id: string, heridoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const h = await this.herido(tx, id, heridoId);
      if (h.triage === TriageColor.negro)
        throw new ConflictException('Un fallecido (triage negro) no se evacúa por MEDEVAC');
      if (h.medevacAt) throw new ConflictException('El MEDEVAC de este herido ya está activado');
      const cambio = await tx.herido.updateMany({
        where: { id: heridoId, medevacAt: null },
        data: { medevacAt: new Date(), medevacPor: actor.id, updatedBy: actor.id },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El MEDEVAC de este herido ya está activado');
      await this.eventos.linea(tx, id, 'MEDEVAC activado para un herido', actor);
      await this.eventos.publicar(tx, 'qhse.emergencia.medevac_activado', id, actor, {
        heridoId,
        triage: h.triage,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Medio de transporte, hospital de destino y ETA (se puede ajustar hasta transferir al herido). */
  async datosMedevac(id: string, heridoId: string, e: DatosMedevacEntrada, actor: AuthUser) {
    if (e.medioTransporte === undefined && e.hospitalId === undefined && e.etaMinutos === undefined)
      throw new BadRequestException('No hay nada que actualizar');
    if (e.medioTransporte === null || e.hospitalId === null || e.etaMinutos === null)
      throw new BadRequestException(
        'El medio de transporte, el hospital y el ETA no se pueden vaciar: indique el valor nuevo',
      );
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const h = await this.herido(tx, id, heridoId);
      if (!h.medevacAt) throw new ConflictException('Primero active el MEDEVAC de este herido');
      if (h.transferidoAt)
        throw new ConflictException('El herido ya fue transferido: su destino no se cambia');
      // tras notificar al hospital, el hospital y el medio de transporte ya no cambian (el ETA sí puede ajustarse)
      if (
        h.hospitalNotificadoAt &&
        ((e.hospitalId !== undefined && e.hospitalId !== h.hospitalId) ||
          (e.medioTransporte !== undefined && e.medioTransporte !== h.medioTransporte))
      )
        throw new ConflictException(
          'El hospital ya fue notificado: el hospital y el medio de transporte no se cambian',
        );
      if (e.hospitalId) {
        const hospital = await tx.emergenciaHospital.findUnique({ where: { id: e.hospitalId } });
        if (!hospital?.activo)
          throw new BadRequestException('El hospital no existe o está inactivo');
      }
      await tx.herido.update({
        where: { id: heridoId },
        data: {
          ...(e.medioTransporte === undefined ? {} : { medioTransporte: e.medioTransporte }),
          ...(e.hospitalId === undefined ? {} : { hospitalId: e.hospitalId }),
          ...(e.etaMinutos === undefined ? {} : { etaMinutos: e.etaMinutos }),
          updatedBy: actor.id,
        },
      });
      await this.eventos.linea(tx, id, 'Datos del MEDEVAC de un herido actualizados', actor);
    });
    return this.consulta.detalle(id);
  }

  /** Registra que se notificó al hospital (exige el medio de transporte y el hospital de destino). */
  async notificarHospital(id: string, heridoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const h = await this.herido(tx, id, heridoId);
      if (!h.medevacAt) throw new ConflictException('Primero active el MEDEVAC de este herido');
      if (!h.medioTransporte || !h.hospitalId)
        throw new ConflictException(
          'Para notificar al hospital indique antes el medio de transporte y el hospital de destino',
        );
      if (h.hospitalNotificadoAt)
        throw new ConflictException('El hospital ya fue notificado de este herido');
      const cambio = await tx.herido.updateMany({
        where: { id: heridoId, hospitalNotificadoAt: null },
        data: {
          hospitalNotificadoAt: new Date(),
          hospitalNotificadoPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El hospital ya fue notificado de este herido');
      const hospital = await tx.emergenciaHospital.findUniqueOrThrow({
        where: { id: h.hospitalId },
      });
      await this.eventos.linea(
        tx,
        id,
        `Hospital notificado: ${hospital.nombre} (${hospital.ciudad})`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.hospital_notificado', id, actor, {
        heridoId,
        hospitalId: hospital.id,
        hospitalNombre: hospital.nombre,
        medioTransporte: h.medioTransporte,
        etaMinutos: h.etaMinutos,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Registra la transferencia del herido al hospital (exige haber notificado al hospital). */
  async transferir(id: string, heridoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      const h = await this.herido(tx, id, heridoId);
      if (!h.hospitalNotificadoAt)
        throw new ConflictException('Para transferir al herido notifique antes al hospital');
      if (h.transferidoAt) throw new ConflictException('Este herido ya fue transferido');
      const cambio = await tx.herido.updateMany({
        where: { id: heridoId, transferidoAt: null },
        data: { transferidoAt: new Date(), transferidoPor: actor.id, updatedBy: actor.id },
      });
      if (cambio.count !== 1) throw new ConflictException('Este herido ya fue transferido');
      await this.eventos.linea(tx, id, 'Herido transferido al hospital', actor);
      await this.eventos.publicar(tx, 'qhse.emergencia.herido_transferido', id, actor, {
        heridoId,
        hospitalId: h.hospitalId,
      });
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async abierta(tx: Tx, id: string) {
    const e = await tx.emergencia.findUnique({ where: { id }, select: { estado: true } });
    if (!e) throw new NotFoundException('La emergencia no existe');
    if (e.estado === EstadoEmergencia.cerrada)
      throw new ConflictException('Una emergencia cerrada ya no se modifica');
  }

  private async herido(tx: Tx, emergenciaId: string, heridoId: string) {
    const h = await tx.herido.findFirst({ where: { id: heridoId, emergenciaId } });
    if (!h) throw new NotFoundException('El herido no existe en esta emergencia');
    return h;
  }
}
