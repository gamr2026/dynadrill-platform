import { PLANTILLAS_QHSE_VENCIMIENTOS } from './catalog/plantillas/qhse-vencimientos';
import { PLANTILLAS } from './catalog/plantillas';
import { SUSCRIPCIONES } from './consumers/eventos-con-aviso.consumer';
import { renderizar } from './plantillas';

/** Datos que cada evento de QHSE pone (los mismos que arma el emisor programado y el ciclo de la investigación) y que sus plantillas pueden usar. */
const ART = [
  'documentoId',
  'pedidoId',
  'pedidoCodigo',
  'cliente',
  'campo',
  'pozo',
  'vigenteHasta',
  'diasParaVencer',
];
const LEGAL = [
  'requisitoLegalId',
  'tipo',
  'tipoNombre',
  'revision',
  'vigenteHasta',
  'diasParaVencer',
];
const INVESTIGACION_VENCIDA = [
  'investigacionId',
  'codigo',
  'resultado',
  'resultadoNombre',
  'ubicacion',
  'limite',
];
const ACCION = [
  'investigacionId',
  'investigacionCodigo',
  'accionId',
  'orden',
  'descripcion',
  'responsable',
  'plazo',
];
const OBJETIVO = ['objetivoId', 'codigo', 'titulo', 'plazo', 'diasParaVencer'];
const CICLO = [
  'investigacionId',
  'numero',
  'codigo',
  'estado',
  'resultado',
  'resultadoNombre',
  'involucraLesionado',
  'fechaIncidente',
  'conclusion',
  'totalDiasIncapacidad',
  'origenEmergenciaId',
  'liderId',
  'ubicacion',
  'inicioLimite',
  'finalLimite',
  'observacion',
];
const DATOS_DEL_EVENTO: Record<string, string[]> = {
  'qhse.aviso.art_por_vencer': ART,
  'qhse.aviso.art_vencido': ART,
  'qhse.aviso.requisito_legal_por_vencer': LEGAL,
  'qhse.aviso.requisito_legal_vencido': LEGAL,
  'qhse.aviso.inspeccion_vencida': [
    'inspeccionId',
    'codigo',
    'tipoNombre',
    'equipoCodigo',
    'vigenteHasta',
  ],
  'qhse.aviso.investigacion_inicio_vencido': INVESTIGACION_VENCIDA,
  'qhse.aviso.investigacion_final_por_vencer': [...INVESTIGACION_VENCIDA, 'diasParaVencer'],
  'qhse.aviso.investigacion_final_vencido': [...INVESTIGACION_VENCIDA, 'diasParaVencer'],
  'qhse.aviso.accion_investigacion_vencida': ACCION,
  'qhse.aviso.accion_investigacion_vencida_responsable': ACCION,
  'qhse.aviso.objetivo_ambiental_por_vencer': OBJETIVO,
  'qhse.aviso.objetivo_ambiental_vencido': OBJETIVO,
  'qhse.aviso.control_ambiental_vencido': [
    'aspectoId',
    'codigo',
    'actividad',
    'clasificacion',
    'plazo',
  ],
  'qhse.investigacion.abierta': CICLO,
  'qhse.investigacion.enviada_a_revision': CICLO,
  'qhse.investigacion.devuelta': CICLO,
};
/** Los agrega el servicio de avisos por cada destinatario. */
const DE_LA_PERSONA = ['nombre', 'cargo', 'rol'];

describe('plantillas de QHSE: vencimientos e investigación', () => {
  it('cada plantilla solo usa datos que su evento trae (o los de la persona): no queda ninguna variable sin reemplazar', () => {
    expect(PLANTILLAS_QHSE_VENCIMIENTOS.length).toBeGreaterThanOrEqual(20);
    for (const p of PLANTILLAS_QHSE_VENCIMIENTOS) {
      const permitidas = [...(DATOS_DEL_EVENTO[p.evento] ?? []), ...DE_LA_PERSONA];
      expect([p.evento, Object.keys(DATOS_DEL_EVENTO)]).toEqual([
        p.evento,
        expect.arrayContaining([p.evento]),
      ]);
      const datos = Object.fromEntries(permitidas.map((k) => [k, 'x']));
      for (const t of [
        p.asunto,
        p.cuerpoHtml,
        p.cuerpoTexto,
        p.tituloAviso,
        p.detalleAviso,
        p.enlaceAviso,
      ]) {
        expect(renderizar(t, datos, true)).not.toContain('{{');
        for (const [, v] of t.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))
          expect([p.codigo, permitidas]).toEqual([p.codigo, expect.arrayContaining([v])]);
      }
    }
  });

  it('los códigos de plantilla y las reglas (evento + rol) no se repiten, y todos los eventos de DATOS_DEL_EVENTO tienen plantilla', () => {
    const codigos = PLANTILLAS_QHSE_VENCIMIENTOS.map((p) => p.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    const reglas = PLANTILLAS_QHSE_VENCIMIENTOS.map((p) => `${p.evento}|${p.rol}`);
    expect(new Set(reglas).size).toBe(reglas.length);
    const conPlantilla = new Set(PLANTILLAS_QHSE_VENCIMIENTOS.map((p) => p.evento));
    expect([...conPlantilla].sort()).toEqual(Object.keys(DATOS_DEL_EVENTO).sort());
  });

  it('los avisos de vencimiento van al equipo HSE; el de la persona responsable, solo a ella (rol de la asignación)', () => {
    const roles = (evento: string) =>
      PLANTILLAS_QHSE_VENCIMIENTOS.filter((p) => p.evento === evento).map((p) => p.rol);
    expect(roles('qhse.aviso.art_vencido')).toEqual(['tecnico_hse', 'gerente_hse']);
    expect(roles('qhse.aviso.accion_investigacion_vencida')).toEqual([
      'tecnico_hse',
      'gerente_hse',
    ]);
    expect(roles('qhse.aviso.accion_investigacion_vencida_responsable')).toEqual([
      'responsable_accion',
    ]);
    // el Gerente HSE revisa el informe; el Técnico recibe lo que se le devuelve
    expect(roles('qhse.investigacion.enviada_a_revision')).toEqual(['gerente_hse']);
    expect(roles('qhse.investigacion.devuelta')).toEqual(['tecnico_hse']);
    // nada de esto es del Supervisor (no entra a QHSE) ni de desechos (es de otra sesión)
    expect(PLANTILLAS_QHSE_VENCIMIENTOS.some((p) => p.rol === 'supervisor')).toBe(false);
    expect(PLANTILLAS_QHSE_VENCIMIENTOS.some((p) => /desecho/i.test(p.evento))).toBe(false);
  });

  it('el consumidor de avisos está suscrito a todos los eventos de estas plantillas y el catálogo general las incluye', () => {
    const patrones = SUSCRIPCIONES.find((s) => s.source === 'qhse')?.patterns ?? [];
    for (const p of PLANTILLAS_QHSE_VENCIMIENTOS)
      expect([p.evento, patrones]).toEqual([p.evento, expect.arrayContaining([p.evento])]);
    for (const p of PLANTILLAS_QHSE_VENCIMIENTOS)
      expect(PLANTILLAS.map((x) => x.codigo)).toContain(p.codigo);
  });

  it('los tonos distinguen lo vencido (error) de lo por vencer (advertencia)', () => {
    const tono = (evento: string) =>
      PLANTILLAS_QHSE_VENCIMIENTOS.find((p) => p.evento === evento)?.tono;
    expect(tono('qhse.aviso.art_por_vencer')).toBe('warning');
    expect(tono('qhse.aviso.art_vencido')).toBe('error');
    expect(tono('qhse.aviso.requisito_legal_vencido')).toBe('error');
    expect(tono('qhse.aviso.objetivo_ambiental_por_vencer')).toBe('warning');
  });
});
