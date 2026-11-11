import type { RawArchive } from "./archive.ts";
import type { SqlDriver } from "./db/driver.ts";
import type { FetchLike } from "./plaid/client.ts";
import type { SecretStore } from "./secrets.ts";
import type { IdFactory } from "./util/ids.ts";

/** Everything core needs from its host (Node server, browser demo, tests). */
export interface CoreDeps {
  db: SqlDriver;
  secrets: SecretStore;
  archive: RawArchive;
  now: () => Date;
  newId: IdFactory;
  fetch?: FetchLike;
}

/** `YYYY-MM-DD` in the host's local time zone: "today" as the user sees it. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
