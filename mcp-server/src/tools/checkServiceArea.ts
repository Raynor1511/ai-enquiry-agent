import { z } from "zod";
import { formatGbp } from "../domain/format.js";
import { parseUkPostcode } from "../domain/postcode.js";
import type { Zone } from "../data/types.js";
import type { ToolDeps } from "./deps.js";

export const checkServiceAreaInput = {
  postcode: z.string().min(1).max(16).describe("UK postcode (e.g. 'BS6 6AL') or just the district (e.g. 'BS6')."),
};

const schema = z.object(checkServiceAreaInput);
export type CheckServiceAreaArgs = z.infer<typeof schema>;

export const checkServiceAreaDescription =
  "Check whether a UK postcode is in the business's service area, which zone it is in, any travel charge, and the emergency response target.";

export interface CheckServiceAreaResult {
  input: string;
  valid: boolean;
  postcode: string | null;
  district: string | null;
  covered: boolean | null;
  zone: Zone | null;
  area_name: string | null;
  travel_surcharge: number | null;
  emergency_response_target_minutes: number | null;
  message: string;
}

export async function checkServiceArea(deps: ToolDeps, args: CheckServiceAreaArgs): Promise<CheckServiceAreaResult> {
  const parsed = parseUkPostcode(args.postcode);
  const base = { input: args.postcode };
  if (!parsed) {
    return {
      ...base,
      valid: false,
      postcode: null,
      district: null,
      covered: null,
      zone: null,
      area_name: null,
      travel_surcharge: null,
      emergency_response_target_minutes: null,
      message: "This is not a valid UK postcode. Ask the customer to confirm their postcode.",
    };
  }

  const district = await deps.store.getDistrict(parsed.outward);
  if (!district) {
    return {
      ...base,
      valid: true,
      postcode: parsed.normalised,
      district: parsed.outward,
      covered: false,
      zone: null,
      area_name: null,
      travel_surcharge: null,
      emergency_response_target_minutes: null,
      message: `${parsed.outward} is outside our service area. Politely explain we don't cover this area; do not offer a booking.`,
    };
  }

  const surcharge = district.travel_surcharge;
  return {
    ...base,
    valid: true,
    postcode: parsed.normalised,
    district: district.district,
    covered: true,
    zone: district.zone,
    area_name: district.area_name,
    travel_surcharge: surcharge,
    emergency_response_target_minutes: district.response_target_minutes,
    message:
      surcharge > 0
        ? `Covered (extended area: ${district.area_name}). A ${formatGbp(surcharge)} travel charge applies per visit.`
        : `Covered (core area: ${district.area_name}). No travel charge.`,
  };
}
