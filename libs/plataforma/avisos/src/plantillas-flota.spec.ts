import { PLANTILLAS_FLOTA } from './catalog/plantillas/flota';
import { renderizar } from './plantillas';

/** Los campos que Flota pone en sus eventos con aviso, más `nombre` y `cargo` que agrega el servicio de avisos. */
const DATOS = {
  nombre: 'X',
  cargo: 'Supervisor',
  codigo: 'GV-0001',
  tipoTexto: 'de salida',
  nivelTexto: 'MEDIO',
  puntaje: '40',
  conductor: 'Carlos Conductor',
  unidad: 'CAM-04',
  fecha: '2026-10-18',
  resultado: 'autorizado',
  motivoTexto: ' Motivo: prueba.',
  unidadCodigo: 'CAM-04',
};

describe('plantillas de Flota', () => {
  it('cada plantilla se completa con los datos del evento: no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_FLOTA.length).toBeGreaterThanOrEqual(6);
    for (const p of PLANTILLAS_FLOTA) {
      for (const t of [p.asunto, p.cuerpoHtml, p.cuerpoTexto, p.tituloAviso, p.detalleAviso]) {
        expect(renderizar(t, DATOS, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect(Object.keys(DATOS)).toContain(v);
      }
      expect(p.evento).toMatch(/^flota\./);
    }
  });

  it('los códigos de plantilla no se repiten y cada evento tiene a quién avisar', () => {
    const c = PLANTILLAS_FLOTA.map((p) => p.codigo);
    expect(new Set(c).size).toBe(c.length);
    const reglas = PLANTILLAS_FLOTA.map((p) => `${p.evento}|${p.rol}`);
    expect(new Set(reglas).size).toBe(reglas.length);
  });

  it('el supervisor recibe los viajes que le tocan y el gerente los suyos', () => {
    const roles = (evento: string) =>
      PLANTILLAS_FLOTA.filter((p) => p.evento === evento).map((p) => p.rol);
    expect(roles('flota.gerenciamiento_viaje.por_autorizar_supervisor')).toEqual([
      'supervisor_pumping',
      'supervisor',
    ]);
    expect(roles('flota.gerenciamiento_viaje.por_autorizar_gerente')).toEqual([
      'gerente_hse',
      'jefe_base',
    ]);
  });
});
