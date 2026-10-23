import { BadRequestException } from '@nestjs/common';
import { TipoRespuesta } from '../generated/client';
import { armarRespuestas, type PreguntaParaResponder } from './armar-respuestas';

const base = { valoresEscala: [], opcionIds: [] as string[] };
const preguntas: PreguntaParaResponder[] = [
  {
    ...base,
    id: 'esc',
    texto: 'Servicio',
    tipo: TipoRespuesta.escala,
    obligatoria: true,
    valoresEscala: [1, 2, 3, 4, 5],
  },
  { ...base, id: 'txt', texto: 'Comentarios', tipo: TipoRespuesta.texto, obligatoria: false },
  { ...base, id: 'sn', texto: '¿Volvería?', tipo: TipoRespuesta.si_no, obligatoria: true },
  {
    ...base,
    id: 'uni',
    texto: 'Equipo',
    tipo: TipoRespuesta.opcion_unica,
    obligatoria: false,
    opcionIds: ['a', 'b'],
  },
  {
    ...base,
    id: 'mul',
    texto: 'Mejorar',
    tipo: TipoRespuesta.opcion_multiple,
    obligatoria: false,
    opcionIds: ['x', 'y', 'z'],
  },
];
const completas = [
  { preguntaId: 'esc', valor: 4 },
  { preguntaId: 'sn', valor: false },
];
const mensaje = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('Debía rechazar');
};

describe('armarRespuestas', () => {
  it('convierte cada tipo en sus filas, con exactamente un valor', () => {
    const filas = armarRespuestas(preguntas, [
      ...completas,
      { preguntaId: 'txt', valor: '  Todo bien  ' },
      { preguntaId: 'uni', valor: 'b' },
      { preguntaId: 'mul', valor: ['x', 'z', 'x'] },
    ]);
    expect(filas).toEqual([
      { preguntaId: 'esc', valorNumero: 4 },
      { preguntaId: 'sn', valorBooleano: false },
      { preguntaId: 'txt', valorTexto: 'Todo bien' },
      { preguntaId: 'uni', opcionId: 'b' },
      { preguntaId: 'mul', opcionId: 'x' },
      { preguntaId: 'mul', opcionId: 'z' },
    ]);
  });

  it('una pregunta opcional en blanco, vacía o nula no genera fila; «no» cuenta como respuesta', () => {
    const filas = armarRespuestas(preguntas, [
      ...completas,
      { preguntaId: 'txt', valor: '   ' },
      { preguntaId: 'uni', valor: null },
      { preguntaId: 'mul', valor: [] },
    ]);
    expect(filas.map((f) => f.preguntaId)).toEqual(['esc', 'sn']);
    expect(filas[1]).toEqual({ preguntaId: 'sn', valorBooleano: false });
  });

  it('exige las obligatorias y las nombra', () => {
    expect(mensaje(() => armarRespuestas(preguntas, []))).toBe(
      'Falta responder: «Servicio», «¿Volvería?»',
    );
    expect(
      mensaje(() =>
        armarRespuestas(preguntas, [
          { preguntaId: 'esc', valor: null },
          { preguntaId: 'sn', valor: true },
        ]),
      ),
    ).toBe('Falta responder: «Servicio»');
    const muchas: PreguntaParaResponder[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      ...base,
      id,
      texto: id.toUpperCase(),
      tipo: TipoRespuesta.si_no,
      obligatoria: true,
    }));
    expect(mensaje(() => armarRespuestas(muchas, []))).toBe(
      'Falta responder: «A», «B», «C» y 2 más',
    );
  });

  it('rechaza un valor que no corresponde al tipo de la pregunta', () => {
    const con = (preguntaId: string, valor: unknown) => () =>
      armarRespuestas(preguntas, [
        ...completas.filter((c) => c.preguntaId !== preguntaId),
        { preguntaId, valor },
      ]);
    expect(mensaje(con('esc', 9))).toMatch(/elija un valor de la escala/);
    expect(mensaje(con('esc', '4'))).toMatch(/elija un valor de la escala/);
    expect(mensaje(con('esc', 2.5))).toMatch(/elija un valor de la escala/);
    expect(mensaje(con('txt', 7))).toMatch(/escriba un texto/);
    expect(mensaje(con('txt', 'x'.repeat(2001)))).toMatch(/hasta 2000 caracteres/);
    expect(mensaje(con('sn', 'sí'))).toMatch(/responda sí o no/);
    expect(mensaje(con('uni', 'c'))).toMatch(/elija una de las opciones/);
    expect(mensaje(con('uni', ['a']))).toMatch(/elija una de las opciones/);
    expect(mensaje(con('mul', 'x'))).toMatch(/elija entre las opciones/);
    expect(mensaje(con('mul', ['x', 'q']))).toMatch(/elija entre las opciones/);
  });

  it('rechaza una pregunta ajena y una respondida dos veces', () => {
    expect(
      mensaje(() => armarRespuestas(preguntas, [...completas, { preguntaId: 'otra', valor: 1 }])),
    ).toMatch(/no corresponde a esta encuesta/);
    expect(
      mensaje(() => armarRespuestas(preguntas, [...completas, { preguntaId: 'esc', valor: 5 }])),
    ).toMatch(/respondida dos veces/);
  });
});
