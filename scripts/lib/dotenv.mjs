// Minimal .env reader/writer for the repo's setup scripts. Values are never printed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** ENV_FILE overrides the location (used to test the scripts without touching the real .env). */
export const ENV_PATH = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, ".env");

const KEY_LINE = /^\s*([A-Z0-9_]+)\s*=(.*)$/;

export function readEnv(file = ENV_PATH) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    if (m) values[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/**
 * Docker Compose expands "$NAME" inside .env values; single quotes make a value literal.
 * readEnv strips the quotes again, so scripts and Compose both see the real value.
 */
export function composeSafe(value) {
  return value.includes("$") && !value.includes("'") && !/^'.*'$/.test(value) ? `'${value}'` : value;
}

/** Set keys in .env in place (appending any that are missing), keeping every other line as it is. */
export function updateEnv(updates, file = ENV_PATH) {
  const raw = readFileSync(file, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Map(Object.entries(updates).map(([k, v]) => [k, composeSafe(v)]));
  const lines = raw.split(/\r?\n/).map((line) => {
    const m = KEY_LINE.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  if (pending.size) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    for (const [k, v] of pending) lines.push(`${k}=${v}`);
    lines.push("");
  }
  writeFileSync(file, lines.join(eol));
}
