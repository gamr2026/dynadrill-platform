import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { AccionJornada, EstadoJornada, Prisma } from '../generated/client';
import { JREQ } from '../catalog/requisitos-jornada';
import { PrismaService } from '../prisma/prisma.service';

const PASO = 'ejecucion_operativa';
/** Un servicio no dura más de un año: protege contra fechas mal escritas que crearían miles de filas. */
const MAX_JORNADAS = 366;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de las bases (Ecuador), no en la del servidor. */
export const hoyEnGuayaquil = (ahora: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(ahora);

/** Todas las fechas (AAAA-MM-DD) entre dos fechas, inclusive. */
export function diasEntre(inicio: string, fin: string): string[] {
  const dias: string[] = [];
  const hasta = Date.parse(`${fin}T00:00:00Z`);
  for (let t = Date.parse(`${inicio}T00:00:00Z`); t <= hasta; t += 86_400_000) {
    dias.push(new Date(t).toISOString().slice(0, 10));
  }
  return dias;
}

const aFecha = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Lo que ve la pantalla: el estado guardado más lo que se deduce de la fecha de hoy y de los requisitos. «hoy», «bloqueada»,
 * «con_pendientes» y «pendiente» no se guardan (una jornada que nadie toca no cambia de estado sola).
 */
export type EstadoVisibleJornada =
  | 'pendiente'
  | 'hoy'
  | 'bloqueada'
  | 'abierta'
  | 'con_pendientes'
  | 'cerrada'
  | 'sin_operacion'
  | 'no_aplica';

/**
 * `bloqueada`: el día de hoy no se puede abrir porque falta un requisito de OTRA área (PTW, PT o ART de QHSE…). Lo que falta de Pumping
 * (la aceptación del Company Man, por ejemplo) no la bloquea: es la tarea del día.
 */
export function estadoVisible(
  estado: EstadoJornada,
  fecha: string,
  hoy: string,
  bloqueada = false,
): EstadoVisibleJornada {
  if (estado === 'no_aplica' || estado === 'sin_operacion' || estado === 'cerrada') return estado;
  if (fecha < hoy) return 'con_pendientes';
  if (fecha > hoy) return 'pendiente';
  if (estado === 'abierta') return 'abierta';
  return bloqueada ? 'bloqueada' : 'hoy';
}

/**
 * Jornadas de un ticket de Pumping: un día de operación con su aceptación del Company Man, el día sin operación, el cierre y la reapertura,
 * y sus requisitos por día (los de `apertura` bloquean abrir el día; los de `cierre`, cerrarlo). Ver documentacion/modulos/DISENO-JORNADA-BACKEND.md.
 * Etapas hechas: 1 (núcleo) y 2 (requisitos por día). Todavía no bloquea la salida de Ejecución operativa (etapa 4).
 */
@Injectable()
export class JornadasService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hoy en Ecuador. Aparte para que las pruebas puedan fijar el día. */
  protected hoy(): string {
    return hoyEnGuayaquil();
  }

  /**
   * Crea (sin duplicar) una jornada por cada día del rango del servicio y marca «no aplica» las que quedaron fuera del rango (si el servicio se
   * acortó o las fechas cambiaron). Una jornada con trabajo registrado (cerrada o sin operación) no se toca.
   */
  async generar(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (!t.fechaInicioServicio || !t.fechaFinServicio) return;
    const dias = diasEntre(aFecha(t.fechaInicioServicio), aFecha(t.fechaFinServicio));
    if (dias.length > MAX_JORNADAS) {
      throw new ConflictException(
        `El servicio dura más de ${MAX_JORNADAS} días: revise las fechas del pedido`,
      );
    }
    const existentes = await tx.ticketJornada.findMany({
      where: { ticketId },
      select: { id: true, fecha: true, numero: true, estado: true },
    });
    const porFecha = new Map(existentes.map((j) => [aFecha(j.fecha), j]));

    const nuevas = dias
      .map((fecha, i) => ({ fecha, numero: i + 1 }))
      .filter((d) => !porFecha.has(d.fecha))
      .map((d) => ({
        id: uuidv7(),
        ticketId,
        fecha: new Date(`${d.fecha}T00:00:00Z`),
        numero: d.numero,
      }));
    if (nuevas.length) await tx.ticketJornada.createMany({ data: nuevas, skipDuplicates: true });

    // una jornada que vuelve a entrar al rango (se amplió de nuevo) deja de ser «no aplica»; las que salen, pasan a serlo
    const enRango = new Set(dias);
    for (const j of existentes) {
      const f = aFecha(j.fecha);
      if (enRango.has(f)) {
        const numero = dias.indexOf(f) + 1;
        const vuelve = j.estado === 'no_aplica';
        if (vuelve || j.numero !== numero) {
          await tx.ticketJornada.update({
            where: { id: j.id },
            data: { numero, ...(vuelve ? { estado: 'pendiente' as const } : {}) },
          });
        }
      } else if (j.estado === 'pendiente' || j.estado === 'abierta') {
        await tx.ticketJornada.update({ where: { id: j.id }, data: { estado: 'no_aplica' } });
      }
    }
    await this.sincronizar(tx, ticketId);
  }

  /**
   * Deja al día los requisitos de cada jornada: crea los que faltan (uno por día activo y por requisito activo del catálogo), cumple o reabre
   * los que Pumping sabe deducir de sus propios datos (aceptación del Company Man, job log completado, herramientas marcadas ese día), quita los
   * pendientes de los días sin operación o que no aplican, y abre la jornada cuando se cumple el último requisito de apertura. Se puede llamar
   * las veces que haga falta: solo escribe lo que cambió. `actorId`: quién provocó el cambio (vacío = el sistema), para la bitácora.
   */
  async sincronizar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actorId: string | null = null,
  ): Promise<void> {
    const jornadas = await tx.ticketJornada.findMany({ where: { ticketId } });
    if (jornadas.length === 0) return;
    const definiciones = await tx.requisito.findMany({
      where: { ambito: 'jornada', activo: true },
      select: { codigo: true, momento: true },
    });
    const filas = await tx.ticketRequisito.findMany({
      where: { ticketId, fecha: { not: null } },
      select: { id: true, requisitoCodigo: true, fecha: true, estado: true },
    });
    const conJobLog = new Set(
      (
        await tx.reporteDiario.findMany({
          where: { ticketId, completadoAt: { not: null } },
          select: { fecha: true },
        })
      ).map((r) => aFecha(r.fecha)),
    );
    const conHerramientas = new Set(
      (
        await tx.reporteItemDia.findMany({
          where: { linea: { ticketId } },
          select: { fecha: true },
          distinct: ['fecha'],
        })
      ).map((r) => aFecha(r.fecha)),
    );
    /** Lo que dicen los datos de Pumping de ese requisito ese día; `undefined` si lo cumple otra área o una etapa posterior. */
    const verdad = (
      codigo: string,
      j: (typeof jornadas)[number],
      fecha: string,
    ): boolean | undefined => {
      if (codigo === JREQ.companyMan) return j.companyManAceptoAt !== null;
      if (codigo === JREQ.jobLog) return conJobLog.has(fecha);
      if (codigo === JREQ.herramientas) return conHerramientas.has(fecha);
      return undefined;
    };

    const clave = (codigo: string, fecha: string) => `${codigo}|${fecha}`;
    const estadoDe = new Map(
      filas.map((f) => [clave(f.requisitoCodigo, aFecha(f.fecha as Date)), f] as const),
    );
    const nuevas: Prisma.TicketRequisitoCreateManyInput[] = [];
    const ahora = new Date();
    const cumplido = { estado: 'cumplido' as const, cumplidoAt: ahora, origen: 'sistema' as const };
    const pendiente = {
      estado: 'pendiente' as const,
      cumplidoAt: null,
      cumplidoPor: null,
      origen: null,
    };
    const quien = (codigo: string, j: (typeof jornadas)[number]) =>
      codigo === JREQ.companyMan ? j.companyManAceptoPor : actorId;

    for (const j of jornadas) {
      const fecha = aFecha(j.fecha);
      // un día que no se opera no exige nada: no se le crean requisitos y los que tenía no cuentan (la aplicación no borra requisitos)
      if (j.estado === 'no_aplica' || j.estado === 'sin_operacion') continue;
      for (const d of definiciones) {
        const v = verdad(d.codigo, j, fecha);
        const fila = estadoDe.get(clave(d.codigo, fecha));
        if (!fila) {
          nuevas.push({
            id: uuidv7(),
            ticketId,
            requisitoCodigo: d.codigo,
            fecha: j.fecha,
            ...(v ? { ...cumplido, cumplidoPor: quien(d.codigo, j) } : { estado: 'pendiente' }),
          });
        } else if (v !== undefined && (fila.estado === 'cumplido') !== v) {
          await tx.ticketRequisito.update({
            where: { id: fila.id },
            data: v ? { ...cumplido, cumplidoPor: quien(d.codigo, j) } : pendiente,
          });
          estadoDe.set(clave(d.codigo, fecha), { ...fila, estado: v ? 'cumplido' : 'pendiente' });
        }
      }
    }
    if (nuevas.length) await tx.ticketRequisito.createMany({ data: nuevas, skipDuplicates: true });
    for (const n of nuevas) {
      estadoDe.set(clave(n.requisitoCodigo, aFecha(n.fecha as Date)), {
        id: n.id as string,
        requisitoCodigo: n.requisitoCodigo,
        fecha: n.fecha as Date,
        estado: n.estado ?? 'pendiente',
      });
    }

    // abre la jornada cuando ya se cumplieron todos sus requisitos de apertura (el último puede ser de otra área)
    const deApertura = definiciones.filter((d) => d.momento === 'apertura');
    for (const j of jornadas) {
      if (j.estado !== 'pendiente' || deApertura.length === 0) continue;
      const fecha = aFecha(j.fecha);
      const todos = deApertura.every(
        (d) => estadoDe.get(clave(d.codigo, fecha))?.estado === 'cumplido',
      );
      if (!todos) continue;
      await tx.ticketJornada.update({ where: { id: j.id }, data: { estado: 'abierta' } });
      await this.anotar(tx, j.id, 'abierta', null, actorId);
    }
  }

  /** Requisitos de cierre que todavía faltan en la jornada de un día. */
  private async pendientesDeCierre(tx: Prisma.TransactionClient, ticketId: string, fecha: string) {
    const filas = await tx.ticketRequisito.findMany({
      where: {
        ticketId,
        fecha: new Date(`${fecha}T00:00:00Z`),
        estado: 'pendiente',
        requisito: { momento: 'cierre' },
      },
      include: { requisito: { select: { nombre: true } } },
      orderBy: { requisitoCodigo: 'asc' },
    });
    return filas.map((f) => ({ codigo: f.requisitoCodigo, nombre: f.requisito.nombre }));
  }

  /** Las jornadas del ticket con su estado de hoy. Al pedirlas en la Ejecución operativa se crean las que falten. */
  async listar(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        paso: { select: { orden: true } },
        fechaInicioServicio: true,
        fechaFinServicio: true,
      },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const ejecucion = await this.prisma.paso.findUnique({
      where: { codigo: PASO },
      select: { orden: true },
    });
    // antes de la Ejecución operativa todavía no hay jornadas: el servicio no ha empezado
    if (ejecucion && t.paso.orden >= ejecucion.orden) {
      await this.prisma.$transaction((tx) => this.generar(tx, ticketId));
    }
    const hoy = this.hoy();
    const filas = await this.prisma.ticketJornada.findMany({
      where: { ticketId },
      orderBy: { fecha: 'asc' },
      include: { sinOperacionMotivo: { select: { codigo: true, nombre: true } } },
    });
    const requisitos = await this.prisma.ticketRequisito.findMany({
      where: { ticketId, fecha: { not: null } },
      include: {
        requisito: { select: { nombre: true, descripcion: true, modulo: true, momento: true } },
      },
      orderBy: { requisitoCodigo: 'asc' },
    });
    const deFecha = new Map<string, typeof requisitos>();
    for (const r of requisitos) {
      const f = aFecha(r.fecha as Date);
      deFecha.set(f, [...(deFecha.get(f) ?? []), r]);
    }
    const activas = filas.filter((j) => j.estado !== 'no_aplica');
    const jornadas = filas.map((j) => {
      const fecha = aFecha(j.fecha);
      // un día sin operación o que ya no aplica no exige nada: no se muestran los requisitos que alguna vez tuvo
      const exige = j.estado !== 'no_aplica' && j.estado !== 'sin_operacion';
      const reqs = (exige ? (deFecha.get(fecha) ?? []) : [])
        .map((r) => ({
          codigo: r.requisitoCodigo,
          nombre: r.requisito.nombre,
          descripcion: r.requisito.descripcion,
          momento: r.requisito.momento as 'apertura' | 'cierre',
          /** Área responsable de cumplirlo: `pumping`, `qhse` o `flota`. */
          modulo: r.requisito.modulo,
          estado: r.estado,
          cumplidoAt: r.cumplidoAt,
        }))
        .sort((a, b) => (a.momento === b.momento ? 0 : a.momento === 'apertura' ? -1 : 1));
      const faltan = reqs.filter((r) => r.estado === 'pendiente');
      // lo que falta de otra área bloquea el día; lo de Pumping es la tarea del día
      const bloqueos = faltan
        .filter((r) => r.momento === 'apertura' && r.modulo !== 'pumping')
        .map((r) => ({ codigo: r.codigo, nombre: r.nombre, responsable: r.modulo }));
      return {
        id: j.id,
        fecha,
        numero: j.numero,
        estado: j.estado,
        estadoVisible: estadoVisible(j.estado, fecha, hoy, bloqueos.length > 0),
        esHoy: fecha === hoy,
        requisitos: reqs,
        pendientes: {
          apertura: faltan.filter((r) => r.momento === 'apertura').length,
          cierre: faltan.filter((r) => r.momento === 'cierre').length,
        },
        bloqueos,
        companyManAcepto: j.companyManAceptoAt !== null,
        companyManAceptoAt: j.companyManAceptoAt,
        companyManAceptoPor: j.companyManAceptoPor,
        sinOperacion: j.sinOperacionMotivo
          ? {
              motivo: j.sinOperacionMotivo,
              detalle: j.sinOperacionDetalle,
              registradoAt: j.sinOperacionAt,
              registradoPor: j.sinOperacionPor,
            }
          : null,
        cerradaAt: j.cerradaAt,
        cerradaPor: j.cerradaPor,
      };
    });
    const hoyActiva = activas.find((j) => aFecha(j.fecha) === hoy);
    // lo que falta hoy, por área responsable (para el aviso «pendiente de QHSE / de Flota» dentro del ticket)
    const pendientesPorArea: Record<string, number> = {};
    for (const r of deFecha.get(hoy) ?? []) {
      if (r.estado === 'pendiente' && hoyActiva && hoyActiva.estado !== 'sin_operacion') {
        pendientesPorArea[r.requisito.modulo] = (pendientesPorArea[r.requisito.modulo] ?? 0) + 1;
      }
    }
    return {
      ticketId,
      hoy,
      fechaInicio: t.fechaInicioServicio ? aFecha(t.fechaInicioServicio) : null,
      fechaFin: t.fechaFinServicio ? aFecha(t.fechaFinServicio) : null,
      /** Jornadas que cuentan (sin las «no aplica»). */
      total: activas.length,
      /** Día N de M de hoy; `null` si hoy no es día de servicio. */
      diaActual: hoyActiva?.numero ?? null,
      cerradas: activas.filter((j) => j.estado === 'cerrada').length,
      sinOperacion: activas.filter((j) => j.estado === 'sin_operacion').length,
      pendientesPorArea,
      jornadas,
    };
  }

  /** Motivos disponibles para registrar un día sin operación. */
  motivosSinOperacion() {
    return this.prisma.motivoSinOperacion.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, codigo: true, nombre: true },
    });
  }

  /** El Supervisor asignado marca que el Company Man aceptó trabajar hoy. La jornada queda abierta cuando además se cumplen los demás requisitos de apertura. */
  async aceptarCompanyMan(ticketId: string, fecha: string, actor: AuthUser) {
    return this.enJornada(ticketId, fecha, async (tx, j, t) => {
      this.exigirSupervisorAsignado(t.personas, actor);
      this.exigirEstado(
        j.estado,
        ['pendiente', 'abierta'],
        'La aceptación del Company Man se marca en una jornada pendiente o abierta',
      );
      if (fecha !== this.hoy()) {
        throw new ConflictException(
          'La aceptación del Company Man se marca el mismo día de la jornada',
        );
      }
      if (j.companyManAceptoAt)
        return { ok: true, yaMarcada: true, abierta: j.estado === 'abierta' };
      await tx.ticketJornada.update({
        where: { id: j.id },
        data: { companyManAceptoAt: new Date(), companyManAceptoPor: actor.id },
      });
      // cumple el requisito de apertura y, si era el último, abre la jornada
      await this.sincronizar(tx, ticketId, actor.id);
      const despues = await tx.ticketJornada.findUniqueOrThrow({
        where: { id: j.id },
        select: { estado: true },
      });
      return { ok: true, yaMarcada: false, abierta: despues.estado === 'abierta' };
    });
  }

  /** Registra un día sin operación (lluvia, espera de cliente…): no exige PTW, checklist ni job log; cuenta como día transcurrido. */
  async sinOperacion(
    ticketId: string,
    fecha: string,
    motivoId: string,
    detalle: string,
    actor: AuthUser,
  ) {
    const texto = detalle.trim();
    if (texto.length < 3)
      throw new BadRequestException('Escriba el detalle de lo ocurrido (mínimo 3 caracteres)');
    return this.enJornada(ticketId, fecha, async (tx, j, t) => {
      this.exigirParticipante(t.personas, actor);
      this.exigirEstado(
        j.estado,
        ['pendiente', 'abierta'],
        'Solo una jornada pendiente o abierta se registra sin operación',
      );
      if (fecha > this.hoy()) {
        throw new ConflictException(
          'No se puede registrar sin operación un día que todavía no llega',
        );
      }
      const motivo = await tx.motivoSinOperacion.findFirst({
        where: { id: motivoId, activo: true },
        select: { id: true },
      });
      if (!motivo) throw new BadRequestException('El motivo no existe o está inactivo');
      await tx.ticketJornada.update({
        where: { id: j.id },
        data: {
          estado: 'sin_operacion',
          sinOperacionMotivoId: motivo.id,
          sinOperacionDetalle: texto,
          sinOperacionAt: new Date(),
          sinOperacionPor: actor.id,
        },
      });
      await this.anotar(tx, j.id, 'sin_operacion', texto, actor.id);
      await this.sincronizar(tx, ticketId, actor.id);
      return { ok: true };
    });
  }

  /** El Supervisor cierra la jornada de hoy (o de un día pasado). Un día futuro no se cierra. */
  async cerrar(ticketId: string, fecha: string, actor: AuthUser) {
    return this.enJornada(ticketId, fecha, async (tx, j, t) => {
      this.exigirSupervisorAsignado(t.personas, actor);
      if (fecha > this.hoy()) {
        throw new ConflictException('No se puede cerrar una jornada que todavía no llega');
      }
      this.exigirEstado(
        j.estado,
        ['abierta'],
        'Solo una jornada abierta se puede cerrar (falta la aceptación del Company Man)',
      );
      const faltan = await this.pendientesDeCierre(tx, ticketId, fecha);
      if (faltan.length) {
        throw new ConflictException({
          message: `No se puede cerrar la jornada. Falta: ${faltan.map((f) => f.nombre).join('; ')}.`,
          code: 'REQUISITOS_PENDIENTES',
          pendientes: faltan,
        });
      }
      await tx.ticketJornada.update({
        where: { id: j.id },
        data: { estado: 'cerrada', cerradaAt: new Date(), cerradaPor: actor.id },
      });
      await this.anotar(tx, j.id, 'cerrada', null, actor.id);
      return { ok: true };
    });
  }

  /** Reabre una jornada cerrada o sin operación, con motivo. Vuelve a «abierta» si ya tenía la aceptación del Company Man, si no a «pendiente». */
  async reabrir(ticketId: string, fecha: string, motivo: string, actor: AuthUser) {
    const texto = motivo.trim();
    if (texto.length < 3)
      throw new BadRequestException('Escriba el motivo de la reapertura (mínimo 3 caracteres)');
    return this.enJornada(ticketId, fecha, async (tx, j) => {
      this.exigirEstado(
        j.estado,
        ['cerrada', 'sin_operacion'],
        'Solo una jornada cerrada o sin operación se puede reabrir',
      );
      await tx.ticketJornada.update({
        where: { id: j.id },
        data: {
          estado: j.companyManAceptoAt ? 'abierta' : 'pendiente',
          cerradaAt: null,
          cerradaPor: null,
          sinOperacionMotivoId: null,
          sinOperacionDetalle: null,
          sinOperacionAt: null,
          sinOperacionPor: null,
        },
      });
      await this.anotar(tx, j.id, 'reabierta', texto, actor.id);
      await this.sincronizar(tx, ticketId, actor.id); // el día vuelve a exigir sus requisitos
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Carga la jornada de un día del ticket (en Ejecución operativa) y corre la acción dentro de una transacción. */
  private async enJornada<R>(
    ticketId: string,
    fecha: string,
    accion: (
      tx: Prisma.TransactionClient,
      jornada: NonNullable<
        Awaited<ReturnType<Prisma.TransactionClient['ticketJornada']['findUnique']>>
      >,
      ticket: { personas: { usuarioId: string; rol: string }[] },
    ) => Promise<R>,
  ): Promise<R> {
    // además del formato, que exista en el calendario (31 de febrero no): la fecha vuelve igual al pasar por Date
    const valida =
      FECHA.test(fecha) &&
      !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) &&
      new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) === fecha;
    if (!valida) throw new BadRequestException('La fecha debe tener el formato AAAA-MM-DD');
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { pasoCodigo: true, personas: { select: { usuarioId: true, rol: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO) {
        throw new ConflictException('Las jornadas se gestionan en el paso de Ejecución operativa');
      }
      await this.generar(tx, ticketId);
      const j = await tx.ticketJornada.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: new Date(`${fecha}T00:00:00Z`) } },
      });
      if (!j) throw new NotFoundException('Ese día no está dentro del rango del servicio');
      if (j.estado === 'no_aplica')
        throw new ConflictException('Esa jornada ya no aplica: quedó fuera del rango del servicio');
      return accion(tx, j, t);
    });
  }

  private exigirSupervisorAsignado(
    personas: { usuarioId: string; rol: string }[],
    actor: AuthUser,
  ) {
    if (actor.roleCode === 'superadmin') return;
    if (!personas.some((p) => p.rol === 'supervisor' && p.usuarioId === actor.id)) {
      throw new ForbiddenException('Solo el Supervisor asignado a este ticket puede hacerlo');
    }
  }

  /** Quien opera el servicio: el Supervisor o un Operador asignados al ticket. */
  private exigirParticipante(personas: { usuarioId: string; rol: string }[], actor: AuthUser) {
    if (actor.roleCode === 'superadmin') return;
    if (
      !personas.some(
        (p) => (p.rol === 'supervisor' || p.rol === 'operador') && p.usuarioId === actor.id,
      )
    ) {
      throw new ForbiddenException(
        'Solo el Supervisor o los Operadores asignados a este ticket pueden hacerlo',
      );
    }
  }

  private exigirEstado(actual: EstadoJornada, permitidos: EstadoJornada[], mensaje: string) {
    if (!permitidos.includes(actual)) throw new ConflictException(mensaje);
  }

  private anotar(
    tx: Prisma.TransactionClient,
    jornadaId: string,
    accion: AccionJornada,
    motivo: string | null,
    actorId: string | null,
  ) {
    return tx.ticketJornadaHistorial.create({
      data: { id: uuidv7(), jornadaId, accion, motivo, actorId },
    });
  }
}
