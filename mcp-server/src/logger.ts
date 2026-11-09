/**
 * Structured JSON-lines logging to stderr. stdout is reserved for the MCP stdio protocol,
 * so nothing in this server may write to stdout.
 *
 * Tool-call logs record which kinds of identifier were supplied, never their values,
 * so customer data does not end up in log files.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n");
}
