import { codigoDeViaje, nivelDePuntaje } from './viajes.service';

describe('nivelDePuntaje', () => {
  const umbrales = [
    { nivel: 'alto' as const, desdePuntos: 76 },
    { nivel: 'bajo' as const, desdePuntos: 0 },
    { nivel: 'medio' as const, desdePuntos: 31 },
  ];

  it('toma el umbral más alto que no supere el puntaje', () => {
    expect(nivelDePuntaje(0, umbrales)).toBe('bajo');
    expect(nivelDePuntaje(30, umbrales)).toBe('bajo');
    expect(nivelDePuntaje(31, umbrales)).toBe('medio');
    expect(nivelDePuntaje(75, umbrales)).toBe('medio');
    expect(nivelDePuntaje(76, umbrales)).toBe('alto');
    expect(nivelDePuntaje(300, umbrales)).toBe('alto');
  });

  it('sin umbral para el puntaje es un error de configuración, no un nivel inventado', () => {
    expect(() => nivelDePuntaje(5, [{ nivel: 'medio', desdePuntos: 31 }])).toThrow();
  });
});

describe('codigoDeViaje', () => {
  it('numera con cuatro cifras como mínimo', () => {
    expect(codigoDeViaje(7)).toBe('GV-0007');
    expect(codigoDeViaje(12345n)).toBe('GV-12345');
  });
});
