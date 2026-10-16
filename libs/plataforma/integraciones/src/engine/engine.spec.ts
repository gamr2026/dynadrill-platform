import { aplicarMapeo, leerRuta, transformar } from './mapeo';
import { ContextoPlantilla, marcadoresInvalidos, resolver, secretosUsados } from './plantilla';
import { EnvSecretResolver } from './secretos';

const ctx: ContextoPlantilla = {
  param: { cedula: '123' },
  var: { idOrganizacion: 1 },
  secreto: { usuario: 'u', clave: 'p' },
  pagina: { desde: 1000, tamano: 500 },
};

describe('plantillas', () => {
  it('un marcador solo conserva el tipo; dentro de un texto se vuelve texto', () => {
    expect(resolver('{{var.idOrganizacion}}', ctx)).toBe(1);
    expect(resolver('/v2/x/{{param.cedula}}/y', ctx)).toBe('/v2/x/123/y');
    expect(resolver({ a: ['{{pagina.desde}}', { b: '{{secreto.usuario}}' }], c: 5 }, ctx)).toEqual({
      a: [1000, { b: 'u' }],
      c: 5,
    });
  });

  it('un valor faltante o un espacio desconocido es un error, no un texto vacío', () => {
    expect(() => resolver('{{param.otro}}', ctx)).toThrow(/Falta el valor/);
    expect(() => resolver('{{raro.x}}', ctx)).toThrow(/desconocido/);
  });

  it('detecta marcadores inválidos y los secretos que usa una plantilla', () => {
    expect(marcadoresInvalidos({ a: '{{raro.x}} {{var.ok}}' })).toEqual(['{{raro.x}}']);
    expect(
      secretosUsados({ a: '{{secreto.usuario}}', b: ['{{secreto.clave}}', '{{var.x}}'] }).sort(),
    ).toEqual(['clave', 'usuario']);
  });
});

describe('mapeo', () => {
  it('lee rutas con puntos y devuelve undefined si un tramo falta', () => {
    expect(leerRuta({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(leerRuta({ a: null }, 'a.b')).toBeUndefined();
    expect(leerRuta({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('transforma sin lanzar: lo raro se vuelve null', () => {
    expect(transformar(' POR OBRA ', 'texto')).toBe('POR OBRA');
    expect(transformar('  ', 'texto')).toBeNull();
    expect(transformar({}, 'texto')).toBeNull();
    expect(transformar('7', 'entero')).toBe(7);
    expect(transformar('7.5', 'entero')).toBeNull();
    expect(transformar('abc', 'numero')).toBeNull();
    expect(transformar('true', 'booleano')).toBe(true);
    expect(transformar('x', 'booleano')).toBeNull();
    expect(transformar('2026-10-01T10:00:00Z', 'fecha_iso')).toEqual(
      new Date('2026-10-01T10:00:00Z'),
    );
    expect(transformar('no', 'fecha_iso')).toBeNull();
    expect(transformar(1, 'desconocida')).toBeNull();
    expect(transformar(null, 'texto')).toBeNull();
  });

  it('fecha_ms_ec: la medianoche de Ecuador (UTC-5) es el día de calendario', () => {
    expect(transformar(1748754000000, 'fecha_ms_ec')).toEqual(new Date('2025-06-01T00:00:00.000Z'));
    expect(transformar(1629262800000, 'fecha_ms_ec')).toEqual(new Date('2021-08-18T00:00:00.000Z'));
    expect(transformar('x', 'fecha_ms_ec')).toBeNull();
  });

  it('aplicarMapeo traduce una fila y la omite si falta un campo obligatorio', () => {
    const mapeos = [
      { destino: 'id', origen: 'idEmpleado', transformacion: 'entero', obligatorio: true },
      {
        destino: 'cedula',
        origen: 'empresa.identificacion',
        transformacion: 'texto',
        obligatorio: true,
      },
      {
        destino: 'cargo',
        origen: 'cargoEmpleado.nombre',
        transformacion: 'texto',
        obligatorio: false,
      },
    ];
    expect(
      aplicarMapeo({ idEmpleado: 28, empresa: { identificacion: '1714' }, extra: 'x' }, mapeos),
    ).toEqual({
      id: 28,
      cedula: '1714',
      cargo: null,
    });
    expect(aplicarMapeo({ idEmpleado: 28 }, mapeos)).toBeNull();
  });
});

describe('EnvSecretResolver', () => {
  afterEach(() => {
    delete process.env['IT_SECRETO_X'];
    delete process.env['AS2_ES_UN_SECRETO'];
  });
  it('solo entrega variables con un prefijo permitido, no cualquiera del proceso', () => {
    process.env['IT_SECRETO_X'] = 'valor';
    process.env['AS2_ES_UN_SECRETO'] = 'otro';
    const r = new EnvSecretResolver(['IT_']);
    expect(r.resolver('IT_SECRETO_X')).toBe('valor');
    expect(r.resolver('AS2_ES_UN_SECRETO')).toBeUndefined(); // prefijo no permitido
    expect(r.resolver('IT_NO_EXISTE')).toBeUndefined();
    expect(r.resolver('PATH')).toBeUndefined();
    expect(r.resolver('DATABASE_URL')).toBeUndefined();
    expect(r.resolver('IT_X; rm')).toBeUndefined();
  });

  it('por defecto permite AS2_ y no JWT_PRIVATE_KEY ni DATABASE_URL', () => {
    process.env['AS2_ES_UN_SECRETO'] = 'otro';
    const r = new EnvSecretResolver();
    expect(r.resolver('AS2_ES_UN_SECRETO')).toBe('otro');
    expect(r.resolver('JWT_PRIVATE_KEY')).toBeUndefined();
    expect(r.resolver('DATABASE_URL')).toBeUndefined();
  });
});
