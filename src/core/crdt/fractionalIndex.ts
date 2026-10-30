/**
 * Fractional indexing for list order.
 *
 * Each card carries a sort key, a string read as a base-62 fraction in
 * [0, 1): "V" ≈ 0.5, "0V" ≈ 0.008 and so on. For any two keys a < b there
 * is always a key strictly between them (the rationals are dense). A card
 * therefore moves by rewriting only its own key, never its siblings' keys,
 * which keeps concurrent moves independent.
 *
 * Concurrent moves into the same gap can produce equal keys. Views break
 * that tie by card id, so every replica still renders an identical order.
 *
 * Invariant: generated keys never end in the zero digit. Otherwise "a0"
 * would equal "a" as a fraction and there'd be no room between them.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const ZERO = DIGITS.charAt(0);

function digitValue(char: string | undefined): number {
  if (char === undefined) return 0;
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new Error(`Invalid fractional index digit "${char}"`);
  return value;
}

/**
 * Returns a key strictly between fractions `a` and `b`, where `b === null`
 * means 1.0. Both inputs must be canonical, meaning no trailing zero digit.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Strip the shared prefix. A missing digit in `a` counts as zero.
    let n = 0;
    while (n < b.length && (a.charAt(n) || ZERO) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = digitValue(a.charAt(0) || undefined);
  const high = b === null ? BASE : digitValue(b.charAt(0));
  if (high - low > 1) {
    // There is a whole digit strictly between them, so take the middle one.
    return DIGITS.charAt(Math.round((low + high) / 2));
  }
  // The leading digits are adjacent.
  if (b !== null && b.length > 1) {
    // b is longer than one digit, so its first digit alone is a key in (a, b).
    return b.slice(0, 1);
  }
  // Keep a's first digit and recurse on the remainder against 1.0.
  return DIGITS.charAt(low) + midpoint(a.slice(1), null);
}

/**
 * Generates a key that sorts strictly between `before` and `after`.
 * Pass `null` for an open end, e.g. `keyBetween(lastKey, null)` to append.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new Error(`keyBetween: "${before}" must sort before "${after}"`);
  }
  return midpoint(before ?? "", after);
}

/** Orders keys with a deterministic tiebreak, for stable rendering on every replica. */
export function compareOrder(aKey: string, aId: string, bKey: string, bId: string): number {
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}
