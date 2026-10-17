import { estadoDeOrden, type SubordenParaEstado } from './estado-orden';

const sub = (estadoCodigo: string, resuelta = false): SubordenParaEstado => ({ estadoCodigo, resuelta });

describe('estado de la orden (se deriva de sus sub-órdenes)', () => {
  it('sin sub-órdenes está pendiente', () => {
    expect(estadoDeOrden(false, [])).toBe('pendiente');
  });

  it('con todas pendientes sigue pendiente', () => {
    expect(estadoDeOrden(false, [sub('pendiente'), sub('pendiente')])).toBe('pendiente');
  });

  it('está en mantenimiento en cuanto una sub-orden se diagnostica, se ejecuta o se revisa', () => {
    for (const e of ['en_diagnostico', 'en_ejecucion', 'en_revision_cierre']) {
      expect(estadoDeOrden(false, [sub('pendiente'), sub(e)])).toBe('en_mantenimiento');
    }
  });

  it('requiere cambios si alguna sub-orden tiene una corrección solicitada, aunque otras avancen', () => {
    expect(
      estadoDeOrden(false, [sub('correccion_solicitada'), sub('en_ejecucion'), sub('cerrado', true)]),
    ).toBe('requiere_cambios');
  });

  it('queda aceptada cuando todas están cerradas o derivadas a Pumping (resueltas)', () => {
    expect(estadoDeOrden(false, [sub('cerrado', true), sub('derivado_a_pumping', true)])).toBe(
      'aceptada',
    );
  });

  it('una sub-orden sin resolver impide aceptarla', () => {
    expect(estadoDeOrden(false, [sub('cerrado', true), sub('en_ejecucion')])).toBe('en_mantenimiento');
    expect(estadoDeOrden(false, [sub('cerrado', true), sub('pendiente')])).toBe('pendiente');
  });

  it('cerrada solo cuando la unidad volvió a operación, sin importar las sub-órdenes', () => {
    expect(estadoDeOrden(true, [sub('cerrado', true)])).toBe('cerrada');
    expect(estadoDeOrden(true, [])).toBe('cerrada');
  });
});
