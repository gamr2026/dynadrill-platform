import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { aFecha } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import {
  EstadoInvestigacion,
  JornadaSuceso,
  SexoPersona,
  ZonaIncidente,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';

export interface TrabajadorEntrada {
  /** Cuenta del portal: sus datos se leen de identidad. Sin cuenta, `apellidosNombres` y `cedula` son obligatorios. */
  usuarioId?: string | null;
  apellidosNombres?: string | null;
  cedula?: string | null;
  cargo?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  fechaNacimiento?: string | null;
  sexo?: SexoPersona | null;
  fechaIngreso?: string | null;
  tipoVinculacion?: string | null;
  oficioDesempenaba?: string | null;
  jornadaHabitual?: string | null;
  tiempoExperienciaMeses?: number | null;
}

export interface DetalleEntrada {
  jornadaSuceso?: JornadaSuceso | null;
  empresaDondeOcurrio?: string | null;
  direccionOcurrencia?: string | null;
  zona?: ZonaIncidente | null;
  oficioEraPropioDelCargo?: boolean | null;
  /** HH:mm */
  horaInicioJornada?: string | null;
  tiempoLaboradoPrevioHoras?: number | null;
  seInformoOportunamente?: boolean | null;
  tiempoAtencionMedica?: string | null;
  centroMedico?: string | null;
  causoMuerte?: boolean;
  fechaMuerte?: string | null;
  parteCuerpoAfectada?: string | null;
  tipoLesionSufrida?: string | null;
  factorQueOrigino?: string | null;
  totalDiasIncapacidad?: number | null;
  continuaIncapacitado?: boolean | null;
  sucesosSimilaresPrevios?: boolean | null;
  sucesosSimilaresDetalle?: string | null;
  danosMateriales?: string | null;
  totalPerdidasEconomicas?: number | null;
  danosMedioAmbiente?: string | null;
}

export interface MiembroEquipoEntrada {
  usuarioId?: string | null;
  nombreExterno?: string | null;
}

export interface TestigoEntrada {
  nombresApellidos: string;
  cedula?: string | null;
  version: string;
}

export interface FactorEntornoEntrada {
  tipo: string;
  fuente: string;
  existeControl: boolean;
  contribuyoAlSuceso: boolean;
}

const MAX_TESTIGOS = 3;

/**
 * Lo que el formato DYN-SGI-RE-034 pide de campo: trabajador involucrado, información del incidente, equipo investigador, testigos y entorno
 * de trabajo. Se edita mientras la investigación está abierta o en investigación (la base también lo impide después). Cada operación
 * reemplaza la sección completa dentro de una transacción.
 */
@Injectable()
export class InvestigacionesFormatoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  async guardarTrabajador(id: string, e: TrabajadorEntrada, actor: AuthUser) {
    const usuarioId = e.usuarioId ?? null;
    const nombre = texto(e.apellidosNombres);
    const cedula = texto(e.cedula);
    if (usuarioId && (nombre || cedula || texto(e.cargo)))
      throw new BadRequestException(
        'Si el trabajador tiene cuenta del portal, no escriba su nombre, cédula ni cargo: se toman de su perfil',
      );
    if (!usuarioId && (!nombre || !cedula))
      throw new BadRequestException(
        'Indique la cuenta del trabajador o, si no tiene, sus apellidos, nombres y cédula',
      );
    const datos = {
      usuarioId,
      apellidosNombres: usuarioId ? null : nombre,
      cedula: usuarioId ? null : cedula,
      cargo: usuarioId ? null : texto(e.cargo),
      direccion: texto(e.direccion),
      telefono: texto(e.telefono),
      fechaNacimiento: e.fechaNacimiento ? aFecha(e.fechaNacimiento) : null,
      sexo: e.sexo ?? null,
      fechaIngreso: e.fechaIngreso ? aFecha(e.fechaIngreso) : null,
      tipoVinculacion: texto(e.tipoVinculacion),
      oficioDesempenaba: texto(e.oficioDesempenaba),
      jornadaHabitual: texto(e.jornadaHabitual),
      tiempoExperienciaMeses: e.tiempoExperienciaMeses ?? null,
    };
    await this.editar(id, async (tx, lesionado) => {
      if (!lesionado)
        throw new BadRequestException(
          'Este resultado no involucra a un trabajador lesionado: no lleva datos del trabajador',
        );
      if (usuarioId && !(await tx.idUsuario.count({ where: { id: usuarioId } })))
        throw new BadRequestException('La cuenta del trabajador no existe');
      await tx.investigacionTrabajador.upsert({
        where: { investigacionId: id },
        create: { investigacionId: id, ...datos, createdBy: actor.id },
        update: { ...datos, updatedBy: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarDetalle(id: string, e: DetalleEntrada, actor: AuthUser) {
    const causoMuerte = e.causoMuerte ?? false;
    if (causoMuerte && !e.fechaMuerte)
      throw new BadRequestException('Indique la fecha de la muerte');
    if (!causoMuerte && e.fechaMuerte)
      throw new BadRequestException(
        'La fecha de muerte solo aplica si el incidente causó una muerte',
      );
    if (e.sucesosSimilaresDetalle && !e.sucesosSimilaresPrevios)
      throw new BadRequestException('Marque que hubo sucesos similares antes de detallarlos');
    const datos = {
      jornadaSuceso: e.jornadaSuceso ?? null,
      empresaDondeOcurrio: texto(e.empresaDondeOcurrio),
      direccionOcurrencia: texto(e.direccionOcurrencia),
      zona: e.zona ?? null,
      oficioEraPropioDelCargo: e.oficioEraPropioDelCargo ?? null,
      horaInicioJornada: e.horaInicioJornada
        ? new Date(`1970-01-01T${e.horaInicioJornada}:00.000Z`)
        : null,
      tiempoLaboradoPrevioHoras: e.tiempoLaboradoPrevioHoras ?? null,
      seInformoOportunamente: e.seInformoOportunamente ?? null,
      tiempoAtencionMedica: texto(e.tiempoAtencionMedica),
      centroMedico: texto(e.centroMedico),
      causoMuerte,
      fechaMuerte: e.fechaMuerte ? aFecha(e.fechaMuerte) : null,
      parteCuerpoAfectada: texto(e.parteCuerpoAfectada),
      tipoLesionSufrida: texto(e.tipoLesionSufrida),
      factorQueOrigino: texto(e.factorQueOrigino),
      totalDiasIncapacidad: e.totalDiasIncapacidad ?? null,
      continuaIncapacitado: e.continuaIncapacitado ?? null,
      sucesosSimilaresPrevios: e.sucesosSimilaresPrevios ?? null,
      sucesosSimilaresDetalle: texto(e.sucesosSimilaresDetalle),
      danosMateriales: texto(e.danosMateriales),
      totalPerdidasEconomicas: e.totalPerdidasEconomicas ?? null,
      danosMedioAmbiente: texto(e.danosMedioAmbiente),
    };
    await this.editar(id, async (tx, lesionado) => {
      const conLesion =
        causoMuerte ||
        datos.fechaMuerte ||
        datos.parteCuerpoAfectada ||
        datos.tipoLesionSufrida ||
        datos.totalDiasIncapacidad !== null ||
        datos.continuaIncapacitado !== null ||
        datos.centroMedico ||
        datos.tiempoAtencionMedica;
      if (conLesion && !lesionado)
        throw new BadRequestException(
          'Este resultado no involucra a un lesionado: no lleva datos de la lesión',
        );
      await tx.investigacionDetalle.upsert({
        where: { investigacionId: id },
        create: { investigacionId: id, ...datos, createdBy: actor.id },
        update: { ...datos, updatedBy: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarEquipo(id: string, miembros: MiembroEquipoEntrada[], actor: AuthUser) {
    const filas = miembros.map((m) => ({
      usuarioId: m.usuarioId ?? null,
      nombreExterno: m.usuarioId ? null : texto(m.nombreExterno),
    }));
    if (filas.some((f) => !f.usuarioId && !f.nombreExterno))
      throw new BadRequestException('Cada miembro del equipo es una cuenta del portal o un nombre');
    const llaves = filas.map((f) => f.usuarioId ?? `ext:${f.nombreExterno?.toLowerCase()}`);
    if (new Set(llaves).size !== llaves.length)
      throw new BadRequestException('Hay miembros repetidos en el equipo investigador');
    await this.editar(id, async (tx) => {
      const cuentas = filas.flatMap((f) => (f.usuarioId ? [f.usuarioId] : []));
      if ((await tx.idUsuario.count({ where: { id: { in: cuentas } } })) !== cuentas.length)
        throw new BadRequestException('Una de las cuentas del equipo no existe');
      await tx.investigacionEquipo.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionEquipo.createMany({
        data: filas.map((f) => ({ id: uuidv7(), investigacionId: id, ...f, createdBy: actor.id })),
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarTestigos(id: string, testigos: TestigoEntrada[], actor: AuthUser) {
    if (testigos.length > MAX_TESTIGOS)
      throw new BadRequestException(`El formato admite hasta ${MAX_TESTIGOS} testigos`);
    const filas = testigos.map((t, i) => ({
      orden: i + 1,
      nombresApellidos: texto(t.nombresApellidos),
      cedula: texto(t.cedula),
      version: texto(t.version),
    }));
    if (filas.some((f) => !f.nombresApellidos || !f.version))
      throw new BadRequestException('Cada testigo lleva su nombre y su versión de lo ocurrido');
    await this.editar(id, async (tx) => {
      await tx.investigacionTestigo.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionTestigo.createMany({
        data: filas.map((f) => ({
          id: uuidv7(),
          investigacionId: id,
          orden: f.orden,
          nombresApellidos: f.nombresApellidos as string,
          cedula: f.cedula,
          version: f.version as string,
          createdBy: actor.id,
        })),
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarEntorno(id: string, factores: FactorEntornoEntrada[], actor: AuthUser) {
    const filas = factores.map((f, i) => ({
      orden: i + 1,
      tipo: texto(f.tipo),
      fuente: texto(f.fuente),
      existeControl: f.existeControl,
      contribuyoAlSuceso: f.contribuyoAlSuceso,
    }));
    if (filas.some((f) => !f.tipo || !f.fuente))
      throw new BadRequestException('Cada factor del entorno lleva su tipo y su fuente');
    await this.editar(id, async (tx) => {
      await tx.investigacionEntornoFactor.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionEntornoFactor.createMany({
        data: filas.map((f) => ({
          id: uuidv7(),
          investigacionId: id,
          orden: f.orden,
          tipo: f.tipo as string,
          fuente: f.fuente as string,
          existeControl: f.existeControl,
          contribuyoAlSuceso: f.contribuyoAlSuceso,
          createdBy: actor.id,
        })),
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarEvidencias(
    id: string,
    e: { evidenciasRecopiladas?: string | null; testimoniosResumen?: string | null },
    actor: AuthUser,
  ) {
    await this.editar(id, async (tx) => {
      await tx.investigacion.update({
        where: { id },
        data: {
          evidenciasRecopiladas: texto(e.evidenciasRecopiladas),
          testimoniosResumen: texto(e.testimoniosResumen),
          updatedBy: actor.id,
        },
      });
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  /** Corre el cambio en una transacción, solo si la investigación existe y todavía se puede editar. */
  private async editar(
    id: string,
    cambio: (tx: Tx, involucraLesionado: boolean) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const i = await tx.investigacion.findUnique({
        where: { id },
        select: { estado: true, resultado: { select: { involucraLesionado: true } } },
      });
      if (!i) throw new NotFoundException('La investigación no existe');
      if (
        i.estado !== EstadoInvestigacion.abierta &&
        i.estado !== EstadoInvestigacion.en_investigacion
      )
        throw new ConflictException('La investigación ya no admite cambios');
      await cambio(tx, i.resultado.involucraLesionado);
    });
  }
}
