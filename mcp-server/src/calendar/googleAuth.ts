import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/** The fields of a Google service-account JSON key that we use. */
export interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri: string;
}

export const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

export async function loadServiceAccountKey(file: string): Promise<ServiceAccountKey> {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read the Google service account key at ${file}: ${(err as Error).message}`);
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error(`${file} is not a Google service account JSON key`);
  }
  return { ...key, token_uri: key.token_uri ?? "https://oauth2.googleapis.com/token" } as ServiceAccountKey;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * OAuth 2.0 access tokens for a service account (the JWT bearer flow), cached until shortly before
 * they expire. The scope is fixed per instance, so a read-only instance can never obtain write access.
 */
export class ServiceAccountTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scope: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get email(): string {
    return this.key.client_email;
  }

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) return this.cached.token;

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: this.key.client_email, scope: this.scope, aud: this.key.token_uri, iat: now, exp: now + 3600 }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.key.private_key);
    const assertion = `${header}.${claims}.${b64url(signature)}`;

    const res = await this.fetchImpl(this.key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google token request failed (${res.status}): ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
    }
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
