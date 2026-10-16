/** Cómo se escribe el cuerpo y se lee la respuesta de un proveedor según su formato. */
export interface Formato {
  contentType: string;
  serializar(cuerpo: unknown): string;
  parsear(texto: string): unknown;
}

/**
 * Formatos que el motor sabe hablar. Hoy solo JSON; para XML o SOAP se agrega una entrada aquí y los proveedores
 * con ese `formato` empiezan a funcionar. Mientras tanto un proveedor con otro formato falla con un error claro.
 */
export const FORMATOS: Record<string, Formato> = {
  json: {
    contentType: 'application/json',
    serializar: (cuerpo) => JSON.stringify(cuerpo),
    parsear: (texto) => JSON.parse(texto),
  },
};
