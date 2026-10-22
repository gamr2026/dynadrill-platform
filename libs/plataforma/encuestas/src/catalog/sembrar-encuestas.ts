import { uuidv7 } from '@dyn/utils';
import { EstadoVersion, TipoRespuesta, type PrismaClient } from '../generated/client';

/** Módulos del sistema que pueden tener encuestas. Se agregan aquí a medida que un módulo las necesita. */
export const MODULOS_ENCUESTA = [
  { codigo: 'fcr', nombre: 'FCR (pesca, completación y remediales)' },
];

/** Escala de satisfacción de la demo (hoja «Encuesta de satisfacción del cliente»). */
export const ESCALA_SATISFACCION = {
  codigo: 'satisfaccion_1_5',
  nombre: 'Satisfacción de 1 a 5',
  valores: [
    { valor: 1, etiqueta: 'Muy deficiente' },
    { valor: 2, etiqueta: 'Deficiente' },
    { valor: 3, etiqueta: 'Aceptable' },
    { valor: 4, etiqueta: 'Bueno' },
    { valor: 5, etiqueta: 'Excelente' },
  ],
};

/** Los seis temas de la demo. La administración puede cambiarlos con una versión nueva. */
export const ENCUESTA_FCR = {
  codigo: 'fcr_satisfaccion',
  nombre: 'Encuesta de satisfacción del cliente (FCR)',
  moduloCodigo: 'fcr',
  introduccion:
    'Su opinión nos ayuda a mejorar. Califique cada aspecto del servicio de 1 (muy deficiente) a 5 (excelente).',
  temas: [
    'Cumplimiento de requisitos técnicos del servicio',
    'Disponibilidad y estado de equipos',
    'Competencia técnica del personal',
    'Comunicación y coordinación durante la operación',
    'Desempeño en seguridad y ambiente',
    'Satisfacción general del servicio',
  ],
  comentarios: 'Comentarios u observaciones',
};

/** Siembra módulos, escala y la encuesta de FCR. Idempotente: no toca lo que ya existe. */
export async function sembrarEncuestas(
  prisma: PrismaClient,
  /** Cuenta que figura como quien publicó la versión inicial (un Superadmin). Sin ella, la versión queda en borrador. */
  publicadaPor: string | null,
): Promise<{ modulos: number; escalas: number; encuestas: number; publicada: boolean }> {
  let modulos = 0;
  for (const m of MODULOS_ENCUESTA) {
    if (await prisma.moduloEncuesta.findUnique({ where: { codigo: m.codigo } })) continue;
    await prisma.moduloEncuesta.create({ data: m });
    modulos++;
  }

  let escalas = 0;
  let escala = await prisma.escala.findUnique({ where: { codigo: ESCALA_SATISFACCION.codigo } });
  if (!escala) {
    escala = await prisma.escala.create({
      data: {
        id: uuidv7(),
        codigo: ESCALA_SATISFACCION.codigo,
        nombre: ESCALA_SATISFACCION.nombre,
        valores: { create: ESCALA_SATISFACCION.valores },
      },
    });
    escalas++;
  }

  if (await prisma.encuesta.findUnique({ where: { codigo: ENCUESTA_FCR.codigo } })) {
    return { modulos, escalas, encuestas: 0, publicada: false };
  }
  const publicada = publicadaPor !== null;
  await prisma.$transaction(async (tx) => {
    const encuestaId = uuidv7();
    const versionId = uuidv7();
    await tx.encuesta.create({
      data: {
        id: encuestaId,
        codigo: ENCUESTA_FCR.codigo,
        nombre: ENCUESTA_FCR.nombre,
        moduloCodigo: ENCUESTA_FCR.moduloCodigo,
      },
    });
    await tx.encuestaVersion.create({
      data: {
        id: versionId,
        encuestaId,
        numero: 1,
        titulo: ENCUESTA_FCR.nombre,
        introduccion: ENCUESTA_FCR.introduccion,
      },
    });
    for (const [i, texto] of ENCUESTA_FCR.temas.entries()) {
      await tx.pregunta.create({
        data: {
          id: uuidv7(),
          versionId,
          orden: i + 1,
          texto,
          tipo: TipoRespuesta.escala,
          obligatoria: true,
          escalaId: escala.id,
        },
      });
    }
    await tx.pregunta.create({
      data: {
        id: uuidv7(),
        versionId,
        orden: ENCUESTA_FCR.temas.length + 1,
        texto: ENCUESTA_FCR.comentarios,
        tipo: TipoRespuesta.texto,
        obligatoria: false,
      },
    });
    if (publicadaPor) {
      await tx.encuestaVersion.update({
        where: { id: versionId },
        data: {
          estado: EstadoVersion.publicada,
          publicadaAt: new Date(),
          publicadaBy: publicadaPor,
        },
      });
    }
  });
  return { modulos, escalas, encuestas: 1, publicada };
}
