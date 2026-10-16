import { envolverCorreo, escaparHtml, renderizar, variablesDeEvento } from './plantillas';

describe('plantillas de avisos', () => {
  it('reemplaza las variables y deja vacías las desconocidas', () => {
    expect(
      renderizar('Hola {{nombre}}, pedido {{ pedido }} {{noExiste}}!', {
        nombre: 'Cesar',
        pedido: 'PED-1',
      }),
    ).toBe('Hola Cesar, pedido PED-1 !');
  });

  it('escapa los valores en HTML para que un dato nunca llegue como código', () => {
    const r = renderizar(
      '<p>{{cliente}}</p>',
      { cliente: '<script>alert("x")</script> & Cía' },
      true,
    );
    expect(r).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Cía</p>');
    expect(renderizar('{{cliente}}', { cliente: '<b>' })).toBe('<b>');
    expect(escaparHtml("l'a")).toBe('l&#39;a');
  });

  it('aplana los datos del evento: listas con coma, objetos con prefijo, vacíos omitidos', () => {
    expect(
      variablesDeEvento({
        pedido: 'PED-1',
        servicios: ['pumping', 'nitrogeno'],
        cliente: null,
        pozo: '',
        extra: { a: 1 },
        ok: true,
      }),
    ).toEqual({
      pedido: 'PED-1',
      servicios: 'pumping, nitrogeno',
      extra_a: '1',
      ok: 'true',
    });
  });

  it('el marco del correo trae el botón y el aviso de prueba solo cuando corresponde', () => {
    const con = envolverCorreo({
      contenidoHtml: '<p>Hola</p>',
      enlaceUrl: 'http://localhost:4200/x?a=1&b=2',
      avisoPruebas: 'Habría llegado a Cesar',
    });
    expect(con).toContain('Correo de prueba');
    expect(con).toContain('Habría llegado a Cesar');
    expect(con).toContain('href="http://localhost:4200/x?a=1&amp;b=2"');
    const sin = envolverCorreo({ contenidoHtml: '<p>Hola</p>' });
    expect(sin).not.toContain('Correo de prueba');
    expect(sin).not.toContain('<a href');
  });
});
