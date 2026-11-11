import type { SqlDriver } from "./driver.ts";
import { migrations } from "./migrations/index.ts";
import { seedReferenceData } from "./seed.ts";

/** Apply every migration that has not run yet, then make sure seed data exists. */
export async function migrate(db: SqlDriver, now: () => Date = () => new Date()): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const done = new Set((await db.all<{ id: number }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.transaction(async () => {
      await db.exec(m.sql);
      await db.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        m.id,
        m.name,
        now().toISOString(),
      ]);
    });
    applied.push(m.name);
  }
  await seedReferenceData(db);
  return applied;
}
