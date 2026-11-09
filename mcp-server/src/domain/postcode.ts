export interface ParsedPostcode {
  /** Uppercased with a single space, e.g. "BS6 6AL"; just the outward code when only that was given. */
  normalised: string;
  /** The district part before the space, e.g. "BS6". Coverage is decided on this. */
  outward: string;
  /** e.g. "6AL", or null when only the outward code was supplied. */
  inward: string | null;
}

// Standard UK format: outward = 1-2 letters, a digit, optional letter/digit; inward = digit + 2 letters.
const FULL = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/;
const OUTWARD_ONLY = /^[A-Z]{1,2}\d[A-Z\d]?$/;

/** Parse a UK postcode or outward code. Returns null when the text is not a plausible UK postcode. */
export function parseUkPostcode(input: string): ParsedPostcode | null {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length === 0 || compact.length > 7) return null;

  const full = FULL.exec(compact);
  if (full) {
    const outward = full[1]!;
    const inward = full[2]!;
    return { normalised: `${outward} ${inward}`, outward, inward };
  }
  if (OUTWARD_ONLY.test(compact)) {
    return { normalised: compact, outward: compact, inward: null };
  }
  return null;
}
