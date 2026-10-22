import { armarCorreoDeEncuesta, descripcionDelServicio } from './correo-encuesta';

const venceAt = new Date('2026-11-06T15:30:00Z'); // 10:30 en Guayaquil

describe('correo de la encuesta', () => {
  it('lleva el enlace con el token, el botón y la vigencia, hablando de «usted»', () => {
    const c = armarCorreoDeEncuesta({
      para: 'cliente@empresa.com',
      token: 'TOKEN_DE_PRUEBA',
      venceAt,
      titulo: 'Encuesta',
      contexto: { ticketNumero: 4551, cliente: 'Petro Andes', pozo: 'SACHA-12' },
    });
    expect(c.para).toBe('cliente@empresa.com');
    expect(c.enlace).toBe('/encuesta/TOKEN_DE_PRUEBA');
    expect(c.textoBoton).toBe('Responder la encuesta');
    expect(c.asunto).toBe('Su opinión sobre el servicio de Dynadrill');
    expect(c.texto).toContain('el servicio N.º 4551 · pozo SACHA-12');
    expect(c.texto).toContain('Estimados de Petro Andes:');
    expect(c.texto).toContain('se puede usar una sola vez y vence el');
    expect(c.texto).toMatch(/6 de noviembre de 2026/);
    expect(c.texto).toMatch(/10:30/);
    expect(c.texto).not.toMatch(/\b(vos|tenés|podés|hacé)\b/i);
    // el token solo va en el enlace del botón, no en el texto que se imprime
    expect(c.texto).not.toContain('TOKEN_DE_PRUEBA');
    expect(c.html).not.toContain('TOKEN_DE_PRUEBA');
  });

  it('sin datos del servicio usa una frase general (un reenvío solo conoce el módulo)', () => {
    expect(descripcionDelServicio({})).toBe('su servicio');
    expect(descripcionDelServicio({ ticketNumero: 12 })).toBe('el servicio N.º 12');
    const c = armarCorreoDeEncuesta({ para: 'a@b.co', token: 'T', venceAt, titulo: 'x' });
    expect(c.texto).toContain('para su servicio.');
    expect(c.texto.startsWith('Estimado cliente:')).toBe(true);
  });

  it('escapa los datos del servicio: un nombre con etiquetas no llega como código', () => {
    const c = armarCorreoDeEncuesta({
      para: 'a@b.co',
      token: 'T',
      venceAt,
      titulo: 'x',
      contexto: { cliente: '<script>alert(1)</script>', pozo: 'A&B' },
    });
    expect(c.html).not.toContain('<script>');
    expect(c.html).toContain('&lt;script&gt;');
    expect(c.html).toContain('A&amp;B');
  });
});
