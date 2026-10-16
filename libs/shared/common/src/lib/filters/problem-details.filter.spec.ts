import { uniqueTarget } from './problem-details.filter';

describe('uniqueTarget (violación de unicidad de Prisma)', () => {
  it('motor clásico: usa meta.target', () => {
    expect(uniqueTarget({ target: ['email'] })).toBe('email');
    expect(uniqueTarget({ target: ['tipo', 'nombre'] })).toBe('tipo, nombre');
  });

  it('adaptador pg: usa constraint.fields si vienen', () => {
    expect(
      uniqueTarget({ driverAdapterError: { cause: { constraint: { fields: ['codigo'] } } } }),
    ).toBe('codigo');
  });

  it('adaptador pg: deduce la columna del nombre del índice <tabla>_<columnas>_key', () => {
    const meta = (index: string, table: string) => ({
      driverAdapterError: { cause: { constraint: { index }, table } },
    });
    expect(uniqueTarget(meta('taladro_nombre_key', 'taladro'))).toBe('nombre');
    expect(uniqueTarget(meta('persona_contacto_tipo_nombre_key', 'persona_contacto'))).toBe(
      'tipo nombre',
    );
    expect(uniqueTarget(meta('cliente_identificacion_key', 'cliente'))).toBe('identificacion');
    expect(uniqueTarget(meta('algo_raro', 'otra'))).toBe('algo raro');
  });

  it('sin información útil: "campo único", sin lanzar', () => {
    expect(uniqueTarget(undefined)).toBe('campo único');
    expect(uniqueTarget({})).toBe('campo único');
    expect(uniqueTarget({ driverAdapterError: { cause: {} } })).toBe('campo único');
  });
});
