import { isPublicPath, resolveTarget, TargetUrls } from './routes';

const all: TargetUrls = {
  legacy: 'http://legacy',
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
    ['/api/v2/catalogos/clientes', 'plataforma'], // catálogos nuevos (UUID); /api/catalogos sigue en la demo
    ['/api/comercial/secuencias', 'comercial'],
    ['/api/facturacion/pedidos', 'legacy'], // hasta el corte de Pedidos
    ['/api/avisos', 'plataforma'],
    ['/api/operaciones/pumping/tickets', 'operaciones'],
    ['/api/operations/pumping/tickets', 'legacy'],
    ['/api/unidades', 'legacy'],
    ['/api/qhse/ptw', 'qhse'],
  ])('%s → %s', (path, expected) => {
    expect(resolveTarget(path, all).name).toBe(expected);
  });

  it('catálogos y archivos siguen en demo-legacy hasta que existan sus módulos', () => {
    expect(resolveTarget('/api/catalogos/pozos', all).name).toBe('legacy');
    expect(resolveTarget('/api/files/uploads', all).name).toBe('legacy');
  });

  it('lo no asignado cae en demo-legacy', () => {
    expect(resolveTarget('/api/algo-nuevo', all)).toEqual({ name: 'legacy', url: 'http://legacy' });
  });

  it('un contenedor sin URL deja sus rutas en demo-legacy', () => {
    const soloLegacy: TargetUrls = { legacy: 'http://legacy' };
    expect(resolveTarget('/api/auth/login', soloLegacy).name).toBe('legacy');
    expect(
      resolveTarget('/api/facturacion/pedidos', { ...soloLegacy, plataforma: 'http://p' }).name,
    ).toBe('legacy');
  });

  it('no confunde prefijos parecidos', () => {
    expect(resolveTarget('/api/authors', all).name).toBe('legacy');
    expect(resolveTarget('/api/usersx', all).name).toBe('legacy');
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
});
