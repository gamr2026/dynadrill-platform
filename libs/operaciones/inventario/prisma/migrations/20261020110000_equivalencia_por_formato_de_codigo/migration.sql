-- Los códigos de AS2 con espacios se normalizan al cargarlos (el alta de artículos no admite espacios): el código original queda como
-- equivalencia con el motivo «formato». ALTER TYPE ... ADD VALUE va solo en su migración (el valor nuevo no se puede usar en la misma transacción).
ALTER TYPE "motivo_equivalencia" ADD VALUE 'formato';
