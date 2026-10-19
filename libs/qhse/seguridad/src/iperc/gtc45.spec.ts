import {
  interpretarProbabilidad,
  interpretarRiesgo,
  nivelDeProbabilidad,
  nivelDeRiesgo,
  valorar,
} from './gtc45';

describe('GTC 45: valoración del riesgo', () => {
  it('NP = ND × NE y NR = NP × NC', () => {
    expect(nivelDeProbabilidad({ nd: 2, ne: 3 })).toBe(6);
    expect(nivelDeRiesgo({ nd: 2, ne: 3, nc: 25 })).toBe(150);
  });

  it('interpreta el nivel de probabilidad con las bandas de la norma', () => {
    expect(interpretarProbabilidad(40)).toBe('muy_alto');
    expect(interpretarProbabilidad(24)).toBe('muy_alto');
    expect(interpretarProbabilidad(20)).toBe('alto');
    expect(interpretarProbabilidad(10)).toBe('alto');
    expect(interpretarProbabilidad(8)).toBe('medio');
    expect(interpretarProbabilidad(6)).toBe('medio');
    expect(interpretarProbabilidad(4)).toBe('bajo');
    expect(interpretarProbabilidad(0)).toBe('bajo');
  });

  it('interpreta el nivel de riesgo y su aceptabilidad en los bordes de cada banda', () => {
    expect(interpretarRiesgo(4000)).toMatchObject({ nivel: 'I', aceptabilidad: 'No aceptable' });
    expect(interpretarRiesgo(600).nivel).toBe('I');
    expect(interpretarRiesgo(599).nivel).toBe('II');
    expect(interpretarRiesgo(150).nivel).toBe('II');
    expect(interpretarRiesgo(149)).toMatchObject({ nivel: 'III', aceptabilidad: 'Mejorable' });
    expect(interpretarRiesgo(40).nivel).toBe('III');
    expect(interpretarRiesgo(39)).toMatchObject({ nivel: 'IV', aceptabilidad: 'Aceptable' });
  });

  it('calcula todo junto y devuelve null si falta algún eje', () => {
    expect(valorar(2, 3, 25)).toEqual({
      nd: 2,
      ne: 3,
      nc: 25,
      np: 6,
      probabilidad: 'medio',
      nr: 150,
      nivel: 'II',
      aceptabilidad: 'No aceptable o aceptable con control específico',
    });
    expect(valorar(0, 4, 100)).toMatchObject({ np: 0, nr: 0, nivel: 'IV' });
    expect(valorar(2, null, 25)).toBeNull();
  });
});
