import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  dataSource: "json" | "postgres";
  seedDataDir: string;
  databaseUrl?: string;
  databaseSsl?: "require" | "no-verify" | "disable";
  /** seed = the relative template in calendar.json; google = Google Calendar free/busy (read-only). */
  calendarSource: "seed" | "google";
  googleCalendarId?: string;
  googleServiceAccountKeyFile?: string;
  transport: "stdio" | "http";
  host: string;
  port: number;
  authToken?: string;
  /** ISO timestamp to pin "now" (demos, evaluation runs). */
  fixedNow?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/ and dist/ both sit one level inside mcp-server/, so this resolves to the repo's seed/data. */
const DEFAULT_SEED_DIR = path.resolve(here, "..", "..", "seed", "data");

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): Config {
  const dataSource = oneOf("DATA_SOURCE", env.DATA_SOURCE, ["json", "postgres"] as const, "json");
  const transport = oneOf("MCP_TRANSPORT", flag(argv, "transport") ?? env.MCP_TRANSPORT, ["stdio", "http"] as const, "stdio");
  const port = Number(flag(argv, "port") ?? env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a valid port (got "${env.PORT}")`);

  const config: Config = {
    dataSource,
    seedDataDir: env.SEED_DATA_DIR ? path.resolve(env.SEED_DATA_DIR) : DEFAULT_SEED_DIR,
    databaseUrl: env.DATABASE_URL || undefined,
    databaseSsl: env.DATABASE_SSL
      ? oneOf("DATABASE_SSL", env.DATABASE_SSL, ["require", "no-verify", "disable"] as const, "disable")
      : undefined,
    calendarSource: oneOf("CALENDAR_SOURCE", env.CALENDAR_SOURCE, ["seed", "google"] as const, "seed"),
    googleCalendarId: env.GOOGLE_CALENDAR_ID || undefined,
    googleServiceAccountKeyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || undefined,
    transport,
    host: flag(argv, "host") ?? env.HOST ?? "127.0.0.1",
    port,
    authToken: env.MCP_AUTH_TOKEN || undefined,
    fixedNow: env.FIXED_NOW || undefined,
  };

  if (config.dataSource === "postgres" && !config.databaseUrl) {
    throw new Error("DATA_SOURCE=postgres needs DATABASE_URL");
  }
  if (config.calendarSource === "google" && (!config.googleCalendarId || !config.googleServiceAccountKeyFile)) {
    throw new Error("CALENDAR_SOURCE=google needs GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_KEY_FILE");
  }
  if (config.transport === "http" && !config.authToken && !isLoopback(config.host)) {
    throw new Error("Refusing to serve HTTP on a non-local address without MCP_AUTH_TOKEN");
  }
  if (config.authToken && config.authToken.length < 24) {
    throw new Error("MCP_AUTH_TOKEN must be at least 24 characters");
  }
  return config;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
