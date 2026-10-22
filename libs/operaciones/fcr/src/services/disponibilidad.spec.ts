import { evaluarDisponibilidad, type Ocupacion } from './disponibilidad';

const ocupacion = (desde: string | null, hasta: string | null, numero = 4551): Ocupacion => ({
  ticketId: `t-${numero}`,
  ticketNumero: numero,
  pedidoCodigo: `PED-${numero}`,
  desde,
  hasta,
});

describe('evaluarDisponibilidad', () => {
  it('sin ocupaciones el operador está disponible todo el rango', () => {
    expect(evaluarDisponibilidad('2026-09-01', '2026-09-03', [])).toEqual({
      disponible: true,
      detalle: 'Disponible todo el rango',
      ocupaciones: [],
    });
  });

  it('una ocupación que no toca el rango no lo ocupa', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-03', [
      ocupacion('2026-09-04', '2026-09-10'),
      ocupacion('2026-08-01', '2026-08-31'),
    ]);
    expect(r.disponible).toBe(true);
    expect(r.ocupaciones).toEqual([]);
  });

  it('ocupado todo el rango: indica hasta cuándo', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-03', [
      ocupacion('2026-08-01', '2026-12-31'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado todo el rango (hasta 31/12)');
  });

  it('un ticket sin fecha de fin ocupa hasta que se cierre', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-03', [ocupacion('2026-08-01', null)]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado todo el rango (hasta que se cierre el ticket 4551)');
  });

  it('un ticket sin fecha de inicio ocupa desde siempre', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-03', [ocupacion(null, '2026-09-02')]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado al inicio, se incorpora el 03/09');
  });

  it('sale del rango: libre al inicio y ocupado a mitad del rango', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-05', [
      ocupacion('2026-09-03', '2026-09-08'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Disponible al inicio, sale del rango el 03/09');
  });

  it('se incorpora al rango: ocupado al inicio y libre desde el día siguiente al fin de su ticket', () => {
    const r = evaluarDisponibilidad('2026-09-08', '2026-09-12', [
      ocupacion('2026-09-01', '2026-09-10'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado al inicio, se incorpora el 11/09');
  });

  it('el día de fin de un ticket y el de inicio del rango cuentan como cruce', () => {
    const r = evaluarDisponibilidad('2026-09-10', '2026-09-12', [
      ocupacion('2026-09-01', '2026-09-10'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.ocupaciones).toHaveLength(1);
  });

  it('con varias ocupaciones explica la primera que se cruza y las devuelve todas', () => {
    const r = evaluarDisponibilidad('2026-09-01', '2026-09-30', [
      ocupacion('2026-09-20', '2026-09-25', 2),
      ocupacion('2026-09-05', '2026-09-08', 1),
    ]);
    expect(r.detalle).toBe('Disponible al inicio, sale del rango el 05/09');
    expect(r.ocupaciones.map((o) => o.ticketNumero)).toEqual([1, 2]);
  });
});
