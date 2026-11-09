import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { AccionJornada, EstadoJornada, Prisma } from '../generated/client';
import { JREQ } from '../catalog/requisitos-jornada';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';

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
/** «09/11». */
const diaCorto = (f: Date): string => `${aFecha(f).slice(8, 10)}/${aFecha(f).slice(5, 7)}`;

/** AAAA-MM-DD que además existe en el calendario (el 31 de febrero no): la fecha vuelve igual al pasar por Date. */
export const fechaValida = (fecha: string): boolean =>
  FECHA.test(fecha) &&
  !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) &&
  new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) === fecha;

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
/** Una unidad y un día trabajado en la Revisión de reportes de llegada. */
export interface FilaRevisionLlegada {
  unidadId: string;
  unidad: string;
  fecha: string;
  numero: number;
  inspeccion: 'pendiente' | 'por_aprobar' | 'aprobada';
  reporte: 'sin_firmar' | 'por_revisar' | 'aprobado' | 'rechazado';
  motivo: string | null;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Hoy en Ecuador. Aparte (y público) para que todo lo que depende de «hoy» use el mismo reloj y las pruebas puedan fijar el día. */
  hoy(): string {
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
    let cambio = nuevas.length > 0;
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
          if (vuelve) cambio = true;
        }
      } else if (j.estado === 'pendiente' || j.estado === 'abierta') {
        await tx.ticketJornada.update({ where: { id: j.id }, data: { estado: 'no_aplica' } });
        cambio = true;
      }
    }
    await this.sincronizar(tx, ticketId);
    if (cambio) await this.publicarDias(tx, ticketId);
  }

  /**
   * Avisa a QHSE qué días tiene activos el ticket (pendientes, abiertos o cerrados; no los «sin operación» ni los que no aplican): con eso QHSE abre
   * el PTW de cada día. Cada aviso trae la lista completa y reemplaza a la anterior. Se publica cuando cambia el conjunto de días.
   */
  private async publicarDias(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { ticketNumero: true, pedidoId: true, pedidoCodigo: true },
    });
    if (!t) return;
    const dias = await tx.ticketJornada.findMany({
      where: { ticketId, estado: { in: ['pendiente', 'abierta', 'cerrada'] } },
      orderBy: { fecha: 'asc' },
      select: { fecha: true },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.dias_de_servicio_actualizados',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: {
          ticketId,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          dias: dias.map((d) => aFecha(d.fecha)),
        },
        traceparent: currentTraceparent(),
      }),
    );
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
      select: { codigo: true, momento: true, modulo: true, nombre: true, porUnidad: true },
    });
    const filas = await tx.ticketRequisito.findMany({
      where: { ticketId, fecha: { not: null } },
      select: { id: true, requisitoCodigo: true, fecha: true, estado: true, unidadId: true },
    });
    // los traslados de cada día: una fila por cada unidad de transporte del ticket
    const unidades = (
      await tx.ticketUnidad.findMany({ where: { ticketId }, select: { unidadId: true } })
    ).map((u) => u.unidadId);
    const reportes = await tx.reporteUnidad.findMany({
      where: { ticketId },
      select: { unidadId: true, fecha: true, salidaFirmadaAt: true, llegadaFirmadaAt: true },
    });
    const salidaFirmada = new Set(
      reportes.filter((x) => x.salidaFirmadaAt).map((x) => `${x.unidadId}|${aFecha(x.fecha)}`),
    );
    const llegadaFirmada = new Set(
      reportes.filter((x) => x.llegadaFirmadaAt).map((x) => `${x.unidadId}|${aFecha(x.fecha)}`),
    );
    // lo que Flota hizo por unidad y día (llega por eventos)
    const hechosTraslado = new Set(
      (await tx.ticketHechoTraslado.findMany({ where: { ticketId, vigente: true } })).map(
        (h) => `${h.tipo}|${h.unidadId}|${aFecha(h.fecha)}`,
      ),
    );
    // la SWA es del servicio: si hay una activa, ningún día se abre (el requisito del ticket nace cumplido y la SWA lo reabre)
    const swa = await tx.ticketRequisito.findFirst({
      where: {
        ticketId,
        requisitoCodigo: REQ.swaSinActivar,
        unidadId: null,
        usuarioId: null,
        fecha: null,
      },
      select: { estado: true },
    });
    const sinSwa = !swa || swa.estado === 'cumplido';
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
    const conChecklist = new Set(
      (
        await tx.ticketIngreso.findMany({
          where: { ticketId, confirmadoAt: { not: null } },
          select: { fecha: true },
        })
      ).map((r) => aFecha(r.fecha)),
    );
    // lo que QHSE hizo por día (llega por eventos): un día lo cumple si algún hecho vigente del tipo lo cubre
    const hechos = await tx.ticketHechoQhse.findMany({
      where: { ticketId, vigente: true },
      select: { tipo: true, desde: true, hasta: true },
    });
    const cubre = (tipo: 'ptw_aprobado' | 'pt' | 'art', fecha: string) =>
      hechos.some((h) => h.tipo === tipo && aFecha(h.desde) <= fecha && fecha <= aFecha(h.hasta));
    /** Lo que dicen los datos del ticket de ese requisito ese día; `undefined` si no hay forma de deducirlo. */
    const verdad = (
      codigo: string,
      j: (typeof jornadas)[number],
      fecha: string,
      unidadId: string | null,
    ): boolean | undefined => {
      if (codigo === JREQ.companyMan) return j.companyManAceptoAt !== null;
      if (codigo === JREQ.checklist) return conChecklist.has(fecha);
      if (codigo === JREQ.jobLog) return conJobLog.has(fecha);
      if (codigo === JREQ.herramientas) return conHerramientas.has(fecha);
      if (codigo === JREQ.ptw) return cubre('ptw_aprobado', fecha);
      if (codigo === JREQ.pt) return cubre('pt', fecha);
      if (codigo === JREQ.art) return cubre('art', fecha);
      if (codigo === JREQ.sinSwa) return sinSwa;
      if (codigo === JREQ.reporteSalida) return salidaFirmada.has(`${unidadId}|${fecha}`);
      if (codigo === JREQ.reporteLlegada) return llegadaFirmada.has(`${unidadId}|${fecha}`);
      const delTraslado = (tipo: string) => hechosTraslado.has(`${tipo}|${unidadId}|${fecha}`);
      if (codigo === JREQ.inspeccionRealizada) return delTraslado('inspeccion_realizada');
      if (codigo === JREQ.inspeccionAprobada) return delTraslado('inspeccion_aprobada');
      if (codigo === JREQ.gerenciamientoSalida) return delTraslado('gerenciamiento_salida');
      if (codigo === JREQ.gerenciamientoRetorno) return delTraslado('gerenciamiento_retorno');
      return undefined;
    };

    const clave = (codigo: string, fecha: string, unidadId: string | null = null) =>
      `${codigo}|${fecha}|${unidadId ?? ''}`;
    const estadoDe = new Map(
      filas.map((f) => [clave(f.requisitoCodigo, aFecha(f.fecha as Date), f.unidadId), f] as const),
    );
    /** A quién corresponde cada requisito: a cada unidad si es «por unidad», si no, al servicio. */
    const destinos = (d: { porUnidad: boolean }): Array<string | null> =>
      d.porUnidad ? unidades : [null];
    const nuevas: Prisma.TicketRequisitoCreateManyInput[] = [];
    const ahora = new Date();
    const cumplido = (modulo: string) => ({
      estado: 'cumplido' as const,
      cumplidoAt: ahora,
      origen: modulo === 'pumping' ? ('sistema' as const) : ('evento' as const),
    });
    const pendiente = {
      estado: 'pendiente' as const,
      cumplidoAt: null,
      cumplidoPor: null,
      origen: null,
    };
    // lo que cumple otra área (PTW, PT, ART) no tiene persona de Pumping
    const deQhse: string[] = [JREQ.ptw, JREQ.pt, JREQ.art];
    const quien = (codigo: string, j: (typeof jornadas)[number]) =>
      codigo === JREQ.companyMan ? j.companyManAceptoPor : deQhse.includes(codigo) ? null : actorId;

    for (const j of jornadas) {
      const fecha = aFecha(j.fecha);
      // un día que no se opera no exige nada: no se le crean requisitos y los que tenía no cuentan (la aplicación no borra requisitos)
      if (j.estado === 'no_aplica' || j.estado === 'sin_operacion') continue;
      for (const d of definiciones) {
        for (const unidadId of destinos(d)) {
          const v = verdad(d.codigo, j, fecha, unidadId);
          const fila = estadoDe.get(clave(d.codigo, fecha, unidadId));
          if (!fila) {
            nuevas.push({
              id: uuidv7(),
              ticketId,
              requisitoCodigo: d.codigo,
              fecha: j.fecha,
              unidadId,
              ...(v
                ? { ...cumplido(d.modulo), cumplidoPor: quien(d.codigo, j) }
                : { estado: 'pendiente' }),
            });
          } else if (v !== undefined && (fila.estado === 'cumplido') !== v) {
            await tx.ticketRequisito.update({
              where: { id: fila.id },
              data: v ? { ...cumplido(d.modulo), cumplidoPor: quien(d.codigo, j) } : pendiente,
            });
            estadoDe.set(clave(d.codigo, fecha, unidadId), {
              ...fila,
              estado: v ? 'cumplido' : 'pendiente',
            });
          }
        }
      }
    }
    if (nuevas.length) await tx.ticketRequisito.createMany({ data: nuevas, skipDuplicates: true });
    for (const n of nuevas) {
      estadoDe.set(clave(n.requisitoCodigo, aFecha(n.fecha as Date), n.unidadId ?? null), {
        id: n.id as string,
        requisitoCodigo: n.requisitoCodigo,
        fecha: n.fecha as Date,
        unidadId: n.unidadId ?? null,
        estado: n.estado ?? 'pendiente',
      });
    }

    // abre la jornada cuando ya se cumplieron todos sus requisitos de apertura (el último puede ser de otra área); y si una jornada abierta deja
    // de cumplir alguno (el PTW se anuló, el ART venció, se desmarcó el LOTO), vuelve a pendiente: no se opera sin sus requisitos. Una jornada
    // cerrada no se toca.
    const deApertura = definiciones.filter((d) => d.momento === 'apertura');
    for (const j of jornadas) {
      if ((j.estado !== 'pendiente' && j.estado !== 'abierta') || deApertura.length === 0) continue;
      const fecha = aFecha(j.fecha);
      const faltan = deApertura.filter((d) =>
        destinos(d).some((u) => estadoDe.get(clave(d.codigo, fecha, u))?.estado !== 'cumplido'),
      );
      if (j.estado === 'pendiente' && faltan.length === 0) {
        await tx.ticketJornada.update({ where: { id: j.id }, data: { estado: 'abierta' } });
        await this.anotar(tx, j.id, 'abierta', null, actorId);
      } else if (j.estado === 'abierta' && faltan.length > 0) {
        await tx.ticketJornada.update({ where: { id: j.id }, data: { estado: 'pendiente' } });
        await this.anotar(
          tx,
          j.id,
          'reabierta',
          `Dejó de cumplirse: ${faltan.map((d) => d.nombre).join('; ')}`,
          actorId,
        );
      }
    }
  }

  /**
   * Para salir de la Ejecución operativa (cada día del servicio recorre el ciclo completo hasta la revisión final): todas las jornadas **hasta
   * hoy** deben estar cerradas, sin operación o no aplicar, y al menos una debe tener su trabajo registrado. Los días que aún no llegan no se
   * exigen: su ciclo empieza cuando llegue su día, y el ticket solo se cierra cuando todos los días estén resueltos.
   */
  async exigirResueltas(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    await this.generar(tx, ticketId);
    const hoy = this.hoy();
    const filas = await tx.ticketJornada.findMany({
      where: { ticketId, estado: { not: 'no_aplica' } },
      orderBy: { fecha: 'asc' },
      select: { numero: true, fecha: true, estado: true },
    });
    const abierta = (f: (typeof filas)[number]) =>
      f.estado === 'pendiente' || f.estado === 'abierta';
    const vencidas = filas.filter((f) => abierta(f) && aFecha(f.fecha) <= hoy);
    if (vencidas.length > 0) {
      throw new ConflictException({
        message: `No se puede continuar desde "Ejecución operativa". Faltan jornadas por cerrar: ${vencidas
          .map((f) => `Día ${f.numero} (${diaCorto(f.fecha)})`)
          .join('; ')}. Ciérrelas o regístrelas como día sin operación.`,
        code: 'JORNADAS_PENDIENTES',
      });
    }
    if (filas.length > 0 && filas.every(abierta)) {
      throw new ConflictException({
        message:
          'No se puede continuar desde "Ejecución operativa". Registre al menos la jornada de hoy: ciérrela o regístrela como día sin operación.',
        code: 'JORNADAS_PENDIENTES',
      });
    }
  }

  /** Los días del servicio que todavía no se resolvieron (pendientes o abiertos), en orden. */
  private async diasSinResolver(tx: Prisma.TransactionClient, ticketId: string) {
    await this.generar(tx, ticketId);
    return tx.ticketJornada.findMany({
      where: { ticketId, estado: { in: ['pendiente', 'abierta'] } },
      orderBy: { fecha: 'asc' },
      select: { numero: true, fecha: true },
    });
  }

  /**
   * Cerrar el servicio (de la «Revisión final» al «Cierre») exige que **todos** los días del servicio estén resueltos: cerrados, sin operación o
   * no aplicar. Si faltan, el ticket pasa al siguiente día; si el trabajo ya terminó, el Jefe de Base acorta el servicio.
   */
  async exigirServicioCompleto(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const faltan = await this.diasSinResolver(tx, ticketId);
    if (!faltan.length) return;
    throw new ConflictException({
      message: `No se puede cerrar el servicio: faltan días por trabajar: ${faltan
        .map((f) => `Día ${f.numero} (${diaCorto(f.fecha)})`)
        .join(
          '; ',
        )}. Pase al siguiente día; si el trabajo ya terminó, el Jefe de Base acorta el servicio, y si un día no se trabaja, se registra como día sin operación.`,
      code: 'JORNADAS_PENDIENTES',
    });
  }

  /** De la «Revisión final» se vuelve a la ejecución solo si quedan días por trabajar (el ciclo del siguiente día). */
  async exigirDiasPorTrabajar(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    if ((await this.diasSinResolver(tx, ticketId)).length) return;
    throw new ConflictException({
      message: 'No quedan días por trabajar: el servicio ya puede cerrarse.',
      code: 'SIN_DIAS_POR_TRABAJAR',
    });
  }

  /**
   * De la «Revisión de reportes de salida» a la ejecución solo se pasa con la revisión hecha: la inspección de cada unidad aprobada por el
   * Supervisor (la hizo el Conductor) y el reporte de unidad de salida firmado por su Operador, del primer día del servicio. Cada día siguiente
   * vuelve a pasar por lo mismo en su jornada. Un ticket sin fecha de inicio no se puede validar y no se bloquea.
   */
  async exigirRevisionDeSalida(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: {
        fechaInicioServicio: true,
        unidades: {
          select: {
            unidadId: true,
            unidad: { select: { codigo: true, vehiculo: { select: { placa: true } } } },
          },
        },
      },
    });
    if (!t?.fechaInicioServicio) return;
    const dia = t.fechaInicioServicio;
    const [aprobadas, firmados] = await Promise.all([
      tx.ticketHechoTraslado.findMany({
        where: { ticketId, fecha: dia, tipo: 'inspeccion_aprobada', vigente: true },
        select: { unidadId: true },
      }),
      tx.reporteUnidad.findMany({
        where: { ticketId, fecha: dia, salidaFirmadaAt: { not: null } },
        select: { unidadId: true },
      }),
    ]);
    const conInspeccion = new Set(aprobadas.map((a) => a.unidadId));
    const conReporte = new Set(firmados.map((f) => f.unidadId));
    const pendientes = t.unidades.flatMap((u) => {
      const nombre = u.unidad.vehiculo?.placa ?? u.unidad.codigo;
      return [
        ...(conInspeccion.has(u.unidadId)
          ? []
          : [
              {
                codigo: 'inspeccion_vehiculo_aprobada',
                texto: `Inspección de vehículo aprobada (${nombre})`,
              },
            ]),
        ...(conReporte.has(u.unidadId)
          ? []
          : [
              {
                codigo: 'reporte_unidad_salida',
                texto: `Reporte de unidad de salida firmado (${nombre})`,
              },
            ]),
      ];
    });
    if (!pendientes.length) return;
    throw new ConflictException({
      message: `No se puede continuar desde "Revisión de reportes de salida". Falta: ${pendientes.map((p) => p.texto).join('; ')}.`,
      code: 'REQUISITOS_PENDIENTES',
      pendientes,
    });
  }

  /**
   * Revisión de reportes de llegada: una fila por unidad y por cada día trabajado (jornada cerrada) con lo que el Supervisor debe revisar: la
   * inspección de llegada (la hace el Conductor y la aprueba el Supervisor en Flota) y el reporte de unidad de llegada (lo firma el Operador; el
   * Supervisor lo aprueba o lo rechaza con motivo). Un reporte que se vuelve a firmar después de un rechazo se revisa de nuevo.
   */
  async revisionDeLlegada(
    cliente: Prisma.TransactionClient | PrismaService,
    ticketId: string,
  ): Promise<FilaRevisionLlegada[]> {
    const [unidades, jornadas, hechos, reportes, revisiones] = await Promise.all([
      cliente.ticketUnidad.findMany({
        where: { ticketId },
        select: {
          unidadId: true,
          unidad: { select: { codigo: true, vehiculo: { select: { placa: true } } } },
        },
      }),
      cliente.ticketJornada.findMany({
        where: { ticketId, estado: 'cerrada' },
        orderBy: { fecha: 'asc' },
        select: { fecha: true, numero: true },
      }),
      cliente.ticketHechoTraslado.findMany({
        where: {
          ticketId,
          vigente: true,
          tipo: { in: ['inspeccion_llegada_realizada', 'inspeccion_llegada_aprobada'] },
        },
        select: { unidadId: true, fecha: true, tipo: true },
      }),
      cliente.reporteUnidad.findMany({
        where: { ticketId, llegadaFirmadaAt: { not: null } },
        select: { unidadId: true, fecha: true, llegadaFirmadaAt: true },
      }),
      cliente.reporteLlegadaRevision.findMany({
        where: { ticketId },
        orderBy: { revisadoAt: 'desc' },
        select: { unidadId: true, fecha: true, decision: true, motivo: true, revisadoAt: true },
      }),
    ]);
    const clave = (u: string, f: Date) => `${u}|${aFecha(f)}`;
    const hecho = (u: string, f: Date, tipo: string) =>
      hechos.some((h) => clave(h.unidadId, h.fecha) === clave(u, f) && h.tipo === tipo);
    return unidades.flatMap((u) =>
      jornadas.map((j) => {
        const firma = reportes.find(
          (r) => clave(r.unidadId, r.fecha) === clave(u.unidadId, j.fecha),
        );
        const ultima = revisiones.find(
          (r) => clave(r.unidadId, r.fecha) === clave(u.unidadId, j.fecha),
        );
        // una revisión anterior a la última firma ya no vale: el reporte cambió
        const vigente =
          ultima && firma?.llegadaFirmadaAt && ultima.revisadoAt >= firma.llegadaFirmadaAt
            ? ultima
            : null;
        return {
          unidadId: u.unidadId,
          unidad: u.unidad.vehiculo?.placa ?? u.unidad.codigo,
          fecha: aFecha(j.fecha),
          numero: j.numero,
          inspeccion: hecho(u.unidadId, j.fecha, 'inspeccion_llegada_aprobada')
            ? ('aprobada' as const)
            : hecho(u.unidadId, j.fecha, 'inspeccion_llegada_realizada')
              ? ('por_aprobar' as const)
              : ('pendiente' as const),
          reporte: !firma
            ? ('sin_firmar' as const)
            : !vigente
              ? ('por_revisar' as const)
              : vigente.decision === 'aprobada'
                ? ('aprobado' as const)
                : ('rechazado' as const),
          motivo: vigente?.decision === 'rechazada' ? (vigente.motivo ?? null) : null,
        };
      }),
    );
  }

  listarRevisionLlegada(ticketId: string): Promise<FilaRevisionLlegada[]> {
    return this.revisionDeLlegada(this.prisma, ticketId);
  }

  /** El Supervisor aprueba o rechaza (con motivo) el reporte de llegada de una unidad y un día. Un rechazo deja al Operador volver a firmarlo. */
  async revisarReporteLlegada(
    ticketId: string,
    unidadId: string,
    fecha: string,
    decision: 'aprobada' | 'rechazada',
    motivo: string | undefined,
    actor: AuthUser,
  ) {
    const texto = motivo?.trim() ?? '';
    if (decision === 'rechazada' && texto.length < 3)
      throw new BadRequestException('Escriba el motivo del rechazo (mínimo 3 caracteres)');
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { pasoCodigo: true, personas: { select: { usuarioId: true, rol: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== 'revision_reportes_llegada')
        throw new ConflictException(
          'Los reportes de llegada se revisan en la Revisión de reportes de llegada',
        );
      this.exigirSupervisorAsignado(t.personas, actor);
      const dia = new Date(`${fecha}T00:00:00Z`);
      const reporte = await tx.reporteUnidad.findUnique({
        where: { ticketId_unidadId_fecha: { ticketId, unidadId, fecha: dia } },
        select: { llegadaFirmadaAt: true },
      });
      if (!reporte?.llegadaFirmadaAt)
        throw new ConflictException('Ese reporte de llegada todavía no está firmado');
      await tx.reporteLlegadaRevision.create({
        data: {
          id: uuidv7(),
          ticketId,
          unidadId,
          fecha: dia,
          decision,
          motivo: decision === 'rechazada' ? texto : null,
          revisadoPor: actor.id,
        },
      });
    });
    return { ok: true };
  }

  /**
   * De la «Revisión de reportes de llegada» a la revisión final solo se pasa con la llegada revisada: la inspección de llegada de cada unidad
   * aprobada y su reporte de llegada aprobado por el Supervisor, de cada día trabajado.
   */
  async exigirRevisionDeLlegada(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const filas = await this.revisionDeLlegada(tx, ticketId);
    const dia = (f: FilaRevisionLlegada) => `${f.unidad} (Día ${f.numero})`;
    const pendientes = filas.flatMap((f) => [
      ...(f.inspeccion === 'aprobada'
        ? []
        : [
            {
              codigo: 'inspeccion_llegada_aprobada',
              texto: `${f.inspeccion === 'por_aprobar' ? 'Aprobar' : 'Hacer y aprobar'} la inspección de llegada de ${dia(f)}`,
            },
          ]),
      ...(f.reporte === 'aprobado'
        ? []
        : [
            {
              codigo: 'reporte_llegada_aprobado',
              texto:
                f.reporte === 'rechazado'
                  ? `Corregir y volver a firmar el reporte de llegada de ${dia(f)} (rechazado)`
                  : f.reporte === 'sin_firmar'
                    ? `Firmar el reporte de llegada de ${dia(f)}`
                    : `Aprobar el reporte de llegada de ${dia(f)}`,
            },
          ]),
    ]);
    if (!pendientes.length) return;
    throw new ConflictException({
      message: `No se puede continuar desde "Revisión de reportes de llegada". Falta: ${pendientes.map((p) => p.texto).join('; ')}.`,
      code: 'REQUISITOS_PENDIENTES',
      pendientes,
    });
  }

  /**
   * Para registrar trabajo de un día (checklist de seguridad, job log…): el día debe ser una jornada activa (pendiente o abierta) y ya haber
   * llegado. Crea las jornadas que falten. `queCosa` completa el mensaje.
   */
  async exigirDiaDeTrabajo(
    tx: Prisma.TransactionClient,
    ticketId: string,
    fecha: string,
    queCosa: string,
  ): Promise<void> {
    await this.generar(tx, ticketId);
    const j = await tx.ticketJornada.findUnique({
      where: { ticketId_fecha: { ticketId, fecha: new Date(`${fecha}T00:00:00Z`) } },
      select: { estado: true },
    });
    if (!j) throw new NotFoundException('Ese día no está dentro del rango del servicio');
    if (j.estado !== 'pendiente' && j.estado !== 'abierta') {
      throw new ConflictException(
        `Esa jornada está ${j.estado.replace('_', ' ')}: ya no admite ${queCosa}`,
      );
    }
    if (fecha > this.hoy()) {
      throw new ConflictException(
        `${queCosa[0].toUpperCase()}${queCosa.slice(1)} se registra el mismo día de la jornada`,
      );
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
      include: { requisito: { select: { nombre: true } }, unidad: UNIDAD_CON_PLACA },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map((f) => {
      const para = f.unidad ? etiquetaDeUnidad(f.unidad) : null;
      return {
        codigo: f.requisitoCodigo,
        nombre: para ? `${f.requisito.nombre} (${para})` : f.requisito.nombre,
      };
    });
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
        unidad: UNIDAD_CON_PLACA,
      },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
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
          /** La unidad a la que corresponde (los traslados del día son por unidad); `null` si es del servicio. */
          unidadId: r.unidadId,
          para: r.unidad ? etiquetaDeUnidad(r.unidad) : null,
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
        .map((r) => ({
          codigo: r.codigo,
          nombre: r.para ? `${r.nombre} (${r.para})` : r.nombre,
          responsable: r.modulo,
        }));
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
      /** Jornadas que todavía hay que cerrar (o registrar sin operación) para poder salir de la Ejecución operativa. */
      porCerrar: activas.filter((j) => j.estado === 'pendiente' || j.estado === 'abierta').length,
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
    return this.enJornada(
      ticketId,
      fecha,
      (p) => this.exigirSupervisorAsignado(p, actor),
      async (tx, j) => {
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
      },
    );
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
    return this.enJornada(
      ticketId,
      fecha,
      (p) => this.exigirParticipante(p, actor),
      async (tx, j) => {
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
        await this.publicarDias(tx, ticketId); // un día sin operación ya no necesita PTW
        return { ok: true };
      },
    );
  }

  /** El Supervisor cierra la jornada de hoy (o de un día pasado). Un día futuro no se cierra. */
  async cerrar(ticketId: string, fecha: string, actor: AuthUser) {
    return this.enJornada(
      ticketId,
      fecha,
      (p) => this.exigirSupervisorAsignado(p, actor),
      async (tx, j) => {
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
      },
    );
  }

  /** Reabre una jornada cerrada o sin operación, con motivo. Vuelve a «abierta» si ya tenía la aceptación del Company Man, si no a «pendiente». */
  async reabrir(ticketId: string, fecha: string, motivo: string, actor: AuthUser) {
    const texto = motivo.trim();
    if (texto.length < 3)
      throw new BadRequestException('Escriba el motivo de la reapertura (mínimo 3 caracteres)');
    return this.enJornada(ticketId, fecha, null, async (tx, j) => {
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
      await this.publicarDias(tx, ticketId);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Carga la jornada de un día del ticket (en Ejecución operativa) y corre la acción dentro de una transacción. */
  private async enJornada<R>(
    ticketId: string,
    fecha: string,
    /** Quién puede hacerlo; se comprueba antes de mirar el día, para no responder «no existe» a quien no tiene permiso. */
    autorizar: ((personas: { usuarioId: string; rol: string }[]) => void) | null,
    accion: (
      tx: Prisma.TransactionClient,
      jornada: NonNullable<
        Awaited<ReturnType<Prisma.TransactionClient['ticketJornada']['findUnique']>>
      >,
      ticket: { personas: { usuarioId: string; rol: string }[] },
    ) => Promise<R>,
  ): Promise<R> {
    if (!fechaValida(fecha))
      throw new BadRequestException('La fecha debe tener el formato AAAA-MM-DD');
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { pasoCodigo: true, personas: { select: { usuarioId: true, rol: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      autorizar?.(t.personas);
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
