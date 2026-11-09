export type ServiceCategory = "heating" | "gas" | "plumbing" | "bathrooms" | "emergency";
export type PriceBasis = "fixed" | "range" | "from";

export interface Service {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string;
  price_basis: PriceBasis;
  price_min: number;
  price_max: number | null;
  price_note: string | null;
  typical_duration_minutes: number | null;
  requires_survey: boolean;
  keywords: string[];
}

export interface Policy {
  id: string;
  title: string;
  category: string;
  /** "all", or service categories the policy is relevant to. */
  applies_to: string[];
  body: string;
}

export type CustomerType = "residential" | "landlord" | "agent" | "commercial";

export interface Customer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  customer_type: CustomerType;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  town: string | null;
  postcode: string | null;
  customer_since: string | null;
  notes: string | null;
}

export type JobStatus = "enquiry" | "quoted" | "scheduled" | "completed" | "cancelled";

export interface Job {
  id: string;
  customer_id: string;
  service_id: string | null;
  status: JobStatus;
  /** ISO date (YYYY-MM-DD). */
  job_date: string | null;
  amount: number | null;
  reference: string | null;
  engineer: string | null;
  notes: string | null;
}

export type Zone = "core" | "extended";

export interface District {
  district: string;
  zone: Zone;
  area_name: string;
  travel_surcharge: number;
  response_target_minutes: number;
}

/**
 * Read-only access to the business's records. Implemented over the JSON seed files
 * (local development and tests) and over Postgres/Supabase (production).
 * There are deliberately no write methods: the MCP server cannot change anything.
 */
export interface BusinessDataStore {
  findCustomersByEmail(email: string): Promise<Customer[]>;
  /** `phone` is already normalised with normaliseUkPhone. */
  findCustomersByPhone(phone: string): Promise<Customer[]>;
  /** `key` is already normalised with nameKey; matches "first last" or the company name. */
  findCustomersByName(key: string, limit: number): Promise<Customer[]>;
  /** Most recent first. */
  getJobsForCustomer(customerId: string, limit: number): Promise<Job[]>;
  countJobsForCustomer(customerId: string): Promise<number>;
  listServices(): Promise<Service[]>;
  listPolicies(): Promise<Policy[]>;
  getDistrict(outwardCode: string): Promise<District | null>;
  close(): Promise<void>;
}
