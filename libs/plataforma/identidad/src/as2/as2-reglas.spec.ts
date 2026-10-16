import { ALL_ROLE_CODES } from '@dyn/authz';
import { correoPorCedulaDe } from '../services/as2-sync.service';
import { sugerirRol } from './rol-por-cargo';

describe('sugerirRol (borrador por cargo de AS2)', () => {
  it.each([
    ['JEFE DE BASE', 'jefe_base'],
    ['GERENTE DE QHSE', 'gerente_hse'],
    ['OPERADOR III CTU', 'operador'],
    ['OPERADOR DE FLUIDOS', 'operador'],
    ['ESPECIALISTA DE CAMPO FCR', 'operador_fcr'],
    ['OPERADOR FISHING', 'operador_fcr'],
    ['TECNICO DE MANTENIMIENTO', 'operador_mantenimiento'],
    ['MECÁNICO', 'operador_mantenimiento'],
    ['SOLDADOR', 'operador_mantenimiento'],
    ['JEFE DE PRE FACTURACIÓN', 'facturacion'],
    ['ESPECIALISTA DE FACTURACION I', 'facturacion'],
    ['BODEGUERO', 'bodeguero'],
    ['INGENIERO DE VENTAS', 'ingenieria_ventas'],
    ['TECNICO DE SEGURIDAD', 'tecnico_hse'],
    ['CONTADORA GENERAL', 'facturacion'],
    ['ANALISTA CONTABLE', 'facturacion'],
    ['ASISTENTE ADMINISTRATIVO', 'facturacion'],
    ['GERENTE DE TALENTO HUMANO', 'tecnico_hse'],
  ])('%s → %s', (cargo, rol) => {
    expect(sugerirRol(cargo)).toEqual({ rol, reconocido: true });
  });

  it('un cargo que ninguna regla reconoce recibe el rol más básico y se marca como no reconocido', () => {
    expect(sugerirRol('TECNICO TIC')).toEqual({ rol: 'operador', reconocido: false });
    expect(sugerirRol(null)).toEqual({ rol: 'operador', reconocido: false });
  });

  it('todos los roles que sugiere existen en el sistema', () => {
    const cargos = [
      'JEFE DE BASE',
      'GERENTE DE QHSE',
      'OPERADOR CTU',
      'FISHING',
      'MECANICO',
      'FACTURACION',
      'BODEGUERO',
      'VENTAS',
      'QHSE',
      'CONDUCTOR',
      'COORDINADOR HSE',
      'JEFE DE MANTENIMIENTO',
    ];
    for (const c of cargos) expect(ALL_ROLE_CODES).toContain(sugerirRol(c).rol);
  });
});

describe('correoPorCedulaDe', () => {
  it('un solo correo por cédula se usa en minúsculas', () => {
    const m = correoPorCedulaDe([
      { identificacion: '1', email: ' Ana.Perez@Dynadrill.com.ec ' },
      { identificacion: '2', email: null },
    ]);
    expect(m.get('1')).toBe('ana.perez@dynadrill.com.ec');
    expect(m.has('2')).toBe(false);
  });

  it('varios correos distintos: se usa el único de Dynadrill; si no hay uno solo, queda sin correo', () => {
    const m = correoPorCedulaDe([
      { identificacion: '1', email: 'ana@gmail.com' },
      { identificacion: '1', email: 'ana@dynadrill.com.ec' },
      { identificacion: '2', email: 'b@dynadrill.com.ec' },
      { identificacion: '2', email: 'b2@dynadrill.com' },
      { identificacion: '3', email: 'c@gmail.com' },
      { identificacion: '3', email: 'c@hotmail.com' },
      { identificacion: '4', email: 'd@dynadrill.com.ec' },
      { identificacion: '4', email: 'D@dynadrill.com.ec' },
    ]);
    expect(m.get('1')).toBe('ana@dynadrill.com.ec');
    expect(m.has('2')).toBe(false); // dos de Dynadrill: ambiguo
    expect(m.has('3')).toBe(false); // ninguno de Dynadrill: ambiguo
    expect(m.get('4')).toBe('d@dynadrill.com.ec'); // el mismo correo repetido no es ambiguo
  });
});
