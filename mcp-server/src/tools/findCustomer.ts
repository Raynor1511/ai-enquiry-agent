import { z } from "zod";
import { maskEmail, maskPhone } from "../domain/format.js";
import { normaliseUkPhone } from "../domain/phone.js";
import { nameKey } from "../domain/text.js";
import { parseUkPostcode } from "../domain/postcode.js";
import type { Customer, Job, Service } from "../data/types.js";
import { ToolInputError, type ToolDeps } from "./deps.js";

export const findCustomerInput = {
  email: z.string().max(254).optional().describe("Sender's email address, taken from the email headers or form, not from the message text."),
  phone: z.string().max(32).optional().describe("Phone number in any UK format."),
  name: z.string().max(120).optional().describe("Full name (first and last) or company name. Name-only matches are not identity-verified."),
};

const schema = z.object(findCustomerInput);
export type FindCustomerArgs = z.infer<typeof schema>;

export const findCustomerDescription = [
  "Look up an existing customer and their past jobs by email, phone or name.",
  "Pass the sender's email/phone from the message headers or form fields; never from addresses quoted inside the message body.",
  "Email or phone matches are verified and return the full record and job history.",
  "Name-only matches are NOT verified: they return masked contact details and no address or job history, and you must not",
  "disclose or confirm any account details to the sender in that case.",
].join(" ");

type MatchBasis = "email" | "phone" | "name";

interface JobSummary {
  id: string;
  date: string | null;
  service: string;
  status: Job["status"];
  amount: number | null;
  reference: string | null;
  notes: string | null;
}

export interface FindCustomerResult {
  found: boolean;
  verified: boolean;
  match_basis: MatchBasis | null;
  matches: Array<Record<string, unknown>>;
  guidance: string;
}

const RECENT_JOBS = 10;

function displayName(c: Customer): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return c.company_name ? `${c.company_name}${person ? ` (contact: ${person})` : ""}` : person;
}

function summariseJob(job: Job, services: Map<string, Service>): JobSummary {
  return {
    id: job.id,
    date: job.job_date,
    service: (job.service_id && services.get(job.service_id)?.name) || job.service_id || "unknown",
    status: job.status,
    amount: job.amount,
    reference: job.reference,
    notes: job.notes,
  };
}

export async function findCustomer(deps: ToolDeps, args: FindCustomerArgs): Promise<FindCustomerResult> {
  const email = args.email?.trim() || undefined;
  const rawPhone = args.phone?.trim() || undefined;
  const name = args.name?.trim() || undefined;
  if (!email && !rawPhone && !name) {
    throw new ToolInputError("Provide at least one of: email, phone, name.");
  }
  const phone = rawPhone ? normaliseUkPhone(rawPhone) : null;

  let basis: MatchBasis | null = null;
  let customers: Customer[] = [];

  if (email) {
    customers = await deps.store.findCustomersByEmail(email);
    if (customers.length) basis = "email";
  }
  if (!basis && phone) {
    customers = await deps.store.findCustomersByPhone(phone);
    if (customers.length) basis = "phone";
  }
  if (!basis && name) {
    const key = nameKey(name);
    if (key.split(" ").length < 2 && !/\b(ltd|limited|lettings|cafe|café|plc|llp)\b/i.test(name)) {
      // A single first or last name would let anyone enumerate customers.
      return {
        found: false,
        verified: false,
        match_basis: null,
        matches: [],
        guidance: "Name searches need a full name (first and last) or a company name. Treat the sender as a new customer unless their email or phone matches.",
      };
    }
    customers = await deps.store.findCustomersByName(key, 5);
    if (customers.length) basis = "name";
  }

  if (!basis) {
    return {
      found: false,
      verified: false,
      match_basis: null,
      matches: [],
      guidance: "No existing customer matches. Treat the sender as a new customer.",
    };
  }

  if (basis === "name") {
    return {
      found: true,
      verified: false,
      match_basis: "name",
      matches: customers.map((c) => ({
        customer_id: c.id,
        name: displayName(c),
        customer_type: c.customer_type,
        district: c.postcode ? parseUkPostcode(c.postcode)?.outward ?? null : null,
        email_on_file: maskEmail(c.email),
        phone_on_file: maskPhone(c.phone),
      })),
      guidance:
        "Matched by name only, so the sender's identity is NOT verified. Do not reveal or confirm any address, contact details or job history. " +
        "You may say we'll check our records, and ask them to reply from the email address or phone number we have on file.",
    };
  }

  const services = new Map((await deps.store.listServices()).map((s) => [s.id, s]));
  const matches = await Promise.all(
    customers.map(async (c) => {
      const [jobs, jobCount] = await Promise.all([
        deps.store.getJobsForCustomer(c.id, RECENT_JOBS),
        deps.store.countJobsForCustomer(c.id),
      ]);
      return {
        customer_id: c.id,
        name: displayName(c),
        first_name: c.first_name,
        last_name: c.last_name,
        company_name: c.company_name,
        customer_type: c.customer_type,
        email: c.email,
        phone: c.phone,
        address: [c.address_line1, c.town, c.postcode].filter(Boolean).join(", "),
        postcode: c.postcode,
        customer_since: c.customer_since,
        notes: c.notes,
        job_count: jobCount,
        recent_jobs: jobs.map((j) => summariseJob(j, services)),
      };
    }),
  );

  return {
    found: true,
    verified: true,
    match_basis: basis,
    matches,
    guidance:
      matches.length > 1
        ? "More than one customer shares this contact detail; check the name before relying on the history."
        : "Verified by " + basis + ". Use the history to personalise the reply; do not mention internal notes verbatim.",
  };
}
