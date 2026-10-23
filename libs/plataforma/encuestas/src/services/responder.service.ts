import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';
import { armarRespuestas, type RespuestaEntrada } from './armar-respuestas';
import { hashDeToken, TOKEN_VALIDO } from './token';

const ENLACE_INVALIDO = 'El enlace de la encuesta no es válido';
const YA_RESPONDIDA = 'Esta encuesta ya fue respondida. Gracias por su tiempo';
const VENCIDA = 'El enlace de la encuesta venció. Solicite que se le envíe uno nuevo';

export interface RespuestaDelCliente {
  nombre: string;
  cargo?: string;
  respuestas: RespuestaEntrada[];
}

/**
 * Formulario de la encuesta que abre el cliente con el enlace del correo (sin sesión: el token autoriza). Se contesta una sola vez y antes
 * de que venza; lo contestado queda guardado en filas y no se edita. Los mensajes no revelan nada del servicio evaluado.
 */
@Injectable()
export class ResponderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Las preguntas de la encuesta que se le envió, si el enlace sirve todavía. */
  async obtener(token: string) {
    const inv = await this.cargar(token);
    return {
      titulo: inv.version.titulo,
      introduccion: inv.version.introduccion,
      venceAt: inv.venceAt,
      preguntas: inv.version.preguntas.map((p) => ({
        id: p.id,
        orden: p.orden,
        texto: p.texto,
        tipo: p.tipo,
        obligatoria: p.obligatoria,
        escala: p.escala
          ? p.escala.valores.map((v) => ({ valor: v.valor, etiqueta: v.etiqueta }))
          : null,
        opciones: p.opciones.map((o) => ({ id: o.id, etiqueta: o.etiqueta })),
      })),
    };
  }

  /** Guarda lo que contestó el cliente. */
  async responder(token: string, entrada: RespuestaDelCliente) {
    const inv = await this.cargar(token);
    const nombre = entrada.nombre.trim();
    if (!nombre) throw new BadRequestException('Escriba su nombre');
    const filas = armarRespuestas(
      inv.version.preguntas.map((p) => ({
        id: p.id,
        texto: p.texto,
        tipo: p.tipo,
        obligatoria: p.obligatoria,
        valoresEscala: p.escala?.valores.map((v) => v.valor) ?? [],
        opcionIds: p.opciones.map((o) => o.id),
      })),
      entrada.respuestas,
    );
    const respuestaId = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.respuestaEncuesta.create({
          data: {
            id: respuestaId,
            invitacionId: inv.id,
            nombreRespondiente: nombre,
            cargoRespondiente: entrada.cargo?.trim() || null,
          },
        });
        await tx.respuesta.createMany({
          data: filas.map((f) => ({
            id: uuidv7(),
            respuestaEncuestaId: respuestaId,
            preguntaId: f.preguntaId,
            valorNumero: f.valorNumero ?? null,
            valorTexto: f.valorTexto ?? null,
            valorBooleano: f.valorBooleano ?? null,
            opcionId: f.opcionId ?? null,
          })),
        });
        // sin datos personales: quién contestó y su correo se consultan en la administración
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'plataforma.encuesta.respondida',
            subject: { type: 'encuesta_invitacion', id: inv.id },
            data: {
              invitacionId: inv.id,
              encuestaId: inv.version.encuesta.id,
              encuestaCodigo: inv.version.encuesta.codigo,
              versionId: inv.versionId,
              moduloCodigo: inv.moduloCodigo,
              referenciaId: inv.referenciaId,
            },
            traceparent: currentTraceparent(),
          }),
        );
      });
    } catch (e) {
      // dos envíos a la vez, o el enlace venció mientras se contestaba: la base es la última barrera
      const texto = e instanceof Error ? e.message : String(e);
      if (/respuesta_encuesta_invitacion_key|Unique constraint/i.test(texto)) {
        throw new GoneException(YA_RESPONDIDA);
      }
      if (/venció/.test(texto)) throw new GoneException(VENCIDA);
      if (/Falta responder/.test(texto))
        throw new BadRequestException('Falta responder alguna pregunta obligatoria');
      throw e;
    }
    return { ok: true, mensaje: 'Gracias por responder la encuesta' };
  }

  private async cargar(token: string) {
    if (!TOKEN_VALIDO.test(token)) throw new NotFoundException(ENLACE_INVALIDO);
    const inv = await this.prisma.invitacion.findUnique({
      where: { tokenHash: hashDeToken(token) },
      include: {
        respuesta: { select: { id: true } },
        version: {
          include: {
            encuesta: { select: { id: true, codigo: true } },
            preguntas: {
              orderBy: { orden: 'asc' },
              include: {
                escala: { include: { valores: { orderBy: { valor: 'asc' } } } },
                opciones: { orderBy: { orden: 'asc' } },
              },
            },
          },
        },
      },
    });
    if (!inv) throw new NotFoundException(ENLACE_INVALIDO);
    if (inv.respuesta) throw new GoneException(YA_RESPONDIDA);
    if (inv.venceAt.getTime() <= Date.now()) throw new GoneException(VENCIDA);
    return inv;
  }
}
