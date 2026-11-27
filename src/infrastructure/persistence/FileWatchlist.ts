import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refKey, type PullRequestRef } from "../../domain/change/types.js";
import { InMemoryWatchlist } from "./inMemoryWatchlist.js";

/** Watchlist persisted as a small JSON file. */
export class FileWatchlist extends InMemoryWatchlist {
  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<FileWatchlist> {
    const watchlist = new FileWatchlist(file);
    try {
      const stored = JSON.parse(await readFile(file, "utf8")) as PullRequestRef[];
      stored.forEach((ref) => watchlist.refs.set(refKey(ref), ref));
    } catch {
      // No watchlist yet.
    }
    return watchlist;
  }

  override async add(ref: PullRequestRef): Promise<void> {
    await super.add(ref);
    await this.write();
  }

  override async remove(ref: PullRequestRef): Promise<void> {
    await super.remove(ref);
    await this.write();
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify([...this.refs.values()], null, 2), "utf8");
  }
}
