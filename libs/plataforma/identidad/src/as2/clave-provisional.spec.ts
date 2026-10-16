import { claveProvisional } from './clave-provisional';

describe('claveProvisional', () => {
  it.each([
    ['Alfredo Raúl', 'Guerrón Sandoval', 'ARGS123*'],
    ['MONICA ELIZABETH', 'CACERES VASQUEZ', 'MECV123*'],
    ['Juan', 'Pérez', 'JP123*'],
    ['  Ana   María ', ' de la Torre ', 'AMDLT123*'],
    ['Óscar', 'Ñúñez', 'ON123*'],
  ])('%s %s → %s', (nombres, apellidos, esperada) => {
    expect(claveProvisional(nombres, apellidos)).toBe(esperada);
  });

  it('termina siempre en 123* y no deja caracteres raros', () => {
    expect(claveProvisional("D'Angelo", '1 Pérez')).toMatch(/^[A-Z]+123\*$/);
  });
});
