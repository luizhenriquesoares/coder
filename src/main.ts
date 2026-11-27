import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError } from "./application/errors.js";
import type { Logger } from "./application/ports.js";
import { loadConfig } from "./composition/config.js";
import { createServerApplication } from "./composition/server.js";
import { buildHttpServer } from "./infrastructure/http/server.js";

const logger: Logger = {
  info: (message, data) => console.log(format("info", message, data)),
  warn: (message, data) => console.warn(format("warn", message, data)),
  error: (message, data) => console.error(format("error", message, data)),
};

function format(level: string, message: string, data?: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${level.padEnd(5)} ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { application, autoReview, conductReview } = await createServerApplication(config, logger);
  const here = dirname(fileURLToPath(import.meta.url));
  const server = await buildHttpServer({
    api: application,
    autoReview,
    logger,
    ...(config.apiToken ? { apiToken: config.apiToken } : {}),
    ...(config.github.webhookSecret ? { webhookSecret: config.github.webhookSecret } : {}),
    webRoot: join(here, "..", "web", "dist"),
  });

  await server.listen({ port: config.port, host: config.host });
  logger.info("CodeR is listening", {
    url: `http://${config.host}:${config.port}`,
    claude: config.claude.enabled ? config.claude.model : "off (set ANTHROPIC_API_KEY)",
    github: config.github.token ? "token configured" : "read-only, public repositories",
    repositories: config.github.repositories.map((r) => `${r.owner}/${r.repo}`),
    autoReview: config.autoReview.enabled,
  });

  if (config.autoReview.enabled) {
    const poll = () => autoReview.poll().catch((error) => logger.warn("Polling failed", { error: describeError(error) }));
    void poll();
    setInterval(poll, config.autoReview.pollIntervalMs).unref();
  }

  // Stop taking requests, give every running session an outcome, then exit. A second signal exits at once.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    try {
      await server.close();
      await conductReview.interruptRunning("The server stopped while the council was in session. Convene the council again.");
    } catch (error) {
      logger.error("Shutdown did not complete", { error: describeError(error) });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
