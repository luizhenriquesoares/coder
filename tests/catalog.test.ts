import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestSummary, SourceControl } from "../src/application/ports.js";
import { PullRequestCatalog } from "../src/application/PullRequestCatalog.js";
import { ChangeSet } from "../src/domain/change/ChangeSet.js";
import type { PullRequestSnapshot, RawFileChange } from "../src/domain/change/types.js";
import { FileWatchlist } from "../src/infrastructure/persistence/FileWatchlist.js";

const added = (path: string, text: string): RawFileChange => ({
  path,
  status: "added",
  additions: text.split("\n").length,
  deletions: 0,
  patch: `@@ -0,0 +1,${text.split("\n").length} @@\n` + text.split("\n").map((line) => `+${line}`).join("\n"),
});

const HEADS: Record<string, string> = { "src/small.ts": "export const a = 1;", "src/large.ts": "x".repeat(500), "src/broken.ts": "never read" };

const snapshot: PullRequestSnapshot = {
  ref: { provider: "github", owner: "acme", repo: "shop", number: 1 },
  title: "Mixed",
  description: "",
  author: { login: "dev" },
  url: "https://github.com/acme/shop/pull/1",
  baseBranch: "main",
  headBranch: "mixed",
  baseSha: "b",
  headSha: "h",
  createdAt: "2026-11-27T10:00:00Z",
  updatedAt: "2026-11-27T10:00:00Z",
  draft: false,
  state: "open",
  files: [
    added("src/small.ts", HEADS["src/small.ts"]!),
    added("src/large.ts", HEADS["src/large.ts"]!),
    added("src/broken.ts", HEADS["src/broken.ts"]!),
    { path: "assets/logo.png", status: "added", additions: 1, deletions: 0 },
    { path: "docs/old.md", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-# Old" },
  ],
};

const source: SourceControl = {
  provider: "github",
  refreshIntervalMs: 0,
  listOpenPullRequests: async () => [],
  getSummary: async (): Promise<PullRequestSummary> => {
    throw new Error("not used");
  },
  getSnapshot: async () => snapshot,
  getFileContents: async (_snapshot, path) => {
    if (path === "src/broken.ts") throw new Error("GitHub could not read src/broken.ts: Server Error");
    return { path, original: "", modified: HEADS[path] ?? "" };
  },
  publishReview: async () => {
    throw new Error("not used");
  },
};

describe("PullRequestCatalog.headContents", () => {
  it("says which files reviewers see only as a diff, and why", async () => {
    const catalog = new PullRequestCatalog(new Map([["github", source]]));
    const changeSet = ChangeSet.fromSnapshot(snapshot);
    const priority = changeSet.files.map((file) => file.path);
    const { contents, diffOnly } = await catalog.headContents(snapshot, changeSet, priority, { maxFileChars: 100, maxTotalChars: 1000 });

    expect([...contents.keys()]).toEqual(["src/small.ts"]);
    expect(diffOnly).toEqual([
      { path: "src/large.ts", reason: "over_budget" },
      { path: "src/broken.ts", reason: "unreadable", error: "GitHub could not read src/broken.ts: Server Error" },
      { path: "assets/logo.png", reason: "binary" },
      { path: "docs/old.md", reason: "removed" },
    ]);
  });
});

describe("FileWatchlist", () => {
  it("starts empty when there is no file yet, and refuses to start over a broken one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coder-watch-"));
    try {
      expect(await (await FileWatchlist.open(join(dir, "watchlist.json"))).all()).toEqual([]);
      await writeFile(join(dir, "watchlist.json"), '[{"provider": "github", ');
      await expect(FileWatchlist.open(join(dir, "watchlist.json"))).rejects.toThrow(/watchlist .*watchlist\.json is not valid JSON/);
      await expect(FileWatchlist.open(dir)).rejects.toThrow(/Cannot read the watchlist/); // a directory, not a file
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
