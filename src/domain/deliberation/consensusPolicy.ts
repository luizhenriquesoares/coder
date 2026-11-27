import type { Consensus, ConsensusLevel, Finding, Position, ReviewerId } from "./model.js";

/**
 * ConsensusPolicy — domain service, deterministic (no model involved).
 *
 * The author counts as implicit support; `refine` is qualified support.
 *  - unreviewed: nobody else took a position
 *  - rejected:   opposition outweighs support
 *  - endorsed:   net support (support − opposition) is at least 2
 *  - contested:  everything in between (the human should look)
 */
export function computeConsensus(finding: Finding, positions: readonly Position[]): Consensus {
  const others = latestPositionPerReviewer(positions.filter((p) => p.findingId === finding.id && p.reviewer !== finding.author));
  const agree = reviewersWith(others, "agree");
  const refinements = reviewersWith(others, "refine");
  const opposition = reviewersWith(others, "disagree");
  const support = [finding.author, ...agree, ...refinements];
  return {
    findingId: finding.id,
    level: levelFor(others.length, support.length, opposition.length),
    support,
    opposition,
    refinements,
  };
}

export function computeAllConsensus(findings: readonly Finding[], positions: readonly Position[]): Consensus[] {
  return findings.map((finding) => computeConsensus(finding, positions));
}

function levelFor(othersWhoSpoke: number, support: number, opposition: number): ConsensusLevel {
  if (othersWhoSpoke === 0) return "unreviewed";
  if (opposition > support) return "rejected";
  if (support - opposition >= 2) return "endorsed";
  return "contested";
}

function latestPositionPerReviewer(positions: readonly Position[]): Position[] {
  const byReviewer = new Map<ReviewerId, Position>();
  for (const position of positions) byReviewer.set(position.reviewer, position);
  return [...byReviewer.values()];
}

function reviewersWith(positions: readonly Position[], stance: Position["stance"]): ReviewerId[] {
  return positions.filter((p) => p.stance === stance).map((p) => p.reviewer);
}
