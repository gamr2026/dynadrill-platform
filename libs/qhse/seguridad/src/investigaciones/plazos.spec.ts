import { calcularPlazos, codigoInvestigacion } from './plazos';

const H = 3_600_000;
const incidente = new Date('2026-10-01T10:00:00.000Z');
const nearMiss = { inicioHoras: 72, preliminarHoras: null, finalDias: 30 };
const fatal = { inicioHoras: 0, preliminarHoras: 24, finalDias: 15 };

describe('plazos de la investigación (HSE-TRIAGE-002)', () => {
  it('Near Miss: 72 h para iniciar, sin informe preliminar y 30 días para el informe final', () => {
    const p = calcularPlazos(incidente, nearMiss, null, false, new Date(incidente.getTime() + H));
    expect(p.inicioLimite.toISOString()).toBe('2026-10-04T10:00:00.000Z');
    expect(p.preliminarLimite).toBeNull();
    expect(p.finalLimite.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(p.inicioVencido).toBe(false);
    expect(p.finalVencido).toBe(false);
  });

  it('Fatal: la escena debe asegurarse al instante y el preliminar sale a las 24 h', () => {
    const p = calcularPlazos(incidente, fatal, null, false, new Date(incidente.getTime() + H));
    expect(p.inicioVencido).toBe(true);
    expect(p.preliminarLimite?.toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('el inicio se mide contra el momento en que se aseguró la escena', () => {
    const dentro = new Date(incidente.getTime() + 70 * H);
    const fuera = new Date(incidente.getTime() + 80 * H);
    const ahora = new Date(incidente.getTime() + 200 * H);
    expect(calcularPlazos(incidente, nearMiss, dentro, false, ahora).inicioVencido).toBe(false);
    expect(calcularPlazos(incidente, nearMiss, fuera, false, ahora).inicioVencido).toBe(true);
  });

  it('el informe final vence a los 30 días, pero no si ya está cerrada', () => {
    const ahora = new Date(incidente.getTime() + 31 * 24 * H);
    expect(calcularPlazos(incidente, nearMiss, null, false, ahora).finalVencido).toBe(true);
    expect(calcularPlazos(incidente, nearMiss, null, true, ahora).finalVencido).toBe(false);
  });

  it('el consecutivo se muestra como INV-000001', () => {
    expect(codigoInvestigacion(1)).toBe('INV-000001');
    expect(codigoInvestigacion(1234)).toBe('INV-001234');
  });
});
