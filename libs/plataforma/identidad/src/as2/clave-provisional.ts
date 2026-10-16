const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Clave provisional de una cuenta nueva: las iniciales de todos sus nombres y apellidos, en mayúsculas, más `123*`.
 * Ej.: "Alfredo Raúl" "Guerrón Sandoval" → `ARGS123*`. Es FÁCIL DE ADIVINAR a propósito (decisión del 13/10/2026,
 * por practicidad); por eso la cuenta nace inactiva, la clave solo sirve hasta el primer ingreso (el sistema obliga a
 * cambiarla) y no debe activarse hasta el momento de entregársela a su dueño.
 */
export function claveProvisional(nombres: string, apellidos: string): string {
  const iniciales = sinTildes(`${nombres} ${apellidos}`)
    .split(/\s+/)
    .map((p) =>
      p
        .replace(/[^A-Za-z]/g, '')
        .charAt(0)
        .toUpperCase(),
    )
    .filter(Boolean)
    .join('');
  return `${iniciales}123*`;
}
