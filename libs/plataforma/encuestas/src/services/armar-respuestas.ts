import { BadRequestException } from '@nestjs/common';
import { TipoRespuesta } from '../generated/client';

/** Lo que el formulario necesita saber de una pregunta para validar su respuesta. */
export interface PreguntaParaResponder {
  id: string;
  texto: string;
  tipo: TipoRespuesta;
  obligatoria: boolean;
  /** Valores permitidos de la escala (solo en las preguntas de escala). */
  valoresEscala: number[];
  /** Opciones permitidas (solo en las preguntas de opción única o múltiple). */
  opcionIds: string[];
}

export interface RespuestaEntrada {
  preguntaId: string;
  /** Escala: número. Texto: texto. Sí/no: booleano. Opción única: id de la opción. Opción múltiple: lista de ids. */
  valor: unknown;
}

/** Una fila de `encuestas.respuesta`: exactamente un valor. */
export interface FilaRespuesta {
  preguntaId: string;
  valorNumero?: number;
  valorTexto?: string;
  valorBooleano?: boolean;
  opcionId?: string;
}

const MAX_TEXTO = 2000;

/**
 * Valida lo que respondió el cliente contra las preguntas de la versión enviada y lo convierte en filas (una por pregunta, o por opción
 * elegida en la múltiple). Una pregunta opcional sin respuesta (texto en blanco, lista vacía o `null`) simplemente no genera fila.
 * La base vuelve a comprobar lo esencial (pregunta de la versión, tipo y obligatorias); aquí están los mensajes para quien contesta.
 */
export function armarRespuestas(
  preguntas: PreguntaParaResponder[],
  entradas: RespuestaEntrada[],
): FilaRespuesta[] {
  const porId = new Map(preguntas.map((p) => [p.id, p]));
  const vistas = new Set<string>();
  const filas: FilaRespuesta[] = [];

  for (const e of entradas) {
    const p = porId.get(e.preguntaId);
    if (!p) throw new BadRequestException('Una de las respuestas no corresponde a esta encuesta');
    if (vistas.has(p.id)) {
      throw new BadRequestException(`La pregunta «${p.texto}» está respondida dos veces`);
    }
    vistas.add(p.id);
    const vacia = e.valor === null || e.valor === undefined;
    const donde = `«${p.texto}»`;

    switch (p.tipo) {
      case TipoRespuesta.escala: {
        if (vacia) break;
        if (typeof e.valor !== 'number' || !p.valoresEscala.includes(e.valor)) {
          throw new BadRequestException(`${donde}: elija un valor de la escala`);
        }
        filas.push({ preguntaId: p.id, valorNumero: e.valor });
        break;
      }
      case TipoRespuesta.texto: {
        if (vacia) break;
        if (typeof e.valor !== 'string')
          throw new BadRequestException(`${donde}: escriba un texto`);
        const t = e.valor.trim();
        if (t.length > MAX_TEXTO) {
          throw new BadRequestException(`${donde}: el texto admite hasta ${MAX_TEXTO} caracteres`);
        }
        if (t) filas.push({ preguntaId: p.id, valorTexto: t });
        break;
      }
      case TipoRespuesta.si_no: {
        if (vacia) break;
        if (typeof e.valor !== 'boolean')
          throw new BadRequestException(`${donde}: responda sí o no`);
        filas.push({ preguntaId: p.id, valorBooleano: e.valor });
        break;
      }
      case TipoRespuesta.opcion_unica: {
        if (vacia) break;
        if (typeof e.valor !== 'string' || !p.opcionIds.includes(e.valor)) {
          throw new BadRequestException(`${donde}: elija una de las opciones`);
        }
        filas.push({ preguntaId: p.id, opcionId: e.valor });
        break;
      }
      case TipoRespuesta.opcion_multiple: {
        if (vacia) break;
        if (
          !Array.isArray(e.valor) ||
          e.valor.some((o) => typeof o !== 'string' || !p.opcionIds.includes(o))
        ) {
          throw new BadRequestException(`${donde}: elija entre las opciones indicadas`);
        }
        const elegidas = [...new Set(e.valor as string[])];
        for (const opcionId of elegidas) filas.push({ preguntaId: p.id, opcionId });
        break;
      }
    }
  }

  const respondidas = new Set(filas.map((f) => f.preguntaId));
  const faltan = preguntas.filter((p) => p.obligatoria && !respondidas.has(p.id));
  if (faltan.length) {
    const lista = faltan
      .slice(0, 3)
      .map((p) => `«${p.texto}»`)
      .join(', ');
    throw new BadRequestException(
      `Falta responder: ${lista}${faltan.length > 3 ? ` y ${faltan.length - 3} más` : ''}`,
    );
  }
  return filas;
}
