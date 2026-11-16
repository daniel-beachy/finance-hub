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
  /** The response body, or null when Plaid answered with an error. */
  response: unknown;
  /** Plaid's error answer, archived too so a replay fails where the live sync failed. */
  error?: { status: number; error_type: string; error_code: string; error_message: string };
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
