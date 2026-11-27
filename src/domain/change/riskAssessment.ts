import type { ChangeSet } from "./ChangeSet.js";
import { isTestPath } from "./language.js";
import type { FileChange } from "./types.js";

export type RiskLevel = "low" | "medium" | "high";

/** Why a file deserves attention. Codes are translated by the workspace. */
export type RiskReason =
  | "large_change"
  | "sensitive_area"
  | "untested_change"
  | "deleted_tests"
  | "dependency_change"
  | "configuration_change"
  | "schema_migration";

export interface FileRisk {
  readonly path: string;
  readonly score: number;
  readonly level: RiskLevel;
  readonly reasons: readonly RiskReason[];
}

export interface RiskProfile {
  readonly score: number;
  readonly level: RiskLevel;
  readonly files: readonly FileRisk[];
  /** Suggested order for a human to read the files: riskiest first. */
  readonly reviewOrder: readonly string[];
  /** Estimated minutes a senior engineer would need to review this change by hand. */
  readonly estimatedHumanReviewMinutes: number;
}

const SENSITIVE = /(auth|login|password|secret|token|session|permission|acl|crypto|payment|billing|checkout|coupon|invoice|wallet|security)/i;
const MIGRATION = /(^|\/)migrations?\/|\.sql$/i;
const DEPENDENCIES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?)$/i;
const CONFIGURATION = /(^|\/)(\.env[^/]*|Dockerfile|docker-compose[^/]*|[^/]*\.ya?ml|[^/]*\.tf|[^/]*config[^/]*)$/i;

/**
 * Literature puts careful code review at roughly 200–400 lines per hour
 * (SmartBear / Cisco study). We use 300 LOC/h, i.e. 5 lines per minute.
 */
const LINES_REVIEWED_PER_MINUTE = 5;

/** Domain service: scores how risky each file of a change set is. */
export function assessRisk(changeSet: ChangeSet): RiskProfile {
  const touchesTests = changeSet.files.some((f) => isTestPath(f.path) && f.status !== "removed");
  const files = changeSet.files.map((file) => assessFile(file, touchesTests));
  const reviewOrder = [...files].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).map((f) => f.path);
  const score = overallScore(files);
  const { additions, deletions } = changeSet.stats;
  return {
    score,
    level: levelOf(score),
    files,
    reviewOrder,
    estimatedHumanReviewMinutes: Math.max(5, Math.round((additions + deletions) / LINES_REVIEWED_PER_MINUTE)),
  };
}

function assessFile(file: FileChange, changeTouchesTests: boolean): FileRisk {
  const reasons: RiskReason[] = [];
  let score = Math.min(40, Math.round((file.additions + file.deletions) / 3));
  if (file.additions + file.deletions >= 120) reasons.push("large_change");

  const isTest = isTestPath(file.path);
  if (MIGRATION.test(file.path)) {
    score += 30;
    reasons.push("schema_migration");
  } else if (!isTest && SENSITIVE.test(file.path)) {
    score += 30;
    reasons.push("sensitive_area");
  }
  if (DEPENDENCIES.test(file.path)) {
    score += 15;
    reasons.push("dependency_change");
  } else if (CONFIGURATION.test(file.path)) {
    score += 10;
    reasons.push("configuration_change");
  }
  if (isTest && file.status === "removed") {
    score += 25;
    reasons.push("deleted_tests");
  }
  if (!isTest && isSourceCode(file) && !changeTouchesTests && file.additions > 0) {
    score += 15;
    reasons.push("untested_change");
  }

  const bounded = Math.min(100, score);
  return { path: file.path, score: bounded, level: levelOf(bounded), reasons };
}

function isSourceCode(file: FileChange): boolean {
  return !["json", "yaml", "markdown", "plaintext", "ini", "xml"].includes(file.language);
}

/**
 * A change is as risky as its riskiest file, plus a bonus for breadth:
 * every additional file that needs attention makes the whole harder to review.
 */
function overallScore(files: readonly FileRisk[]): number {
  if (files.length === 0) return 0;
  const riskiest = Math.max(...files.map((f) => f.score));
  const needingAttention = files.filter((f) => f.level !== "low").length;
  return Math.min(100, riskiest + 10 * Math.min(3, Math.max(0, needingAttention - 1)));
}

function levelOf(score: number): RiskLevel {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}
