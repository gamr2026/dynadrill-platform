import { PLANTILLAS_QHSE } from './catalog/plantillas/qhse';
import { PLANTILLAS_QHSE_DERRAMES } from './catalog/plantillas/qhse-derrames';
import { renderizar } from './plantillas';

/** Los campos que Derrames pone en sus eventos con aviso, más `nombre` y `cargo` que agrega el servicio de avisos. */
const DATOS = {
  nombre: 'X',
  cargo: 'Técnico HSE',
  codigo: 'DER-000001',
  descripcion: 'Fuga de aceite en la línea',
  ubicacionNombre: 'Suelo natural',
  ubicacionFisica: 'Junto a la bomba 2',
  bandaNombre: 'Moderado (1 a 5 barriles)',
  ticketNumero: '4531',
  pedidoCodigo: 'PED-100',
  cliente: 'Cliente de prueba',
  activadoPor: 'Oscar Operador',
};

describe('plantillas de avisos de Derrames (QHSE)', () => {
  it('cada plantilla se completa con los datos del evento: no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_QHSE_DERRAMES.length).toBeGreaterThanOrEqual(2);
    for (const p of PLANTILLAS_QHSE_DERRAMES) {
      for (const t of [p.asunto, p.cuerpoHtml, p.cuerpoTexto, p.tituloAviso, p.detalleAviso]) {
        expect(renderizar(t, DATOS, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect(Object.keys(DATOS)).toContain(v);
      }
      expect(p.evento).toMatch(/^qhse\.derrame\./);
    }
  });

  it('los códigos y las reglas no se repiten, y están incluidas en las de QHSE', () => {
    const c = PLANTILLAS_QHSE.map((p) => p.codigo);
    expect(new Set(c).size).toBe(c.length);
    const reglas = PLANTILLAS_QHSE_DERRAMES.map((p) => `${p.evento}|${p.rol}`);
    expect(new Set(reglas).size).toBe(reglas.length);
    for (const p of PLANTILLAS_QHSE_DERRAMES) expect(PLANTILLAS_QHSE).toContain(p);
  });

  it('el equipo HSE recibe la alerta y el texto usa «usted»', () => {
    expect(
      PLANTILLAS_QHSE_DERRAMES.filter((p) => p.evento === 'qhse.derrame.activado').map(
        (p) => p.rol,
      ),
    ).toEqual(['tecnico_hse', 'gerente_hse']);
    for (const p of PLANTILLAS_QHSE_DERRAMES)
      expect(`${p.cuerpoHtml} ${p.cuerpoTexto}`).not.toMatch(
        /\b(vos|tenés|dirigí|confirmá|avisá|notificá)\b/i,
      );
  });
});
