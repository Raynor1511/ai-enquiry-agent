import type { Service } from "../data/types.js";

/** "£2,400" / "£95" / "£12.50" */
export function formatGbp(amount: number): string {
  const hasPence = Math.round(amount * 100) % 100 !== 0;
  return (
    "£" +
    amount.toLocaleString("en-GB", {
      minimumFractionDigits: hasPence ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

/** Human-readable price exactly as the drafting agent may quote it. */
export function priceDisplay(service: Pick<Service, "price_basis" | "price_min" | "price_max">): string {
  switch (service.price_basis) {
    case "fixed":
      return formatGbp(service.price_min);
    case "range":
      return service.price_max != null && service.price_max !== service.price_min
        ? `${formatGbp(service.price_min)}–${formatGbp(service.price_max)}`
        : formatGbp(service.price_min);
    case "from":
      return `from ${formatGbp(service.price_min)}`;
  }
}

/** "m*****.e***s@example.co.uk" style masking, used when identity is not verified. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local[0] + "*".repeat(Math.max(local.length - 1, 3));
  return `${maskedLocal}@${domain}`;
}

/** Keep only the last three digits: "ending 101". */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length < 4 ? "***" : `ending ${digits.slice(-3)}`;
}
