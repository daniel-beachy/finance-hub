import { SEED_GROUPS } from "../seed/categories.ts";
import { PLAID_CATEGORY_MAP } from "../seed/plaidCategoryMap.ts";
import type { SqlDriver } from "./driver.ts";

export const DEFAULT_OWNER_ID = "owner-1";

/**
 * Insert reference data that is missing. Uses INSERT OR IGNORE so it never
 * overwrites a category the user renamed or hid.
 */
export async function seedReferenceData(db: SqlDriver): Promise<void> {
  await db.transaction(async () => {
    await db.run("INSERT OR IGNORE INTO owners (id, name) VALUES (?, ?)", [DEFAULT_OWNER_ID, "Me"]);
    let groupSort = 0;
    for (const group of SEED_GROUPS) {
      await db.run("INSERT OR IGNORE INTO category_groups (id, name, sort) VALUES (?, ?, ?)", [
        group.id,
        group.name,
        groupSort++,
      ]);
      let sort = 0;
      for (const [suffix, name] of group.categories) {
        await db.run(
          "INSERT OR IGNORE INTO categories (id, group_id, name, kind, sort) VALUES (?, ?, ?, ?, ?)",
          [`${group.id}.${suffix}`, group.id, name, group.kind, sort++],
        );
      }
    }
    for (const [key, categoryId] of Object.entries(PLAID_CATEGORY_MAP)) {
      await db.run("INSERT OR IGNORE INTO plaid_category_map (pfc_key, category_id) VALUES (?, ?)", [
        key,
        categoryId,
      ]);
    }
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('plaid_env', '\"sandbox\"')");
  });
}

export async function getSetting<T>(db: SqlDriver, key: string, fallback: T): Promise<T> {
  const rows = await db.all<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  return rows[0] ? (JSON.parse(rows[0].value) as T) : fallback;
}

export async function setSetting(db: SqlDriver, key: string, value: unknown): Promise<void> {
  await db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}
