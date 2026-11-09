#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { startHttpServer } from "./http.js";
import { log } from "./logger.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await buildDeps(config);
  const meta = { server: SERVER_NAME, version: SERVER_VERSION, data: config.dataSource, calendar: config.calendarSource };

  const shutdown = async (signal: string) => {
    log("info", "shutdown", { signal });
    await deps.store.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (config.transport === "http") {
    await startHttpServer({
      host: config.host,
      port: config.port,
      authToken: config.authToken,
      createServer: () => createMcpServer(deps),
    });
    log("info", "listening", { ...meta, transport: "http", url: `http://${config.host}:${config.port}/mcp`, auth: Boolean(config.authToken) });
  } else {
    await createMcpServer(deps).connect(new StdioServerTransport());
    log("info", "listening", { ...meta, transport: "stdio" });
  }
}

main().catch((err) => {
  log("error", "startup_failed", { error: (err as Error).message });
  process.exit(1);
});
