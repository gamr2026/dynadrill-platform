import { PLANTILLAS_QHSE } from './catalog/plantillas/qhse';
import { PLANTILLAS_QHSE_EMERGENCIAS } from './catalog/plantillas/qhse-emergencias';
import { renderizar } from './plantillas';

/** Los campos que Emergencias pone en sus eventos con aviso, más `nombre` y `cargo` que agrega el servicio de avisos. */
const DATOS = {
  nombre: 'X',
  cargo: 'Gerente HSE',
  codigo: 'EME-000001',
  tipoNombre: 'Incendio',
  descripcion: 'Incendio en el generador',
  ubicacion: 'Locación 3',
  ticketNumero: '4531',
  pedidoCodigo: 'PED-100',
  cliente: 'Cliente de prueba',
  activadoPor: 'Oscar Operador',
};

describe('plantillas de avisos de Emergencias (QHSE)', () => {
  it('cada plantilla se completa con los datos del evento: no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_QHSE_EMERGENCIAS.length).toBeGreaterThanOrEqual(2);
    for (const p of PLANTILLAS_QHSE_EMERGENCIAS) {
      for (const t of [p.asunto, p.cuerpoHtml, p.cuerpoTexto, p.tituloAviso, p.detalleAviso]) {
        expect(renderizar(t, DATOS, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect(Object.keys(DATOS)).toContain(v);
      }
      expect(p.evento).toMatch(/^qhse\.emergencia\./);
    }
  });

  it('los códigos y las reglas no se repiten, y están incluidas en las de QHSE', () => {
    const c = PLANTILLAS_QHSE.map((p) => p.codigo);
    expect(new Set(c).size).toBe(c.length);
    const reglas = PLANTILLAS_QHSE_EMERGENCIAS.map((p) => `${p.evento}|${p.rol}`);
    expect(new Set(reglas).size).toBe(reglas.length);
    for (const p of PLANTILLAS_QHSE_EMERGENCIAS) expect(PLANTILLAS_QHSE).toContain(p);
  });

  it('el equipo HSE recibe la activación y el texto usa «usted»', () => {
    expect(
      PLANTILLAS_QHSE_EMERGENCIAS.filter((p) => p.evento === 'qhse.emergencia.activada').map(
        (p) => p.rol,
      ),
    ).toEqual(['tecnico_hse', 'gerente_hse']);
    for (const p of PLANTILLAS_QHSE_EMERGENCIAS)
      expect(`${p.cuerpoHtml} ${p.cuerpoTexto}`).not.toMatch(
        /\b(vos|tenés|declará|hacé|completá|notificá)\b/i,
      );
  });
});
