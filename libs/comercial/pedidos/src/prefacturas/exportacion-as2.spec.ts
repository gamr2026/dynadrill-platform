import { CABECERA_AS2, filasParaAs2 } from './exportacion-as2';

describe('exportación a AS2', () => {
  it('usa las columnas de la plantilla "AS2 Prefactura Cliente"', () => {
    expect([...CABECERA_AS2]).toEqual([
      'Codigo Producto AS2',
      'Codigo Unidad AS2',
      'Cantidad',
      'Descripción',
      'Precio',
      'Porcentaje Descuento',
    ]);
  });

  it('convierte las unidades conocidas, copia las líneas y avisa de lo que AS2 no reconocerá', () => {
    const { filas, advertencias } = filasParaAs2([
      {
        codigo: 'SFS6218',
        descripcion: 'Cargo',
        unidad: 'Unidad',
        cantidad: 2,
        precioUnitario: 100,
        descuentoPct: 10,
      },
      {
        codigo: 'SUP-1',
        descripcion: 'Supervisor',
        unidad: 'día',
        cantidad: 3,
        precioUnitario: 437.23,
        descuentoPct: null,
      },
      {
        codigo: null,
        descripcion: 'Sin código',
        unidad: 'UN',
        cantidad: 1,
        precioUnitario: 5,
        descuentoPct: null,
      },
    ]);
    expect(filas).toEqual([
      {
        codigoProducto: 'SFS6218',
        codigoUnidad: 'UN',
        cantidad: 2,
        descripcion: 'Cargo',
        precio: 100,
        porcentajeDescuento: 10,
      },
      {
        codigoProducto: 'SUP-1',
        codigoUnidad: 'día',
        cantidad: 3,
        descripcion: 'Supervisor',
        precio: 437.23,
        porcentajeDescuento: 0,
      },
      {
        codigoProducto: '',
        codigoUnidad: 'UN',
        cantidad: 1,
        descripcion: 'Sin código',
        precio: 5,
        porcentajeDescuento: 0,
      },
    ]);
    expect(advertencias).toEqual([
      '"Sin código" no tiene código: AS2 no podrá reconocer el producto',
      'Unidades sin código de AS2 confirmado (se exportan tal cual): día',
    ]);
  });

  it('sin avisos cuando todo es reconocible', () => {
    expect(
      filasParaAs2([
        {
          codigo: 'A',
          descripcion: 'x',
          unidad: 'Unidad',
          cantidad: 1,
          precioUnitario: 1,
          descuentoPct: 0,
        },
      ]).advertencias,
    ).toEqual([]);
  });
});
