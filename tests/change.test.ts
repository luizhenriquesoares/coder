import { describe, expect, it } from "vitest";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import { parseUnifiedPatch } from "../src/domain/change/diffParser.js";
import { isTestPath, languageFromPath } from "../src/domain/change/language.js";
import { assessRisk } from "../src/domain/change/riskAssessment.js";
import { refKey, revisionKey, type PullRequestSnapshot, type RawFileChange } from "../src/domain/change/types.js";
import { unifiedDiff } from "../src/infrastructure/demo/lineDiff.js";

function snapshotOf(files: RawFileChange[]): PullRequestSnapshot {
  return {
    ref: { provider: "github", owner: "acme", repo: "shop", number: 7 },
    title: "t",
    description: "",
    author: { login: "dev" },
    url: "https://github.com/acme/shop/pull/7",
    baseBranch: "main",
    headBranch: "feature",
    baseSha: "base",
    headSha: "head",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    draft: false,
    state: "open",
    files,
  };
}

describe("parseUnifiedPatch", () => {
  const patch = ["@@ -1,4 +1,5 @@", " one", "-two", "+TWO", "+two and a half", " three", " four", "@@ -10 +11,2 @@ function tail() {", " ten", "+eleven"].join("\n");

  it("numbers old and new lines across hunks", () => {
    const [first, second] = parseUnifiedPatch(patch);
    expect(first).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(first!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
    expect(second).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 2 });
    expect(second!.lines.at(-1)).toMatchObject({ kind: "add", newLine: 12 });
  });

  it("ignores the no-newline marker and missing patches", () => {
    expect(parseUnifiedPatch(undefined)).toEqual([]);
    const [hunk] = parseUnifiedPatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b");
    expect(hunk!.lines).toHaveLength(2);
  });
});

describe("unifiedDiff (demo fixtures)", () => {
  it("round-trips through the parser with consistent counts", () => {
    const original = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const modified = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
    const diff = unifiedDiff(original, modified);
    expect(diff).toMatchObject({ additions: 2, deletions: 1 });
    const hunks = parseUnifiedPatch(diff.patch);
    for (const hunk of hunks) {
      expect(hunk.lines.filter((l) => l.kind !== "add")).toHaveLength(hunk.oldLines);
      expect(hunk.lines.filter((l) => l.kind !== "del")).toHaveLength(hunk.newLines);
    }
    const added = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add");
    expect(added.map((l) => [l.newLine, l.content])).toEqual([
      [2, "B"],
      [11, "k"],
    ]);
  });

  it("renders an added file as one hunk starting at line 1", () => {
    const diff = unifiedDiff("", "x\ny\n");
    expect(diff.patch.split("\n")[0]).toBe("@@ -0,0 +1,2 @@");
  });
});

describe("ChangeSet", () => {
  const changeSet = ChangeSet.fromSnapshot(
    snapshotOf([
      { path: "src/pay/charge.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+newer\n ctx2" },
      { path: "docs/logo.png", status: "added", additions: 0, deletions: 0 },
    ]),
  );

  it("knows which lines can carry an inline comment", () => {
    expect(changeSet.isCommentable("src/pay/charge.ts", 11)).toBe(true);
    expect(changeSet.isCommentable("src/pay/charge.ts", 13)).toBe(true);
    expect(changeSet.isCommentable("src/pay/charge.ts", 14)).toBe(false);
    expect(changeSet.isCommentable("src/pay/charge.ts", 9)).toBe(false);
    expect(changeSet.isCommentableRange("src/pay/charge.ts", 11, 12)).toBe(true);
    expect(changeSet.isCommentableRange("src/pay/charge.ts", 12, 20)).toBe(false);
    expect(changeSet.isCommentable("missing.ts", 1)).toBe(false);
  });

  it("resolves exact paths and unique suffixes only", () => {
    expect(changeSet.resolvePath("src/pay/charge.ts")).toBe("src/pay/charge.ts");
    expect(changeSet.resolvePath("./src/pay/charge.ts")).toBe("src/pay/charge.ts");
    expect(changeSet.resolvePath("charge.ts")).toBe("src/pay/charge.ts");
    expect(changeSet.resolvePath("other.ts")).toBeNull();
  });

  it("sums stats and rejects duplicate paths", () => {
    expect(changeSet.stats).toEqual({ files: 2, additions: 2, deletions: 1 });
    const duplicate = { path: "a.ts", status: "modified", additions: 1, deletions: 0 } as const;
    expect(() => ChangeSet.fromSnapshot(snapshotOf([duplicate, duplicate]))).toThrow(/Duplicate/);
  });
});

describe("assessRisk", () => {
  it("ranks sensitive, untested code above documentation", () => {
    const risk = assessRisk(
      ChangeSet.fromSnapshot(
        snapshotOf([
          { path: "README.md", status: "modified", additions: 4, deletions: 0, patch: "@@ -1 +1,5 @@\n a\n+b\n+c\n+d\n+e" },
          { path: "src/auth/session.ts", status: "modified", additions: 80, deletions: 10, patch: "@@ -1 +1 @@\n-a\n+b" },
        ]),
      ),
    );
    expect(risk.reviewOrder[0]).toBe("src/auth/session.ts");
    const session = risk.files.find((f) => f.path === "src/auth/session.ts")!;
    expect(session.reasons).toEqual(expect.arrayContaining(["sensitive_area", "untested_change"]));
    expect(session.level).toBe("high");
    expect(risk.files.find((f) => f.path === "README.md")!.level).toBe("low");
    expect(risk.estimatedHumanReviewMinutes).toBeGreaterThanOrEqual(15);
  });

  it("flags deleted tests and migrations", () => {
    const risk = assessRisk(
      ChangeSet.fromSnapshot(
        snapshotOf([
          { path: "tests/cart.test.ts", status: "removed", additions: 0, deletions: 40, patch: "@@ -1 +0,0 @@\n-a" },
          { path: "migrations/001_init.sql", status: "added", additions: 10, deletions: 0, patch: "@@ -0,0 +1 @@\n+a" },
        ]),
      ),
    );
    expect(risk.files[0]!.reasons).toContain("deleted_tests");
    expect(risk.files[1]!.reasons).toContain("schema_migration");
  });
});

describe("naming helpers", () => {
  it("maps paths to languages and recognises tests", () => {
    expect(languageFromPath("src/a.tsx")).toBe("typescript");
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("x/y.unknown")).toBe("plaintext");
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("pkg/a_test.go")).toBe(true);
    expect(isTestPath("src/contest/a.ts")).toBe(false);
  });

  it("names a pull request, and one commit of it", () => {
    const ref = { provider: "github", owner: "acme", repo: "shop.api", number: 12 } as const;
    expect(refKey(ref)).toBe("github:acme/shop.api#12");
    expect(revisionKey(ref, "abc123")).toBe("github:acme/shop.api#12@abc123");
  });
});
