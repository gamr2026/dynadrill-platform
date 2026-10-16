import { calcularPrefactura, ItemLista, ItemPedido, redondear, totalizar } from './calculo';

const TASAS = { ivaPct: 15, retencionIrPct: 1, retencionIvaPct: 30 };
const lista: ItemLista[] = [
  {
    codigo: 'CT5104',
    descripcion: 'Cargo básico unidad',
    unidad: 'día',
    precio: 100,
    tipo: 'Servicio',
  },
  { codigo: 'MAT-1', descripcion: 'Material uno', unidad: 'Unidad', precio: 50, tipo: 'Material' },
  { codigo: 'SUP-DIA', descripcion: 'Supervisor', unidad: 'día', precio: 437.23, tipo: 'Servicio' },
  { codigo: 'MOV', descripcion: 'Movilización', unidad: 'Unidad', precio: 200, tipo: 'Servicio' },
];
const pedido = (codigo: string, cantidad: number, extra: Partial<ItemPedido> = {}): ItemPedido => ({
  codigo,
  descripcion: codigo,
  unidad: 'Unidad',
  cantidad,
  valorUnitario: 10,
  descuentoPct: 0,
  ...extra,
});
const base = {
  itemsPedido: [],
  herramientas: [],
  diasReporteJob: 3,
  lista,
  nombreLista: 'Lista IT',
  tasas: TASAS,
};

describe('calcularPrefactura', () => {
  it('renta de herramienta: cuenta los días en operación, stand by y cargo diario (no los de venta)', () => {
    const r = calcularPrefactura({
      ...base,
      herramientas: [
        {
          nombre: 'Cargo básico',
          serie: 'DY-CT-018',
          codigo: 'CT5104',
          usos: [
            { estado: 'operacion' },
            { estado: 'stand_by' },
            { estado: 'daily_charge' },
            { estado: 'venta' },
          ],
        },
      ],
    });
    const renta = r.items.find((i) => i.unidad === 'día');
    expect(renta).toMatchObject({
      cantidad: 3,
      precioUnitario: 100,
      precioTotal: 300,
      fuente: 'herramienta',
      serie: 'DY-CT-018',
    });
  });

  it('venta de herramienta: una línea aparte por unidad; si es Material sale como material', () => {
    const r = calcularPrefactura({
      ...base,
      herramientas: [
        {
          nombre: 'Material uno',
          serie: null,
          codigo: 'MAT-1',
          usos: [{ estado: 'venta' }, { estado: 'venta' }],
        },
        { nombre: 'Cargo básico', serie: null, codigo: 'CT5104', usos: [{ estado: 'venta' }] },
      ],
    });
    expect(r.items[0]).toMatchObject({
      codigo: 'MAT-1',
      unidad: 'unidad',
      cantidad: 2,
      precioTotal: 100,
      fuente: 'material',
    });
    expect(r.items[1]).toMatchObject({
      codigo: 'CT5104',
      unidad: 'unidad',
      cantidad: 1,
      fuente: 'herramienta',
    });
  });

  it('una herramienta sin código o fuera de la lista no se factura y se avisa (no se descarta en silencio)', () => {
    const r = calcularPrefactura({
      ...base,
      herramientas: [
        { nombre: 'Sin código', serie: null, codigo: null, usos: [{ estado: 'operacion' }] },
        { nombre: 'Otra', serie: null, codigo: 'NO-EXISTE', usos: [{ estado: 'operacion' }] },
      ],
    });
    expect(r.items).toHaveLength(0);
    expect(r.advertencias[0]).toContain('no hay nada que facturar'); // la lista no calza: aviso general primero
    expect(r.advertencias.join(' ')).toContain('"Sin código" no tiene código');
    expect(r.advertencias.join(' ')).toContain('NO-EXISTE');
  });

  it('ítems del pedido: por día usa los días del Reporte Job; los demás, la cantidad cotizada', () => {
    const r = calcularPrefactura({
      ...base,
      itemsPedido: [pedido('SUP-DIA', 99), pedido('MOV', 2)],
    });
    expect(r.items[0]).toMatchObject({
      codigo: 'SUP-DIA',
      cantidad: 3,
      precioTotal: 1311.69,
      fuente: 'personal',
    });
    expect(r.items[1]).toMatchObject({ codigo: 'MOV', cantidad: 2, precioTotal: 400 });
  });

  it('respeta el descuento acordado en el pedido', () => {
    const r = calcularPrefactura({
      ...base,
      itemsPedido: [pedido('MOV', 2, { descuentoPct: 50 })],
    });
    expect(r.items[0]).toMatchObject({ descuentoPct: 50, precioTotal: 200 });
  });

  it('un ítem que ya no está en la lista se factura con lo cotizado y queda como personal_manual con aviso', () => {
    const r = calcularPrefactura({
      ...base,
      itemsPedido: [pedido('VIEJO', 4, { valorUnitario: 12.5 })],
    });
    expect(r.items[0]).toMatchObject({
      codigo: 'VIEJO',
      precioUnitario: 12.5,
      precioTotal: 50,
      tipo: 'Material',
      fuente: 'personal_manual',
    });
    expect(r.advertencias[0]).toContain('VIEJO');
  });

  it('sin lista de precios avisa por qué el neto queda en cero', () => {
    const r = calcularPrefactura({ ...base, lista: null, nombreLista: null, itemsPedido: [] });
    expect(r.items).toHaveLength(0);
    expect(r.totales.netoCobrar).toBe(0);
    expect(r.advertencias[0]).toContain('No se encontró una lista de precios');
  });

  it('no emite líneas con cantidad cero (por día sin Reporte Job)', () => {
    const r = calcularPrefactura({
      ...base,
      diasReporteJob: 0,
      itemsPedido: [pedido('SUP-DIA', 3)],
    });
    expect(r.items).toHaveLength(0);
  });
});

describe('totalizar', () => {
  it('separa servicios y materiales; IVA 15 %, retención de IR 1 % del subtotal y retención de IVA 30 % del IVA', () => {
    const items = calcularPrefactura({
      ...base,
      itemsPedido: [pedido('SUP-DIA', 1), pedido('MAT-1', 4)],
    }).items;
    const t = totalizar(items, TASAS);
    // servicios 3 x 437,23 = 1311,69; materiales 4 x 50 = 200
    expect(t.subtotalServicios).toBe(1311.69);
    expect(t.subtotalMateriales).toBe(200);
    expect(t.subtotal).toBe(1511.69);
    expect(t.iva).toBe(226.75);
    expect(t.retencionIr).toBe(15.12);
    expect(t.retencionIva).toBe(68.03);
    expect(t.netoCobrar).toBe(redondear(1511.69 + 226.75 - 15.12 - 68.03));
  });

  it('con otras tasas vigentes usa las que se le pasan', () => {
    const t = totalizar(calcularPrefactura({ ...base, itemsPedido: [pedido('MOV', 1)] }).items, {
      ivaPct: 12,
      retencionIrPct: 2,
      retencionIvaPct: 70,
    });
    expect(t).toMatchObject({
      subtotal: 200,
      iva: 24,
      retencionIr: 4,
      retencionIva: 16.8,
      netoCobrar: 203.2,
    });
  });
});
