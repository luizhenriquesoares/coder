import { createHmac, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type {
  AgentBrief,
  CouncilAgents,
  DebateBrief,
  DebateContribution,
  ImplementationBrief,
  ImplementationContribution,
  Logger,
  OpeningBrief,
  OpeningContribution,
  VerdictBrief,
  VerdictContribution,
} from "../../application/ports.js";
import { revisionKey, type PullRequestSnapshot } from "../../domain/change/types.js";
import type { Usage } from "../../domain/deliberation/model.js";
import { usageOf } from "./pricing.js";
import {
  boundaryRule,
  COUNCIL_RULES,
  debateTask,
  implementationTask,
  openingTask,
  personaBrief,
  renderPullRequest,
  verdictTask,
} from "./prompts.js";
import { DebateSchema, ImplementationSchema, OpeningSchema, VerdictSchema } from "./schemas.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCouncilOptions {
  readonly client: Anthropic;
  readonly model: string;
  readonly effort: Effort;
  readonly logger: Logger;
  readonly maxOutputTokens?: number;
}

/** Raised with a message that is safe and useful to show in the workspace. */
export class CouncilAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilAgentError";
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** Lets a declined request be retried server-side on the model Anthropic recommends. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Generated once per process: the author of a pull request cannot compute its boundary. */
const BOUNDARY_KEY = randomBytes(32);

/** The tag suffix that encloses one pull request head in the prompt. */
export function boundaryFor(snapshot: PullRequestSnapshot): string {
  return createHmac("sha256", BOUNDARY_KEY).update(revisionKey(snapshot.ref, snapshot.headSha)).digest("hex").slice(0, 24);
}

/**
 * The council's reviewer agents, backed by Claude.
 *
 * Every agent call shares one cached prefix (the council's rules as system,
 * then the pull request as the first user block) and gets its persona and
 * task after it. Answers come back as schema-validated structured output.
 */
export class ClaudeCouncil implements CouncilAgents {
  readonly engine = "claude" as const;
  readonly model: string;
  private readonly warmPrefixes = new Map<string, Promise<void>>();

  constructor(private readonly options: ClaudeCouncilOptions) {
    this.model = options.model;
  }

  supports(): boolean {
    return true;
  }

  async open(brief: OpeningBrief): Promise<OpeningContribution> {
    const { output, usage } = await this.ask(brief, OpeningSchema, openingTask());
    return { statement: output.statement, findings: output.findings, usage };
  }

  async debate(brief: DebateBrief): Promise<DebateContribution> {
    const { output, usage } = await this.ask(brief, DebateSchema, debateTask(brief));
    return { statement: output.statement, positions: output.positions, usage };
  }

  async implement(brief: ImplementationBrief): Promise<ImplementationContribution> {
    const { output, usage } = await this.ask(brief, ImplementationSchema, implementationTask(brief));
    return { statement: output.statement, patches: output.patches, declined: output.declined, usage };
  }

  async moderate(brief: VerdictBrief): Promise<VerdictContribution> {
    const { output, usage } = await this.ask(brief, VerdictSchema, verdictTask(brief));
    const { statement, ...verdict } = output;
    return { statement, verdict, usage };
  }

  private async ask<Schema extends z.ZodType>(
    { persona, context, signal }: AgentBrief,
    schema: Schema,
    task: string,
  ): Promise<{ output: z.infer<Schema>; usage: Usage }> {
    const { client, effort, logger } = this.options;
    const reviewer = persona.id;
    const boundary = boundaryFor(context.snapshot);
    const prefixKey = `${revisionKey(context.snapshot.ref, context.snapshot.headSha)}:${context.language}`;
    const warmed = await this.enterWarmGate(prefixKey);

    try {
      const stream = client.beta.messages.stream({
        model: this.model,
        max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort, format: betaZodOutputFormat(schema) },
        // Only the council's rules speak with the operator's voice; the author's text is material, in the user turn.
        system: [{ type: "text", text: `${COUNCIL_RULES}\n\n${boundaryRule(boundary)}` }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: renderPullRequest(context, boundary), cache_control: { type: "ephemeral" } },
              { type: "text", text: `${personaBrief(reviewer, context.language)}\n\n${task}` },
            ],
          },
        ],
      }, { signal });
      // The cache entry becomes readable once the first response starts streaming.
      stream.once("streamEvent", warmed);
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new CouncilAgentError(`The model declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}.`);
      }
      if (message.stop_reason === "max_tokens") {
        throw new CouncilAgentError("The answer was cut off at the output limit. Raise CODER_MAX_OUTPUT_TOKENS or review a smaller change.");
      }
      if (message.parsed_output === null || message.parsed_output === undefined) {
        throw new CouncilAgentError("The model returned no structured answer.");
      }
      const usage = usageOf(message.model, message.usage);
      logger.info("Reviewer answered", {
        reviewer,
        model: message.model,
        inputTokens: usage.inputTokens,
        cachedTokens: message.usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.outputTokens,
      });
      return { output: message.parsed_output as z.infer<Schema>, usage };
    } catch (error) {
      throw toCouncilAgentError(error);
    } finally {
      warmed();
    }
  }

  /**
   * The first call for a pull request writes the shared prefix to the prompt
   * cache; calls arriving at the same moment wait until that response starts,
   * so they read the cache instead of each paying to write it.
   */
  private async enterWarmGate(key: string): Promise<() => void> {
    const pending = this.warmPrefixes.get(key);
    if (pending) {
      await pending;
      return () => {};
    }
    let release = () => {};
    this.warmPrefixes.set(key, new Promise<void>((resolve) => (release = resolve)));
    if (this.warmPrefixes.size > 200) this.warmPrefixes.delete(this.warmPrefixes.keys().next().value!);
    return release;
  }
}

function toCouncilAgentError(error: unknown): CouncilAgentError {
  if (error instanceof CouncilAgentError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new CouncilAgentError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  if (error instanceof Anthropic.PermissionDeniedError) return new CouncilAgentError("This API key is not allowed to use the configured model.");
  if (error instanceof Anthropic.NotFoundError) return new CouncilAgentError("The configured model was not found. Check CODER_MODEL.");
  if (error instanceof Anthropic.RateLimitError) return new CouncilAgentError("Rate limited by the Claude API after retries. Try again in a moment.");
  if (error instanceof Anthropic.BadRequestError) return new CouncilAgentError(`The Claude API rejected the request: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new CouncilAgentError("Could not reach the Claude API.");
  if (error instanceof Anthropic.APIError) return new CouncilAgentError(`Claude API error ${error.status ?? ""}: ${error.message}`.trim());
  return new CouncilAgentError(error instanceof Error ? error.message : "Unknown error while asking the reviewer");
}
