import { z } from "zod";
import { CATEGORIES, DECISIONS, MERGE_RISKS, SEVERITIES, STANCES } from "../../domain/deliberation/model.js";
import { MAX_FINDINGS_PER_REVIEWER } from "../../domain/deliberation/ReviewSession.js";

/**
 * Structured-output schemas: the contract between a reviewer agent and the
 * council. Field descriptions are part of the prompt the model sees.
 */

const statement = z.string().describe("What you say to the council in this round: 2 to 5 sentences, in your own voice.");

export const OpeningSchema = z.object({
  statement,
  findings: z
    .array(
      z.object({
        severity: z.enum(SEVERITIES),
        category: z.enum(CATEGORIES),
        title: z.string().describe("One line naming the problem, not the fix."),
        rationale: z.string().describe("Why it is a problem here: the concrete failure, cost or risk. 1 to 3 sentences."),
        recommendation: z.string().describe("What to do instead. 1 or 2 sentences."),
        principle: z.string().describe("The named refactoring, principle or rule you are applying, or an empty string."),
        path: z.string().nullable().describe("Path of the file exactly as listed in the change, or null for a change-wide finding."),
        line: z.number().int().nullable().describe("Line number in the new version of the file, or null."),
        quote: z.string().describe("One line of code copied verbatim from the new version at that location, without the line-number prefix. Empty when path is null."),
      }),
    )
    .describe(`At most ${MAX_FINDINGS_PER_REVIEWER} findings, most important first. An empty list is a valid answer.`),
});

export const DebateSchema = z.object({
  statement,
  positions: z
    .array(
      z.object({
        findingId: z.string().describe("Id of another reviewer's finding, such as F-3."),
        stance: z.enum(STANCES).describe("agree, disagree, or refine (you agree with the problem but would change severity, scope or remedy)."),
        argument: z.string().describe("Your reasoning in 1 to 3 sentences, grounded in the code."),
      }),
    )
    .describe("Your positions on findings raised by the other reviewers. Skip findings you have nothing to add to."),
});

export const ImplementationSchema = z.object({
  statement,
  patches: z.array(
    z.object({
      findingIds: z.array(z.string()).describe("Ids of the findings this patch fixes."),
      path: z.string().describe("Path of the file exactly as listed in the change."),
      original: z.string().describe("The exact, complete, contiguous lines of the new version being replaced, copied verbatim with their indentation and without line-number prefixes."),
      replacement: z.string().describe("The lines that replace them. An empty string deletes the original lines."),
      explanation: z.string().describe("Why this is the right fix, in 1 or 2 sentences."),
    }),
  ),
  declined: z
    .array(
      z.object({
        findingId: z.string(),
        reason: z.string().describe("Why you will not write a patch for it, in 1 or 2 sentences."),
      }),
    )
    .describe("Findings you deliberately do not patch."),
});

export const VerdictSchema = z.object({
  statement,
  decision: z.enum(DECISIONS),
  mergeRisk: z.enum(MERGE_RISKS),
  summary: z.string().describe("The verdict for a busy tech lead: 3 to 6 sentences on what was found, what the council agreed on and what the patches cover."),
  humanAttention: z
    .array(z.string())
    .describe("Up to 4 things that need a human decision or knowledge the council lacks. Each one sentence or two. Empty when there are none."),
});
