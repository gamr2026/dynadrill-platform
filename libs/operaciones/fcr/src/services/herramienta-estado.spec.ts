import { clavesDeUnidad, estadoDeHerramienta, type MarcasHerramienta } from './herramienta-estado';

const ahora = new Date('2026-11-05T10:00:00Z');
const vacia: MarcasHerramienta = {
  solicitadaAt: null,
  preparadaAt: null,
  bodegaNovedad: null,
  enviadaAt: null,
  recibidaAt: null,
  recepcionNovedad: null,
  devueltaAt: null,
  faltanteAt: null,
};

describe('estadoDeHerramienta', () => {
  it('sigue el recorrido de Bodega y del Supervisor', () => {
    expect(estadoDeHerramienta(vacia)).toBe('seleccionada');
    const solicitada = { ...vacia, solicitadaAt: ahora };
    expect(estadoDeHerramienta(solicitada)).toBe('solicitada');
    const preparada = { ...solicitada, preparadaAt: ahora };
    expect(estadoDeHerramienta(preparada)).toBe('preparada');
    const enviada = { ...preparada, enviadaAt: ahora };
    expect(estadoDeHerramienta(enviada)).toBe('enviada');
    const recibida = { ...enviada, recibidaAt: ahora };
    expect(estadoDeHerramienta(recibida)).toBe('recibida');
    expect(estadoDeHerramienta({ ...recibida, devueltaAt: ahora })).toBe('devuelta');
    expect(estadoDeHerramienta({ ...recibida, faltanteAt: ahora })).toBe('faltante');
  });

  it('una novedad detiene la herramienta en su paso', () => {
    const solicitada = { ...vacia, solicitadaAt: ahora };
    expect(estadoDeHerramienta({ ...solicitada, bodegaNovedad: 'sin sello' })).toBe(
      'novedad_bodega',
    );
    const enviada = { ...solicitada, preparadaAt: ahora, enviadaAt: ahora };
    expect(estadoDeHerramienta({ ...enviada, recepcionNovedad: 'golpe en la rosca' })).toBe(
      'novedad_recepcion',
    );
  });
});

describe('clavesDeUnidad', () => {
  it('quita tildes, mayúsculas y el plural', () => {
    expect(clavesDeUnidad('Días')).toEqual(['dias', 'dia']);
    expect(clavesDeUnidad(' DIA ')).toEqual(['dia']);
    expect(clavesDeUnidad('Horas')).toContain('hora');
    expect(clavesDeUnidad('Semanas')).toContain('semana');
    expect(clavesDeUnidad('Meses')).toContain('mes');
    expect(clavesDeUnidad('Corrida')).toEqual(['corrida']);
    expect(clavesDeUnidad('Mes')).toEqual(['mes']);
  });
});
