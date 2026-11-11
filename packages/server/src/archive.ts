import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { RawArchive, RawArchiveEntry } from "@finance-hub/core";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Append-only archive of raw provider responses on disk:
 * `<raw>/plaid/<connection id>/<UTC timestamp>-<n>-<endpoint>.json.gz`.
 * Files are never overwritten or pruned.
 */
export function createFileArchive(rawDir: string): RawArchive {
  let counter = 0;
  return {
    async write(entry: RawArchiveEntry) {
      const dir = join(rawDir, entry.provider, entry.connectionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stamp = entry.fetchedAt.replace(/[:.]/g, "-");
      const endpoint = entry.endpoint.replace(/^\//, "").replace(/\//g, "_");
      const seq = String(counter++).padStart(4, "0");
      const file = join(dir, `${stamp}-${process.pid}-${seq}-${endpoint}.json.gz`);
      const body = await gzipAsync(Buffer.from(JSON.stringify(entry)));
      // "wx" fails if the file exists: the archive is append-only.
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
    },
  };
}

/** Read archived entries for a connection in the order they were written. */
export async function readArchive(rawDir: string, connectionId: string): Promise<RawArchiveEntry[]> {
  const dir = join(rawDir, "plaid", connectionId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json.gz")).sort();
  } catch {
    return [];
  }
  const entries: RawArchiveEntry[] = [];
  for (const name of names) {
    entries.push(JSON.parse((await gunzipAsync(await readFile(join(dir, name)))).toString("utf8")));
  }
  return entries;
}
