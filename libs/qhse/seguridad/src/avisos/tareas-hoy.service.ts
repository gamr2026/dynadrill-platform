import { Injectable } from '@nestjs/common';
import { hoyEcuador, masDias } from '../comun/fechas';
import { AvisosProgramadosService } from './avisos-programados.service';

export interface TareaQhse {
  clave: 'abrir_ptw' | 'aprobar_ptw' | 'cargar_pt';
  titulo: string;
  detalle: string | null;
  estado: 'pendiente';
  tono: 'warn' | 'danger';
  ticketId: string | null;
  /** Ruta del portal donde se resuelve. */
  enlace: string;
}

const dia = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const ticketTxt = (d: Record<string, unknown>) =>
  `Ticket ${d['ticketNumero'] ?? d['pedidoCodigo']}${d['pozo'] ? ` · ${d['pozo']}` : ''}`;

/**
 * «Mis tareas de hoy» de QHSE: lo que el personal HSE debe resolver hoy para que las jornadas de Pumping puedan operar. Son las mismas
 * condiciones que generan los avisos de PTW, PT y ART (un solo lugar donde se calculan), pero a la vista todo el día y no solo desde la hora
 * en que sale el aviso:
 *  - hay servicio hoy y el día no tiene PTW,
 *  - el PTW de hoy sigue sin aprobarse (debe estar aprobado antes de la hora de inicio),
 *  - mañana hay servicio y todavía no se cargó el PT de ese día.
 */
@Injectable()
export class TareasHoyQhseService {
  constructor(private readonly avisos: AvisosProgramadosService) {}

  async delDia(hoy: string = hoyEcuador()) {
    // pasar el final del día evita el filtro por hora: aquí se ve todo lo pendiente, no solo lo que ya toca avisar
    const sinFiltroDeHora = '23:59';
    const [sinPtw, sinAprobar, sinPt] = await Promise.all([
      this.avisos.servicioSinPtw(hoy),
      this.avisos.ptwSinAprobarALaHora(hoy, sinFiltroDeHora),
      this.avisos.faltaPtManana(hoy, sinFiltroDeHora),
    ]);
    const tareas: TareaQhse[] = [
      ...sinPtw.map((c): TareaQhse => ({
        clave: 'abrir_ptw',
        titulo: `Abrir el PTW del día · ${ticketTxt(c.datos)}`,
        detalle: 'Sin PTW: la jornada no puede operar',
        estado: 'pendiente',
        tono: 'danger',
        ticketId: String(c.entidadId),
        enlace: '/dashboard/qhse/ptw',
      })),
      ...sinAprobar.map((c): TareaQhse => ({
        clave: 'aprobar_ptw',
        titulo: `${String(c.datos['ptwCodigo'])} sin aprobar · ${ticketTxt(c.datos)}`,
        detalle: `Debe estar aprobado antes del inicio previsto (${String(c.datos['horaInicio'])})`,
        estado: 'pendiente',
        tono: 'warn',
        ticketId: typeof c.datos['ticketId'] === 'string' ? c.datos['ticketId'] : null,
        enlace: '/dashboard/qhse/ptw',
      })),
      ...sinPt.map((c): TareaQhse => ({
        clave: 'cargar_pt',
        titulo: `Mañana falta el PT del ${dia(masDias(hoy, 1))} · ${ticketTxt(c.datos)}`,
        detalle: 'Si no llega, la jornada de mañana quedará bloqueada',
        estado: 'pendiente',
        tono: 'warn',
        ticketId: String(c.entidadId),
        enlace: '/dashboard/qhse/documentos',
      })),
    ];
    return {
      fecha: hoy,
      pendientes: tareas.length,
      bloques: tareas.length
        ? [
            {
              rol: 'qhse' as const,
              ticketId: null,
              ticketNumero: null,
              titulo: 'QHSE · PTW, PT y ART',
              jornada: null,
              pendientes: tareas.length,
              tareas,
            },
          ]
        : [],
    };
  }
}
