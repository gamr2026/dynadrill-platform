import { PLANTILLAS_QHSE } from './catalog/plantillas/qhse';
import { PLANTILLAS_QHSE_DESECHOS } from './catalog/plantillas/qhse-desechos';
import { renderizar } from './plantillas';

/** Los campos que Desechos pone en sus eventos de vencimiento, más `nombre` y `cargo` que agrega el servicio de avisos. */
const DATOS = {
  nombre: 'X',
  cargo: 'Técnico HSE',
  codigo: 'DES-000001',
  descripcion: 'Trapos y absorbentes contaminados',
  limiteAlmacenamientoHasta: '2027-10-24',
  diasParaLimite: '12',
  diasVencido: '5',
  manifiestoNumero: 'MAN-001',
  certificadoVenceEl: '2026-11-23',
};

describe('plantillas de avisos de Desechos (QHSE)', () => {
  it('cada plantilla se completa con los datos del evento: no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_QHSE_DESECHOS).toHaveLength(6);
    for (const p of PLANTILLAS_QHSE_DESECHOS) {
      for (const t of [p.asunto, p.cuerpoHtml, p.cuerpoTexto, p.tituloAviso, p.detalleAviso]) {
        expect(renderizar(t, DATOS, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect(Object.keys(DATOS)).toContain(v);
      }
      expect(p.evento).toMatch(/^qhse\.desecho\./);
    }
  });

  it('los códigos no se repiten, el equipo HSE recibe cada evento y están incluidas en las de QHSE', () => {
    const c = PLANTILLAS_QHSE.map((p) => p.codigo);
    expect(new Set(c).size).toBe(c.length);
    for (const evento of [
      'qhse.desecho.limite_proximo',
      'qhse.desecho.limite_vencido',
      'qhse.desecho.certificado_vencido',
    ])
      expect(PLANTILLAS_QHSE_DESECHOS.filter((p) => p.evento === evento).map((p) => p.rol)).toEqual(
        ['tecnico_hse', 'gerente_hse'],
      );
    for (const p of PLANTILLAS_QHSE_DESECHOS) expect(PLANTILLAS_QHSE).toContain(p);
  });

  it('usan el trato de «usted» y no el voseo', () => {
    for (const p of PLANTILLAS_QHSE_DESECHOS)
      expect(`${p.cuerpoHtml} ${p.cuerpoTexto}`).not.toMatch(
        /\b(vos|tenés|gestioná|pedile|registralo|generá)\b/i,
      );
  });
});
