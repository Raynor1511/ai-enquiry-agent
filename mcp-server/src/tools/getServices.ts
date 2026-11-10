import { z } from "zod";
import { priceDisplay } from "../domain/format.js";
import { contentStems, stemPhrase } from "../domain/text.js";
import type { Policy, Service, ServiceCategory } from "../data/types.js";
import type { ToolDeps } from "./deps.js";

const CATEGORIES = ["heating", "gas", "plumbing", "bathrooms", "emergency"] as const;

export const getServicesInput = {
  query: z.string().max(500).optional().describe("What the customer needs in plain words, e.g. 'boiler making banging noise' or 'new bathroom'. Omit to get the full price list."),
  category: z.enum(CATEGORIES).optional().describe("Restrict to one service category."),
  service_ids: z.array(z.string().max(64)).max(20).optional().describe("Fetch specific services by id, e.g. ids seen in a customer's job history."),
  include_policies: z.boolean().optional().describe("Include the policies relevant to the returned services (default true)."),
  limit: z.number().int().min(1).max(25).optional().describe("Maximum services to return (default 5; ignored for the full price list)."),
};

const schema = z.object(getServicesInput);
export type GetServicesArgs = z.infer<typeof schema>;

export const getServicesDescription = [
  "Get services from the business's price list with their exact prices, plus the business policies that apply",
  "(call-out fees, emergencies, service area, cancellations, guarantees, quotes, payment).",
  "Quote prices ONLY from this tool's output, using `price_display` and `price_note`. Prices include VAT.",
  "A `price_basis` of `fixed` is a fixed price; ranges and `from` prices are guides, with the final price confirmed on inspection.",
].join(" ");

interface ServiceView {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string;
  price_display: string;
  price_basis: Service["price_basis"];
  price_min: number;
  price_max: number | null;
  price_note: string | null;
  requires_survey: boolean;
  typical_duration_minutes: number | null;
  relevance?: number;
}

export interface GetServicesResult {
  matched: boolean;
  services: ServiceView[];
  policies: Array<Pick<Policy, "id" | "title" | "body">>;
  note?: string;
}

function view(s: Service, relevance?: number): ServiceView {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    price_display: priceDisplay(s),
    price_basis: s.price_basis,
    price_min: s.price_min,
    price_max: s.price_max,
    price_note: s.price_note,
    requires_survey: s.requires_survey,
    typical_duration_minutes: s.typical_duration_minutes,
    ...(relevance !== undefined ? { relevance } : {}),
  };
}

/**
 * Keyword relevance: multi-word keyword phrases found in the query score by their length,
 * single words score 1, words from the service name score 1. Deliberately simple and
 * deterministic so results are explainable; the model chooses among the top results.
 */
export function scoreService(service: Service, queryStems: string[]): number {
  if (queryStems.length === 0) return 0;
  const haystack = ` ${queryStems.join(" ")} `;
  const stemSet = new Set(queryStems);
  let score = 0;
  for (const keyword of service.keywords) {
    const phrase = stemPhrase(keyword);
    if (!phrase) continue;
    const words = phrase.split(" ");
    if (words.length > 1) {
      if (haystack.includes(` ${phrase} `)) score += words.length + 1;
    } else if (stemSet.has(phrase)) {
      score += 1;
    }
  }
  for (const word of contentStems(service.name)) {
    if (stemSet.has(word)) score += 1;
  }
  return score;
}

function relevantPolicies(policies: Policy[], categories: Set<string>): GetServicesResult["policies"] {
  return policies
    .filter((p) => p.applies_to.includes("all") || p.applies_to.some((c) => categories.has(c)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, title, body }) => ({ id, title, body }));
}

/** Price-list order: emergencies first, then by category and name. Independent of the store's row order. */
const CATEGORY_ORDER: Record<ServiceCategory, number> = { emergency: 0, heating: 1, gas: 2, plumbing: 3, bathrooms: 4 };
function priceListOrder(a: Service, b: Service): number {
  return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.name.localeCompare(b.name);
}

export async function getServices(deps: ToolDeps, args: GetServicesArgs): Promise<GetServicesResult> {
  const includePolicies = args.include_policies ?? true;
  const limit = args.limit ?? 5;
  let services = [...(await deps.store.listServices())].sort(priceListOrder);
  if (args.category) services = services.filter((s) => s.category === args.category);

  let selected: ServiceView[];
  let matched = true;
  let note: string | undefined;

  if (args.service_ids?.length) {
    const wanted = new Set(args.service_ids);
    selected = services.filter((s) => wanted.has(s.id)).map((s) => view(s));
    const missing = args.service_ids.filter((id) => !selected.some((s) => s.id === id));
    if (missing.length) note = `Unknown service ids: ${missing.join(", ")}.`;
  } else if (args.query?.trim()) {
    const stems = contentStems(args.query);
    const scored = services
      .map((s) => ({ s, score: scoreService(s, stems) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
      .slice(0, limit);
    if (scored.length) {
      selected = scored.map((x) => view(x.s, x.score));
    } else {
      matched = false;
      selected = services.map((s) => view(s));
      note = "Nothing matched the query, so the full price list is returned. If none of these fit, say we'll confirm after a quick chat or visit; do not invent a price.";
    }
  } else {
    selected = services.map((s) => view(s));
  }

  const categories = new Set(selected.map((s) => s.category));
  const policies = includePolicies ? relevantPolicies(await deps.store.listPolicies(), categories) : [];
  return { matched, services: selected, policies, ...(note ? { note } : {}) };
}
