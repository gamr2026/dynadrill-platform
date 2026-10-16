/**
 * Dinero sin coma flotante (documento de BD: `numeric(14,2)`, "nunca float").
 * Los montos viajan como texto decimal (`"1234.50"`) y se operan en centavos enteros.
 */
const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function moneyToCents(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = MONEY_RE.exec(text);
  if (!m) throw new RangeError(`Monto inválido: ${String(value)}`);
  const [, sign, whole, frac = ''] = m;
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return sign ? -cents : cents;
}

export function centsToMoney(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function addMoney(...values: Array<string | number>): string {
  return centsToMoney(values.reduce<bigint>((acc, v) => acc + moneyToCents(v), 0n));
}

/** Porcentaje (p. ej. IVA 15) aplicado a un monto, redondeado al centavo (half-up). */
export function percentOfMoney(amount: string | number, percent: string | number): string {
  const cents = moneyToCents(amount);
  const basisPoints = moneyToCents(percent); // el porcentaje con 2 decimales, en centésimas
  const product = cents * basisPoints; // centavos × (porcentaje × 100)
  const half = product < 0n ? -5000n : 5000n;
  return centsToMoney((product + half) / 10000n);
}
