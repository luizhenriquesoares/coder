import { ChangeSet } from "../domain/change/ChangeSet.js";
import { refKey, type FileContents, type Provider, type PullRequestRef, type PullRequestSnapshot } from "../domain/change/types.js";
import { ApplicationError, describeError } from "./errors.js";
import type { PullRequestSummary, SourceControl } from "./ports.js";

export interface CatalogListing {
  readonly items: readonly PullRequestSummary[];
  readonly errors: readonly { readonly provider: Provider; readonly message: string }[];
}

export interface HeadContentsResult {
  readonly contents: ReadonlyMap<string, string>;
  /** Files whose full content was not loaded (binary, removed, or over budget): reviewers see only their diff. */
  readonly diffOnly: readonly string[];
}

export interface ContentBudget {
  readonly maxFileChars: number;
  readonly maxTotalChars: number;
}

export const DEFAULT_CONTENT_BUDGET: ContentBudget = { maxFileChars: 150_000, maxTotalChars: 1_200_000 };

const SNAPSHOT_TTL_MS = 20_000;
const MAX_CACHED_FILES = 500;
const FETCH_CONCURRENCY = 6;

/**
 * Reads pull requests through the configured source-control adapters and
 * caches what is safe to cache: snapshots briefly, file contents at a given
 * commit indefinitely (a blob at a sha never changes).
 */
export class PullRequestCatalog {
  private readonly snapshots = new Map<string, { at: number; value: Promise<PullRequestSnapshot> }>();
  private readonly files = new Map<string, Promise<FileContents>>();

  constructor(
    private readonly sources: ReadonlyMap<Provider, SourceControl>,
    private readonly now: () => number = Date.now,
  ) {}

  source(provider: Provider): SourceControl {
    const source = this.sources.get(provider);
    if (!source) throw new ApplicationError("not_configured", `No ${provider} source is configured`);
    return source;
  }

  async listOpen(): Promise<CatalogListing> {
    const results = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        try {
          return { items: await source.listOpenPullRequests(), error: null };
        } catch (error) {
          return { items: [], error: { provider: source.provider, message: describeError(error) } };
        }
      }),
    );
    return {
      items: results.flatMap((r) => r.items),
      errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    };
  }

  snapshot(ref: PullRequestRef, options: { fresh?: boolean } = {}): Promise<PullRequestSnapshot> {
    const key = refKey(ref);
    const cached = this.snapshots.get(key);
    if (cached && !options.fresh && this.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;

    const value = this.source(ref.provider).getSnapshot(ref);
    this.snapshots.set(key, { at: this.now(), value });
    value.catch(() => this.snapshots.delete(key));
    return value;
  }

  fileContents(snapshot: PullRequestSnapshot, path: string): Promise<FileContents> {
    const key = `${refKey(snapshot.ref)}@${snapshot.headSha}:${path}`;
    const cached = this.files.get(key);
    if (cached) return cached;

    const value = this.source(snapshot.ref.provider).getFileContents(snapshot, path);
    this.files.set(key, value);
    value.catch(() => this.files.delete(key));
    if (this.files.size > MAX_CACHED_FILES) this.files.delete(this.files.keys().next().value!);
    return value;
  }

  /** Loads the head version of every reviewable file, riskiest first, within a budget. */
  async headContents(
    snapshot: PullRequestSnapshot,
    changeSet: ChangeSet,
    priority: readonly string[],
    budget: ContentBudget = DEFAULT_CONTENT_BUDGET,
  ): Promise<HeadContentsResult> {
    const reviewable = priority.filter((path) => {
      const file = changeSet.file(path);
      return file && file.status !== "removed" && !file.binary;
    });
    const loaded = await mapWithConcurrency(reviewable, FETCH_CONCURRENCY, async (path) => {
      try {
        return { path, text: (await this.fileContents(snapshot, path)).modified };
      } catch {
        return { path, text: null };
      }
    });

    const contents = new Map<string, string>();
    let total = 0;
    for (const { path, text } of loaded) {
      if (text === null || text.length > budget.maxFileChars || total + text.length > budget.maxTotalChars) continue;
      contents.set(path, text);
      total += text.length;
    }
    const diffOnly = changeSet.files.map((f) => f.path).filter((path) => !contents.has(path));
    return { contents, diffOnly };
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
