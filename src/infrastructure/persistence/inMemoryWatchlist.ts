import type { Watchlist } from "../../application/ports.js";
import { refKey, type PullRequestRef } from "../../domain/change/types.js";

export class InMemoryWatchlist implements Watchlist {
  protected readonly refs = new Map<string, PullRequestRef>();

  async all(): Promise<PullRequestRef[]> {
    return [...this.refs.values()];
  }

  async add(ref: PullRequestRef): Promise<void> {
    this.refs.set(refKey(ref), ref);
  }
}
