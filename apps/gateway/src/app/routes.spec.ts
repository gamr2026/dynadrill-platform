import { isPublicPath, resolveTarget, TargetUrls } from './routes';

const all: TargetUrls = {
  plataforma: 'http://plataforma',
  comercial: 'http://comercial',
  operaciones: 'http://operaciones',
  qhse: 'http://qhse',
};

describe('resolveTarget', () => {
  it.each([
    ['/api/auth/login', 'plataforma'],
    ['/api/users/123', 'plataforma'],
    ['/api/roles/operador/usuarios', 'plataforma'],
    ['/api/roles/abc/permisos', 'plataforma'],
    ['/api/permissions', 'plataforma'],
    ['/api/directorio/usuarios', 'plataforma'],
    ['/api/as2/empleados', 'plataforma'],
    ['/api/as2/crear-cuentas', 'plataforma'],
    ['/api/integraciones/proveedores', 'plataforma'],
    ['/api/archivos/123/contenido', 'plataforma'],
    ['/api/v2/catalogos/clientes', 'plataforma'], // catálogos (UUID)
    ['/api/comercial/secuencias', 'comercial'],
    ['/api/avisos', 'plataforma'],
    ['/api/auditoria', 'plataforma'],
    ['/api/firmas', 'plataforma'],
    ['/api/encuestas', 'plataforma'],
    ['/api/operaciones/pumping/tickets', 'operaciones'],
    ['/api/v2/qhse/epi', 'qhse'],
  ])('%s → %s', (path, expected) => {
    expect(resolveTarget(path, all)?.name).toBe(expected);
  });

  it.each([
    '/api/facturacion/pedidos',
    '/api/operations/pumping/tickets',
    '/api/unidades',
    '/api/qhse/ptw',
    '/api/catalogos/pozos',
    '/api/files/uploads',
    '/api/algo-nuevo',
  ])('%s ya no lo atiende nadie (404): la demo se retiró', (path) => {
    expect(resolveTarget(path, all)).toBeNull();
  });

  it('un contenedor sin URL deja sus rutas sin atender', () => {
    expect(resolveTarget('/api/auth/login', {})).toBeNull();
    expect(resolveTarget('/api/comercial/pedidos', { plataforma: 'http://p' })).toBeNull();
    expect(resolveTarget('/api/auth/login', { plataforma: 'http://p' })?.name).toBe('plataforma');
  });

  it('no confunde prefijos parecidos', () => {
    expect(resolveTarget('/api/authors', all)).toBeNull();
    expect(resolveTarget('/api/usersx', all)).toBeNull();
  });
});

describe('isPublicPath', () => {
  it('solo login, refresh y jwks son públicos', () => {
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/refresh')).toBe(true);
    expect(isPublicPath('/api/auth/jwks')).toBe(true);
    expect(isPublicPath('/api/auth/me')).toBe(false);
    expect(isPublicPath('/api/auth/login/otro')).toBe(false);
  });

  it('el formulario público de una encuesta (con su token) pasa sin sesión; el resto de encuestas no', () => {
    const token = 'A'.repeat(43);
    expect(isPublicPath(`/api/encuestas/publico/${token}`)).toBe(true);
    expect(isPublicPath('/api/encuestas/publico/')).toBe(false);
    expect(isPublicPath('/api/encuestas/publico/corto')).toBe(false);
    expect(isPublicPath(`/api/encuestas/publico/${token}/otro`)).toBe(false);
    expect(isPublicPath(`/api/encuestas/publico/${token}x/../../invitaciones`)).toBe(false);
    expect(isPublicPath('/api/encuestas')).toBe(false);
    expect(isPublicPath('/api/encuestas/invitaciones')).toBe(false);
  });
});
