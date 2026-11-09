/**
 * Normalise a UK phone number to national digits, e.g. "+44 (0)7700 900102" -> "07700900102".
 * Mirrors the SQL function `normalise_uk_phone(text)` in seed/sql/001_schema.sql.
 * Returns null when there are too few digits to be a phone number.
 */
export function normaliseUkPhone(input: string): string | null {
  let digits = input.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (digits.startsWith("0044")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("44") && digits.length === 12) digits = "0" + digits.slice(2);
  if (digits.length < 10 || digits.length > 11) return null;
  return digits;
}
