import { PLANTILLAS_MANTENIMIENTO } from './catalog/plantillas/mantenimiento';
import { renderizar } from './plantillas';

const DATOS = {
  nombre: 'X',
  cargo: 'Jefe',
  codigo: 'RU-1',
  origen: 'Llegada',
  ticketNumero: '10',
  unidad: 'GSI6538',
  ordenCodigo: 'RU-1',
  subordenCodigo: 'RU-1-M',
  tipoNombre: 'Mecánico',
  estadoFinalNombre: 'Disponible',
};

describe('plantillas de Mantenimiento', () => {
  it('cada plantilla se completa con los datos del evento: no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_MANTENIMIENTO.length).toBeGreaterThanOrEqual(7);
    for (const p of PLANTILLAS_MANTENIMIENTO) {
      for (const t of [p.asunto, p.cuerpoHtml, p.cuerpoTexto, p.tituloAviso, p.detalleAviso]) {
        expect(renderizar(t, DATOS, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect(Object.keys(DATOS)).toContain(v);
      }
      expect(p.evento).toMatch(/^operaciones\.mantenimiento\./);
    }
  });

  it('los códigos de plantilla no se repiten', () => {
    const c = PLANTILLAS_MANTENIMIENTO.map((p) => p.codigo);
    expect(new Set(c).size).toBe(c.length);
  });
});
