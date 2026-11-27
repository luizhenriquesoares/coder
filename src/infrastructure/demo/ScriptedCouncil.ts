import type {
  CouncilAgents,
  DebateBrief,
  DebateContribution,
  ImplementationBrief,
  ImplementationContribution,
  OpeningBrief,
  OpeningContribution,
  VerdictBrief,
  VerdictContribution,
} from "../../application/ports.js";
import { refKey, type PullRequestSnapshot } from "../../domain/change/types.js";
import type { Finding, PanelistId } from "../../domain/deliberation/model.js";
import { DEMO_PULL_REQUESTS } from "./fixtures/index.js";
import type { CouncilScript, DemoPullRequest } from "./types.js";

/** Waits before a scripted reviewer answers, so the demo unfolds like a live session. */
export type Pace = (milliseconds: number) => Promise<void>;

export const realTimePace: Pace = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const instantPace: Pace = () => Promise.resolve();

const THINKING_MS: Record<PanelistId | "implementer" | "moderator", { opening: number; debate: number }> = {
  architect: { opening: 2400, debate: 2200 },
  staff: { opening: 3800, debate: 3400 },
  refactoring: { opening: 5200, debate: 4600 },
  cleancode: { opening: 6400, debate: 5800 },
  implementer: { opening: 4200, debate: 4200 },
  moderator: { opening: 2600, debate: 2600 },
};

/**
 * Council whose members read from a script. It powers demo mode and the test
 * suite: the same protocol, policies and events as the Claude council, with
 * fixed content and no model calls.
 */
export class ScriptedCouncil implements CouncilAgents {
  readonly engine = "scripted" as const;
  readonly model = null;
  private readonly scripts: ReadonlyMap<string, CouncilScript>;

  constructor(
    private readonly pace: Pace = realTimePace,
    pullRequests: readonly DemoPullRequest[] = DEMO_PULL_REQUESTS,
  ) {
    this.scripts = new Map(pullRequests.map((pr) => [refKey(pr.ref), pr.script]));
  }

  supports(snapshot: PullRequestSnapshot): boolean {
    return this.scripts.has(refKey(snapshot.ref));
  }

  async open({ persona, context }: OpeningBrief): Promise<OpeningContribution> {
    const reviewer = persona.id as PanelistId;
    const part = this.scriptFor(context.snapshot).opening[reviewer];
    await this.pace(THINKING_MS[reviewer].opening);
    const { language } = context;
    return {
      statement: part.statement[language],
      usage: null,
      findings: part.findings.map((finding) => ({
        key: finding.key,
        severity: finding.severity,
        category: finding.category,
        title: finding.title[language],
        rationale: finding.rationale[language],
        recommendation: finding.recommendation[language],
        principle: finding.principle[language],
        path: finding.path,
        line: null,
        quote: finding.quote,
      })),
    };
  }

  async debate({ persona, context, findings }: DebateBrief): Promise<DebateContribution> {
    const reviewer = persona.id as PanelistId;
    const part = this.scriptFor(context.snapshot).debate[reviewer];
    await this.pace(THINKING_MS[reviewer].debate);
    return {
      statement: part.statement[context.language],
      usage: null,
      positions: part.positions.flatMap((position) => {
        const findingId = idOf(findings, position.on);
        return findingId ? [{ findingId, stance: position.stance, argument: position.argument[context.language] }] : [];
      }),
    };
  }

  async implement({ context, findings }: ImplementationBrief): Promise<ImplementationContribution> {
    const part = this.scriptFor(context.snapshot).implementation;
    await this.pace(THINKING_MS.implementer.opening);
    return {
      statement: part.statement[context.language],
      usage: null,
      patches: part.patches.flatMap((patch) => {
        const findingIds = patch.fixes.flatMap((key) => idOf(findings, key) ?? []);
        if (findingIds.length === 0) return [];
        return [
          {
            findingIds,
            path: patch.path,
            original: patch.original,
            replacement: patch.replacement,
            explanation: patch.explanation[context.language],
          },
        ];
      }),
      declined: part.declined.flatMap((declined) => {
        const findingId = idOf(findings, declined.on);
        return findingId ? [{ findingId, reason: declined.reason[context.language] }] : [];
      }),
    };
  }

  async moderate({ context }: VerdictBrief): Promise<VerdictContribution> {
    const part = this.scriptFor(context.snapshot).verdict;
    await this.pace(THINKING_MS.moderator.opening);
    const { language } = context;
    return {
      statement: part.statement[language],
      usage: null,
      verdict: {
        decision: part.decision,
        mergeRisk: part.mergeRisk,
        summary: part.summary[language],
        humanAttention: part.humanAttention.map((item) => item[language]),
      },
    };
  }

  private scriptFor(snapshot: PullRequestSnapshot): CouncilScript {
    const script = this.scripts.get(refKey(snapshot.ref));
    if (!script) throw new Error(`No script for ${refKey(snapshot.ref)}`);
    return script;
  }
}

/** Scripts refer to findings by key; the session assigns the ids. */
function idOf(findings: readonly Finding[], key: string): string | null {
  return findings.find((finding) => finding.key === key)?.id ?? null;
}
