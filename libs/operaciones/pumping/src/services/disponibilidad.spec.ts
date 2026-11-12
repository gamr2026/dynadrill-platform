import {
  evaluarDisponibilidad,
  ocupacionDeTicket,
  rangoDeServicio,
  seCruza,
  type Ocupacion,
} from './disponibilidad';

const ocupacion = (desde: string | null, hasta: string | null, numero = 4551): Ocupacion => ({
  ticketId: `t-${numero}`,
  ticketNumero: numero,
  pedidoCodigo: `PED-${numero}`,
  cliente: 'Cliente de prueba',
  desde,
  hasta,
});
const rango = (desde: string, hasta: string) => ({ desde, hasta });
const dia = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);

describe('evaluarDisponibilidad (personal de Pumping)', () => {
  it('sin ocupaciones la persona está disponible todo el rango', () => {
    expect(evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [])).toEqual({
      disponible: true,
      detalle: 'Disponible todo el rango',
      ocupaciones: [],
    });
  });

  it('una ocupación que no toca el rango no lo ocupa', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [
      ocupacion('2026-09-04', '2026-09-10'),
      ocupacion('2026-08-01', '2026-08-31'),
    ]);
    expect(r.disponible).toBe(true);
    expect(r.ocupaciones).toEqual([]);
  });

  it('el borde cuenta: el día de fin de la otra ocupación y el día de inicio del rango se cruzan', () => {
    expect(
      evaluarDisponibilidad(rango('2026-09-03', '2026-09-05'), [
        ocupacion('2026-09-01', '2026-09-03'),
      ]).disponible,
    ).toBe(false);
    expect(
      evaluarDisponibilidad(rango('2026-09-04', '2026-09-05'), [
        ocupacion('2026-09-01', '2026-09-03'),
      ]).disponible,
    ).toBe(true);
  });

  it('ocupado todo el rango: indica hasta cuándo, con los datos del ticket que lo ocupa', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [
      ocupacion('2026-08-01', '2026-12-31'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado todo el rango (hasta 31/12)');
    expect(r.ocupaciones).toEqual([
      {
        ticketId: 't-4551',
        ticketNumero: 4551,
        pedidoCodigo: 'PED-4551',
        cliente: 'Cliente de prueba',
        desde: '2026-08-01',
        hasta: '2026-12-31',
      },
    ]);
  });

  it('un ticket sin fecha de fin ocupa hasta que se cierre', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [
      ocupacion('2026-08-01', null),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado todo el rango (hasta que se cierre el ticket 4551)');
  });

  it('un ticket sin fecha de inicio ocupa desde siempre', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [
      ocupacion(null, '2026-09-02'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado al inicio, se incorpora el 03/09');
  });

  it('sale del rango: libre al inicio y ocupado a mitad del rango', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-05'), [
      ocupacion('2026-09-03', '2026-09-08'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Disponible al inicio, sale del rango el 03/09');
  });

  it('se incorpora al rango: ocupado al inicio y libre desde el día siguiente al fin de su ticket', () => {
    const r = evaluarDisponibilidad(rango('2026-09-08', '2026-09-12'), [
      ocupacion('2026-09-01', '2026-09-10'),
    ]);
    expect(r.disponible).toBe(false);
    expect(r.detalle).toBe('Ocupado al inicio, se incorpora el 11/09');
  });

  it('con varias ocupaciones las devuelve ordenadas por inicio y describe la primera', () => {
    const r = evaluarDisponibilidad(rango('2026-09-01', '2026-09-30'), [
      ocupacion('2026-09-20', '2026-09-25', 2),
      ocupacion('2026-09-05', '2026-09-10', 1),
      ocupacion('2026-11-01', '2026-11-05', 3),
    ]);
    expect(r.ocupaciones.map((o) => o.ticketNumero)).toEqual([1, 2]);
    expect(r.detalle).toBe('Disponible al inicio, sale del rango el 05/09');
  });

  it('sin número de ticket se nombra por el código del pedido', () => {
    const o = { ...ocupacion('2026-08-01', null), ticketNumero: null };
    expect(evaluarDisponibilidad(rango('2026-09-01', '2026-09-03'), [o]).detalle).toBe(
      'Ocupado todo el rango (hasta que se cierre el ticket PED-4551)',
    );
  });
});

describe('ocupacionDeTicket: cuándo se libera el personal', () => {
  const base = {
    id: 't1',
    ticketNumero: 7,
    pedidoCodigo: 'PED-7',
    cliente: 'ACME',
  };

  it('el equipo se libera el día de fin del servicio', () => {
    const o = ocupacionDeTicket(
      { ...base, fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: dia('2026-11-07') },
      '2026-11-06',
    );
    expect(o).toMatchObject({ desde: '2026-11-05', hasta: '2026-11-07', cliente: 'ACME' });
  });

  it('si el fin ya pasó y el ticket sigue abierto, sigue ocupado hasta el cierre', () => {
    const o = ocupacionDeTicket(
      { ...base, fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: dia('2026-11-07') },
      '2026-11-08',
    );
    expect(o.hasta).toBeNull();
  });

  it('el día de fin todavía cuenta (hoy es el último día)', () => {
    const o = ocupacionDeTicket(
      { ...base, fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: dia('2026-11-07') },
      '2026-11-07',
    );
    expect(o.hasta).toBe('2026-11-07');
  });

  it('sin fechas es lo más estricto: desde siempre y hasta el cierre', () => {
    const o = ocupacionDeTicket(
      { ...base, fechaInicioServicio: null, fechaFinServicio: null },
      '2026-11-08',
    );
    expect(o).toMatchObject({ desde: null, hasta: null });
    expect(seCruza(rango('2030-01-01', '2030-01-02'), o)).toBe(true);
  });
});

describe('rangoDeServicio', () => {
  it('es el servicio del ticket; sin fin, el día de inicio; sin inicio, hoy', () => {
    expect(
      rangoDeServicio(
        { fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: dia('2026-11-07') },
        '2026-11-01',
      ),
    ).toEqual(rango('2026-11-05', '2026-11-07'));
    expect(
      rangoDeServicio(
        { fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: null },
        '2026-11-01',
      ),
    ).toEqual(rango('2026-11-05', '2026-11-05'));
    expect(
      rangoDeServicio({ fechaInicioServicio: null, fechaFinServicio: null }, '2026-11-01'),
    ).toEqual(rango('2026-11-01', '2026-11-01'));
  });

  it('con `desde` (ampliar el servicio) solo mira los días a partir de esa fecha', () => {
    expect(
      rangoDeServicio(
        { fechaInicioServicio: dia('2026-11-05'), fechaFinServicio: dia('2026-11-09') },
        '2026-11-01',
        dia('2026-11-08') as Date,
      ),
    ).toEqual(rango('2026-11-08', '2026-11-09'));
  });
});
