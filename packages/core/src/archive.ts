/**
 * Append-only store for raw provider responses. Every response is written
 * here before it is applied to the database, so history fetched once from
 * Plaid survives any bug in our own parsing.
 */
export interface RawArchiveEntry {
  provider: "plaid";
  connectionId: string;
  endpoint: string;
  fetchedAt: string;
  env: string;
  /** Request parameters needed to replay. Never contains secrets. */
  request: Record<string, unknown>;
  response: unknown;
}

export interface RawArchive {
  write(entry: RawArchiveEntry): Promise<void>;
}

export function createMemoryArchive(): RawArchive & { entries: RawArchiveEntry[] } {
  const entries: RawArchiveEntry[] = [];
  return {
    entries,
    write: async (entry) => void entries.push(structuredClone(entry)),
  };
}
