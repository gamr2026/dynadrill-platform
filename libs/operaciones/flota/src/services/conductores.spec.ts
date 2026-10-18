import { estadoDeDocumento } from './conductores.service';
import { estadoDeSalida } from './inspecciones.service';

describe('estadoDeDocumento', () => {
  const hoy = '2026-10-18';

  it('un documento sin vigencia está vigente sin más', () => {
    expect(estadoDeDocumento(false, null, hoy)).toEqual({ estado: 'vigente', diasRestantes: null });
  });

  it('el último día de validez todavía vale; al día siguiente está vencido', () => {
    expect(estadoDeDocumento(true, '2026-10-18', hoy)).toEqual({
      estado: 'por_vencer',
      diasRestantes: 0,
    });
    expect(estadoDeDocumento(true, '2026-10-17', hoy)).toEqual({
      estado: 'vencido',
      diasRestantes: -1,
    });
  });

  it('avisa desde 30 días antes del vencimiento', () => {
    expect(estadoDeDocumento(true, '2026-11-17', hoy).estado).toBe('por_vencer');
    expect(estadoDeDocumento(true, '2026-11-18', hoy).estado).toBe('vigente');
  });

  it('un documento que vence y no trae fecha se considera faltante', () => {
    expect(estadoDeDocumento(true, null, hoy).estado).toBe('faltante');
  });
});

describe('estadoDeSalida', () => {
  it('sin inspección vigente está pendiente', () => {
    expect(estadoDeSalida(null)).toBe('pendiente');
  });

  it('con inspección y sin aprobación está por aprobar; la última revisión decide', () => {
    expect(estadoDeSalida({ revisiones: [] })).toBe('por_aprobar');
    expect(estadoDeSalida({ revisiones: [{ decision: 'aprobada' }] })).toBe('aprobada');
    expect(estadoDeSalida({ revisiones: [{ decision: 'rechazada' }] })).toBe('por_aprobar');
  });
});
