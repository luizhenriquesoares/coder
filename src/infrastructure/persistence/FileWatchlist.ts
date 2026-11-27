import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refKey, type PullRequestRef } from "../../domain/change/types.js";
import { describeError } from "../../application/errors.js";
import { InMemoryWatchlist } from "./inMemoryWatchlist.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Watchlist persisted as a small JSON file. */
export class FileWatchlist extends InMemoryWatchlist {
  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<FileWatchlist> {
    const watchlist = new FileWatchlist(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return watchlist; // no watchlist yet
      throw new Error(`Cannot read the watchlist ${file}: ${describeError(error)}`);
    }
    let stored: PullRequestRef[];
    try {
      stored = JSON.parse(text) as PullRequestRef[];
    } catch (error) {
      // Starting empty would overwrite the file with the next import and lose every entry.
      throw new Error(`The watchlist ${file} is not valid JSON (${describeError(error)}). Fix or remove it, then start again.`);
    }
    stored.forEach((ref) => watchlist.refs.set(refKey(ref), ref));
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
