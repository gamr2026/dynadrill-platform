import { calcularAlertas, nivelDe, type ReglaAlerta, type EntradaAlertas } from './alertas';

const REGLAS: ReglaAlerta[] = [
  {
    codigo: 'servicio_a',
    tipoUnidad: 'servicio',
    tipoServicio: 'a',
    metrica: 'horas',
    intervalo: 250,
    tolerancia: 30,
    descripcion: 'A',
  },
  {
    codigo: 'servicio_b',
    tipoUnidad: 'servicio',
    tipoServicio: 'b',
    metrica: 'horas',
    intervalo: 2000,
    tolerancia: 50,
    descripcion: 'B',
  },
  {
    codigo: 'servicio_tiempo',
    tipoUnidad: 'servicio',
    tipoServicio: null,
    metrica: 'dias',
    intervalo: 180,
    tolerancia: 0,
    descripcion: 'T',
  },
  {
    codigo: 'auxiliar_tiempo',
    tipoUnidad: 'auxiliar',
    tipoServicio: null,
    metrica: 'dias',
    intervalo: 180,
    tolerancia: 0,
    descripcion: 'X',
  },
  {
    codigo: 'transporte_km',
    tipoUnidad: 'transporte',
    tipoServicio: null,
    metrica: 'km',
    intervalo: 5000,
    tolerancia: 500,
    descripcion: 'K',
  },
];

const AHORA = new Date('2026-10-16T12:00:00Z');
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 86_400_000);
const base = (e: Partial<EntradaAlertas>): EntradaAlertas => ({
  tipo: 'servicio',
  lecturaVigente: null,
  ultimoA: null,
  ultimoB: null,
  ultimoCualquiera: null,
  ahora: AHORA,
  ...e,
});
const porRegla = (a: ReturnType<typeof calcularAlertas>, c: string) =>
  a.find((x) => x.reglaCodigo === c);

describe('niveles del semáforo', () => {
  it('rojo solo cuando se supera la tolerancia; amarillo con el 15 % o menos del intervalo', () => {
    expect(nivelDe(100, 250, 30)).toBe('verde');
    expect(nivelDe(37, 250, 30)).toBe('amarillo');
    expect(nivelDe(0, 250, 30)).toBe('amarillo');
    expect(nivelDe(-30, 250, 30)).toBe('amarillo'); // dentro de la ventana
    expect(nivelDe(-31, 250, 30)).toBe('rojo');
  });
});

describe('alertas preventivas', () => {
  it('servicio: el tipo B reinicia también el contador del A', () => {
    const e = base({
      lecturaVigente: 3100,
      ultimoA: { fecha: hace(200), valor: 2200 },
      ultimoB: { fecha: hace(10), valor: 3000 },
      ultimoCualquiera: { fecha: hace(10), valor: 3000 },
    });
    const a = calcularAlertas(REGLAS, e);
    expect(porRegla(a, 'servicio_a')?.consumido).toBe(100); // desde el B (3000), no desde el A (2200)
    expect(porRegla(a, 'servicio_b')?.consumido).toBe(100);
  });

  it('servicio: sin ningún preventivo cuenta desde cero y queda vencido', () => {
    const a = calcularAlertas(REGLAS, base({ lecturaVigente: 1000 }));
    const rA = porRegla(a, 'servicio_a');
    expect(rA?.consumido).toBe(1000);
    expect(rA?.restante).toBe(-750);
    expect(rA?.nivel).toBe('rojo');
  });

  it('servicio: la ventana de tolerancia deja al equipo en amarillo (A a 270 h)', () => {
    const a = calcularAlertas(
      REGLAS,
      base({
        lecturaVigente: 1270,
        ultimoA: { fecha: hace(20), valor: 1000 },
        ultimoCualquiera: { fecha: hace(20), valor: 1000 },
      }),
    );
    const rA = porRegla(a, 'servicio_a');
    expect(rA?.restante).toBe(-20);
    expect(rA?.enVentana).toBe(true);
    expect(rA?.nivel).toBe('amarillo');
  });

  it('servicio: los 6 meses por tiempo solo cuentan si aún no se alcanzan las 250 h del A', () => {
    const sinHoras = calcularAlertas(
      REGLAS,
      base({
        lecturaVigente: 1100,
        ultimoA: { fecha: hace(200), valor: 1000 },
        ultimoCualquiera: { fecha: hace(200), valor: 1000 },
      }),
    );
    expect(porRegla(sinHoras, 'servicio_tiempo')?.consumido).toBe(200);
    expect(porRegla(sinHoras, 'servicio_tiempo')?.nivel).toBe('rojo');
    const conHoras = calcularAlertas(
      REGLAS,
      base({
        lecturaVigente: 1300,
        ultimoA: { fecha: hace(200), valor: 1000 },
        ultimoCualquiera: { fecha: hace(200), valor: 1000 },
      }),
    );
    expect(porRegla(conHoras, 'servicio_tiempo')).toBeUndefined();
  });

  it('servicio sin horómetro (cisterna): solo la regla por tiempo', () => {
    const a = calcularAlertas(
      REGLAS,
      base({
        ultimoA: { fecha: hace(100), valor: null },
        ultimoCualquiera: { fecha: hace(100), valor: null },
      }),
    );
    expect(a.map((x) => x.reglaCodigo)).toEqual(['servicio_tiempo']);
    expect(a[0].restante).toBe(80);
  });

  it('auxiliar: mantenimiento semestral por tiempo', () => {
    const a = calcularAlertas(
      REGLAS,
      base({ tipo: 'auxiliar', ultimoCualquiera: { fecha: hace(190), valor: null } }),
    );
    expect(a).toHaveLength(1);
    expect(a[0].nivel).toBe('rojo');
  });

  it('transporte: cada 5.000 km con tolerancia de 500', () => {
    const ult = { fecha: hace(30), valor: 85000 };
    const verde = calcularAlertas(
      REGLAS,
      base({ tipo: 'transporte', lecturaVigente: 87400, ultimoCualquiera: ult }),
    );
    expect(verde[0]).toMatchObject({ consumido: 2400, restante: 2600, nivel: 'verde' });
    const ventana = calcularAlertas(
      REGLAS,
      base({ tipo: 'transporte', lecturaVigente: 90100, ultimoCualquiera: ult }),
    );
    expect(ventana[0]).toMatchObject({ restante: -100, nivel: 'amarillo', enVentana: true });
    const vencido = calcularAlertas(
      REGLAS,
      base({ tipo: 'transporte', lecturaVigente: 90600, ultimoCualquiera: ult }),
    );
    expect(vencido[0].nivel).toBe('rojo');
  });

  it('transporte sin preventivo previo no genera alerta (no hay base de cálculo)', () => {
    expect(calcularAlertas(REGLAS, base({ tipo: 'transporte', lecturaVigente: 1000 }))).toEqual([]);
  });
});
