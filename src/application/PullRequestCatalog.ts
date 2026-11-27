import { ChangeSet } from "../domain/change/ChangeSet.js";
import { refKey, revisionKey, type FileContents, type Provider, type PullRequestRef, type PullRequestSnapshot } from "../domain/change/types.js";
import { ApplicationError, describeError } from "./errors.js";
import { summarize, type DiffOnlyFile, type PullRequestSummary, type SourceControl } from "./ports.js";

export interface CatalogListing {
  readonly items: readonly PullRequestSummary[];
  readonly errors: readonly { readonly provider: Provider; readonly message: string }[];
}

/** A pull request's summary as the catalog knows it; `error` says why it could not be refreshed. */
export interface SummaryReading {
  readonly summary: PullRequestSummary | null;
  readonly error: string | null;
}

export interface HeadContentsResult {
  readonly contents: ReadonlyMap<string, string>;
  /** Files whose full content was not loaded: reviewers see only their diff. */
  readonly diffOnly: readonly DiffOnlyFile[];
}

export interface ContentBudget {
  readonly maxFileChars: number;
  readonly maxTotalChars: number;
}

export const DEFAULT_CONTENT_BUDGET: ContentBudget = { maxFileChars: 150_000, maxTotalChars: 1_200_000 };

const SNAPSHOT_TTL_MS = 20_000;
const MAX_CACHED_FILES = 500;
const FETCH_CONCURRENCY = 6;

interface Entry<T> {
  readonly at: number;
  readonly value: Promise<T>;
}

/** One load per key for `ttlMs`: callers within that time, concurrent ones included, share it. */
function cached<T>(entries: Map<string, Entry<T>>, key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> {
  const entry = entries.get(key);
  if (entry && now - entry.at < ttlMs) return entry.value;
  const value = load();
  entries.set(key, { at: now, value });
  return value;
}

/**
 * Reads pull requests through the configured source-control adapters and
 * caches what is safe to cache: listings and summaries for as long as each
 * source allows, snapshots briefly, file contents at a given commit
 * indefinitely (a blob at a sha never changes). A listing or a summary whose
 * refresh fails is still served from the last good answer, with the error.
 */
export class PullRequestCatalog {
  private readonly snapshots = new Map<string, Entry<PullRequestSnapshot>>();
  private readonly files = new Map<string, Promise<FileContents>>();
  private readonly listings = new Map<string, Entry<{ items: readonly PullRequestSummary[]; error: CatalogListing["errors"][number] | null }>>();
  private readonly lastListing = new Map<Provider, readonly PullRequestSummary[]>();
  private readonly summaries = new Map<string, Entry<SummaryReading>>();
  private readonly knownSummaries = new Map<string, PullRequestSummary>();

  constructor(
    private readonly sources: ReadonlyMap<Provider, SourceControl>,
    readonly now: () => number = Date.now,
  ) {}

  source(provider: Provider): SourceControl {
    const source = this.sources.get(provider);
    if (!source) throw new ApplicationError("not_configured", `No ${provider} source is configured`);
    return source;
  }

  async listOpen(): Promise<CatalogListing> {
    const results = await Promise.all(
      [...this.sources.values()].map((source) =>
        cached(this.listings, source.provider, source.refreshIntervalMs, this.now(), async () => {
          try {
            const items = await source.listOpenPullRequests();
            this.lastListing.set(source.provider, items);
            return { items, error: null };
          } catch (error) {
            return { items: this.lastListing.get(source.provider) ?? [], error: { provider: source.provider, message: describeError(error) } };
          }
        }),
      ),
    );
    return {
      items: results.flatMap((r) => r.items),
      errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    };
  }

  /** One request to the source per refresh interval; a closed or merged pull request is not read again. */
  summary(ref: PullRequestRef): Promise<SummaryReading> {
    const key = refKey(ref);
    const known = this.knownSummaries.get(key);
    const ttl = known && known.state !== "open" ? Infinity : (this.sources.get(ref.provider)?.refreshIntervalMs ?? 0);
    return cached(this.summaries, key, ttl, this.now(), async () => {
      try {
        return { summary: this.remember(await this.source(ref.provider).getSummary(ref)), error: null };
      } catch (error) {
        return { summary: this.knownSummaries.get(key) ?? null, error: describeError(error) };
      }
    });
  }

  snapshot(ref: PullRequestRef, options: { fresh?: boolean } = {}): Promise<PullRequestSnapshot> {
    const key = refKey(ref);
    const ttl = options.fresh ? 0 : SNAPSHOT_TTL_MS;
    return cached(this.snapshots, key, ttl, this.now(), () => {
      const value = this.source(ref.provider).getSnapshot(ref);
      value.then(
        (snapshot) => this.remember(summarize(snapshot)),
        () => this.snapshots.delete(key),
      );
      return value;
    });
  }

  /** A summary just read is the freshest one there is: later summary() calls get it without asking the source. */
  private remember(summary: PullRequestSummary): PullRequestSummary {
    const key = refKey(summary.ref);
    this.knownSummaries.set(key, summary);
    this.summaries.set(key, { at: this.now(), value: Promise.resolve({ summary, error: null }) });
    return summary;
  }

  fileContents(snapshot: PullRequestSnapshot, path: string): Promise<FileContents> {
    const key = `${revisionKey(snapshot.ref, snapshot.headSha)}:${path}`;
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
        return { path, text: (await this.fileContents(snapshot, path)).modified, error: null };
      } catch (error) {
        return { path, text: null, error: describeError(error) };
      }
    });

    const contents = new Map<string, string>();
    const unreadable = new Map<string, string>();
    let total = 0;
    for (const { path, text, error } of loaded) {
      if (text === null) unreadable.set(path, error ?? "unknown error");
      if (text === null || text.length > budget.maxFileChars || total + text.length > budget.maxTotalChars) continue;
      contents.set(path, text);
      total += text.length;
    }
    const diffOnly = changeSet.files
      .filter((file) => !contents.has(file.path))
      .map((file): DiffOnlyFile => {
        if (file.status === "removed") return { path: file.path, reason: "removed" };
        if (file.binary) return { path: file.path, reason: "binary" };
        const error = unreadable.get(file.path);
        return error === undefined ? { path: file.path, reason: "over_budget" } : { path: file.path, reason: "unreadable", error };
      });
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
