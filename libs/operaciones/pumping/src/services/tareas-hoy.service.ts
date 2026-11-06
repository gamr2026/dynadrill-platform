import { Injectable } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { MovimientosService } from '@dyn/inventario';
import { JREQ } from '../catalog/requisitos-jornada';
import { PrismaService } from '../prisma/prisma.service';
import { AvanceService } from './avance.service';
import { JornadasService } from './jornadas.service';
import { nombreDe } from './tickets.service';

const PASO = 'ejecucion_operativa';
const P = Permission;

export interface Tarea {
  /** Identifica la tarea para que la pantalla elija su botón («llenar el job log», «registrar herramientas»…). */
  clave: string;
  titulo: string;
  detalle: string | null;
  estado: 'hecha' | 'pendiente' | 'bloqueada';
  tono: 'ok' | 'info' | 'warn' | 'danger';
  ticketId: string | null;
  /** Ruta del portal donde se resuelve (el detalle del ticket). */
  enlace: string | null;
}

export interface BloqueDeTareas {
  rol: 'operador' | 'supervisor' | 'jefe_base';
  ticketId: string | null;
  ticketNumero: number | null;
  titulo: string;
  /** El día N de M del servicio si hoy es día de servicio de ese ticket. */
  jornada: { numero: number; total: number; fecha: string } | null;
  /** Cuántas tareas faltan por hacer (las hechas no cuentan). */
  pendientes: number;
  tareas: Tarea[];
}

type Jornadas = Awaited<ReturnType<JornadasService['listar']>>;
type JornadaDeLista = Jornadas['jornadas'][number];

const dia = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const enlaceDe = (ticketId: string) => `/modulos/operativo/pumping/pedidos/${ticketId}`;

/**
 * «Mis tareas de hoy» de Pumping: lo que la persona que consulta tiene que hacer hoy en los servicios que le tocan, armado con lo que ya
 * sabe la jornada (qué requisitos de apertura y de cierre se cumplieron) para que Inicio no tenga que recorrer cada ticket.
 *  - Operador: sus pendientes del día (checklist, job log, herramientas, químicos, el reporte de su unidad) y las jornadas pasadas sin cerrar.
 *  - Supervisor: la aceptación del Company Man de hoy, cerrar la jornada, los cambios de ítems por aprobar y las jornadas pasadas sin cerrar.
 *  - Jefe de Base: los servicios cuyo avance va adelantado (acortar) o atrasado (ampliar).
 * Cada módulo da las suyas (QHSE, Flota, Inventario…): Inicio junta las de todos.
 */
@Injectable()
export class TareasHoyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jornadas: JornadasService,
    private readonly avance: AvanceService,
    private readonly inventario: MovimientosService,
  ) {}

  async delUsuario(actor: AuthUser) {
    const hoy = this.jornadas.hoy();
    const bloques: BloqueDeTareas[] = [];

    const asignaciones = await this.prisma.ticketPersona.findMany({
      where: {
        usuarioId: actor.id,
        rol: { in: ['operador', 'supervisor'] },
        ticket: { pasoCodigo: PASO },
      },
      include: { ticket: { include: { cliente: true, pozo: true } } },
      orderBy: { ticket: { ticketNumero: 'asc' } },
    });
    for (const a of asignaciones) {
      const t = a.ticket;
      const lista = await this.jornadas.listar(t.id);
      const hoyJ = lista.jornadas.find((j) => j.fecha === hoy && j.estado !== 'no_aplica');
      const titulo = `${a.rol === 'operador' ? 'Operador' : 'Supervisor'} · Ticket ${t.ticketNumero ?? t.pedidoCodigo}${t.pozo ? ` · ${t.pozo.nombreCompleto}` : ''}`;
      const clienteTxt = nombreDe(t.cliente);
      const tareas =
        a.rol === 'operador'
          ? await this.deOperador(t.id, lista, hoyJ, a.unidadId, hoy)
          : await this.deSupervisor(t.id, lista, hoyJ);
      tareas.push(...this.atrasadas(t.id, lista, hoy));
      bloques.push({
        rol: a.rol as 'operador' | 'supervisor',
        ticketId: t.id,
        ticketNumero: t.ticketNumero,
        titulo: clienteTxt ? `${titulo} · ${clienteTxt}` : titulo,
        jornada: hoyJ ? { numero: hoyJ.numero, total: lista.total, fecha: hoyJ.fecha } : null,
        pendientes: tareas.filter((x) => x.estado !== 'hecha').length,
        tareas,
      });
    }

    if (actor.permissions.includes(P.PUMPING_JORNADA_CAMBIAR_DURACION)) {
      const b = await this.deJefeDeBase();
      if (b) bloques.push(b);
    }
    return {
      fecha: hoy,
      pendientes: bloques.reduce((s, b) => s + b.pendientes, 0),
      bloques,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async deOperador(
    ticketId: string,
    lista: Jornadas,
    hoyJ: JornadaDeLista | undefined,
    unidadId: string | null,
    hoy: string,
  ): Promise<Tarea[]> {
    if (!hoyJ || hoyJ.estado === 'sin_operacion' || hoyJ.estado === 'cerrada') return [];
    // lo del día y, de lo que es por unidad, solo lo de la suya
    const mios = hoyJ.requisitos.filter((r) => !r.unidadId || r.unidadId === unidadId);
    const de = (codigo: string) => mios.find((r) => r.codigo === codigo);
    const tarea = (
      clave: string,
      titulo: string,
      codigo: string,
      detallePendiente: string,
    ): Tarea | null => {
      const r = de(codigo);
      if (!r) return null;
      const hecha = r.estado === 'cumplido';
      return {
        clave,
        titulo,
        detalle: hecha ? null : detallePendiente,
        estado: hecha ? 'hecha' : 'pendiente',
        tono: hecha ? 'ok' : 'warn',
        ticketId,
        enlace: enlaceDe(ticketId),
      };
    };
    const tareas = [
      tarea(
        'checklist',
        'Checklist de seguridad del día (gases, LOTO, SIMOPS)',
        JREQ.checklist,
        'Pendiente de hoy',
      ),
      tarea(
        'company_man',
        'El Company Man aceptó trabajar hoy',
        JREQ.companyMan,
        'Lo marca el Supervisor',
      ),
      tarea(
        'reporte_salida',
        'Reporte de unidad de salida',
        JREQ.reporteSalida,
        'Fírmelo antes de salir',
      ),
      tarea('job_log', 'Reporte diario de actividades (job log)', JREQ.jobLog, 'Pendiente de hoy'),
      tarea('herramientas', 'Herramientas e ítems del día', JREQ.herramientas, 'Pendiente de hoy'),
      tarea(
        'reporte_llegada',
        'Reporte de unidad de llegada',
        JREQ.reporteLlegada,
        'Fírmelo al regresar a base',
      ),
    ].filter((x): x is Tarea => x !== null);

    // el consumo de químicos solo aplica si el ticket tiene químicos a su cargo
    const quimicos = await this.inventario.quimicosDeTicket(ticketId);
    if (quimicos.length) {
      const hecho = quimicos.some((q) => q.usadaPorDia.some((d) => d.fecha === hoy));
      tareas.push({
        clave: 'consumo_quimicos',
        titulo: `Consumo de químicos del Día ${hoyJ.numero}`,
        detalle: hecho ? null : 'Pendiente de hoy · se guarda con el día del servicio',
        estado: hecho ? 'hecha' : 'pendiente',
        tono: hecho ? 'ok' : 'warn',
        ticketId,
        enlace: enlaceDe(ticketId),
      });
    }
    // si la jornada espera algo de otra área, se le dice para que no la busque
    if (hoyJ.bloqueos.length) {
      tareas.push({
        clave: 'esperando_otras_areas',
        titulo: 'La jornada espera a otras áreas',
        detalle: hoyJ.bloqueos.map((b) => b.nombre).join('; '),
        estado: 'bloqueada',
        tono: 'info',
        ticketId,
        enlace: enlaceDe(ticketId),
      });
    }
    void lista;
    return tareas;
  }

  private async deSupervisor(
    ticketId: string,
    lista: Jornadas,
    hoyJ: JornadaDeLista | undefined,
  ): Promise<Tarea[]> {
    const tareas: Tarea[] = [];
    if (hoyJ && hoyJ.estado !== 'sin_operacion') {
      tareas.push({
        clave: 'aceptar_company_man',
        titulo: 'Aceptación del Company Man de hoy',
        detalle: hoyJ.companyManAcepto ? null : 'Márquela cuando el Company Man acepte trabajar',
        estado: hoyJ.companyManAcepto ? 'hecha' : 'pendiente',
        tono: hoyJ.companyManAcepto ? 'ok' : 'warn',
        ticketId,
        enlace: enlaceDe(ticketId),
      });
      if (hoyJ.estado === 'cerrada') {
        tareas.push({
          clave: 'cerrar_jornada',
          titulo: `Jornada del Día ${hoyJ.numero} cerrada`,
          detalle: null,
          estado: 'hecha',
          tono: 'ok',
          ticketId,
          enlace: enlaceDe(ticketId),
        });
      } else {
        const faltaCierre = hoyJ.requisitos.filter(
          (r) => r.momento === 'cierre' && r.estado === 'pendiente',
        );
        tareas.push({
          clave: 'cerrar_jornada',
          titulo: `Cerrar la jornada del Día ${hoyJ.numero}`,
          detalle:
            hoyJ.estado === 'abierta' && faltaCierre.length === 0
              ? 'Lista para cerrar'
              : hoyJ.estado !== 'abierta'
                ? 'La jornada todavía no está abierta'
                : `Se habilita cuando se cumpla: ${[...new Set(faltaCierre.map((r) => r.nombre))].join('; ')}`,
          estado: 'pendiente',
          tono: hoyJ.estado === 'abierta' && faltaCierre.length === 0 ? 'warn' : 'info',
          ticketId,
          enlace: enlaceDe(ticketId),
        });
      }
    }
    // el Operador propone cambios de ítems y el Supervisor los aprueba
    const cambios = await this.prisma.solicitudCambioItems.findMany({
      where: { ticketId, estado: 'pendiente' },
      select: { id: true, motivo: true },
      orderBy: { solicitadoAt: 'asc' },
    });
    for (const c of cambios) {
      tareas.push({
        clave: 'aprobar_cambio_items',
        titulo: 'Aprobar el cambio de ítems del pedido',
        detalle: c.motivo,
        estado: 'pendiente',
        tono: 'warn',
        ticketId,
        enlace: enlaceDe(ticketId),
      });
    }
    void lista;
    return tareas;
  }

  /** Las jornadas de días pasados que siguen sin cerrar: bloquean terminar el servicio. */
  private atrasadas(ticketId: string, lista: Jornadas, hoy: string): Tarea[] {
    return lista.jornadas
      .filter((j) => j.fecha < hoy && (j.estado === 'pendiente' || j.estado === 'abierta'))
      .map((j) => {
        const falta = j.requisitos.filter((r) => r.estado === 'pendiente');
        return {
          clave: 'jornada_atrasada',
          titulo: `Jornada del ${dia(j.fecha)} sin cerrar`,
          detalle: falta.length
            ? `Falta: ${[...new Set(falta.map((r) => r.nombre))].join('; ')}`
            : 'Está lista para cerrar',
          estado: 'bloqueada' as const,
          tono: 'danger' as const,
          ticketId,
          enlace: enlaceDe(ticketId),
        };
      });
  }

  /** El Jefe de Base decide si acorta (va adelantado) o amplía (va atrasado) cada servicio en ejecución. */
  private async deJefeDeBase(): Promise<BloqueDeTareas | null> {
    const tickets = await this.prisma.ticket.findMany({
      where: { pasoCodigo: PASO },
      select: {
        id: true,
        ticketNumero: true,
        pedidoCodigo: true,
        pozo: { select: { nombreCompleto: true } },
      },
      orderBy: { ticketNumero: 'asc' },
      take: 100,
    });
    const tareas: Tarea[] = [];
    for (const t of tickets) {
      const a = await this.avance.obtener(t.id);
      if (!a.adelantado && !a.atrasado) continue;
      const nombre = `Ticket ${t.ticketNumero ?? t.pedidoCodigo}${t.pozo ? ` · ${t.pozo.nombreCompleto}` : ''}`;
      tareas.push({
        clave: a.adelantado ? 'avance_adelantado' : 'avance_atrasado',
        titulo: a.adelantado
          ? `${nombre}: el avance va adelantado, considere acortar el servicio`
          : `${nombre}: el avance va atrasado, considere ampliar el servicio`,
        detalle: `${a.avanceReal} % de lo cotizado usado frente a ${a.avancePlan} % planificado (día ${a.diaActual} de ${a.diasTotal})`,
        estado: 'pendiente',
        tono: a.adelantado ? 'info' : 'warn',
        ticketId: t.id,
        enlace: enlaceDe(t.id),
      });
    }
    // el Jefe de Base decide los cambios de ítems igual que el Supervisor del ticket
    const cambios = await this.prisma.solicitudCambioItems.findMany({
      where: { estado: 'pendiente', ticket: { pasoCodigo: { not: 'cierre' } } },
      select: {
        motivo: true,
        ticket: { select: { id: true, ticketNumero: true, pedidoCodigo: true } },
      },
      orderBy: { solicitadoAt: 'asc' },
      take: 100,
    });
    for (const c of cambios) {
      tareas.push({
        clave: 'aprobar_cambio_items',
        titulo: `Cambio de ítems del Ticket ${c.ticket.ticketNumero ?? c.ticket.pedidoCodigo} por aprobar`,
        detalle: c.motivo,
        estado: 'pendiente',
        tono: 'warn',
        ticketId: c.ticket.id,
        enlace: enlaceDe(c.ticket.id),
      });
    }
    if (!tareas.length) return null;
    return {
      rol: 'jefe_base',
      ticketId: null,
      ticketNumero: null,
      titulo: 'Jefe de Base · Avance de servicios',
      jornada: null,
      pendientes: tareas.length,
      tareas,
    };
  }
}
