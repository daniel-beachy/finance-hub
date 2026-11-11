import { type CoreDeps, createIdFactory, migrate } from "@finance-hub/core";
import { createFileArchive } from "./archive.ts";
import { createKeychainStore } from "./keychain.ts";
import { openNodeDatabase } from "./nodeDriver.ts";
import { dataPaths, type DataPaths, ensureDataDirs } from "./paths.ts";

export interface AppContext {
  deps: CoreDeps;
  paths: DataPaths;
  close(): void;
}

/** Open the real data directory and wire core to the Keychain and disk. */
export async function openContext(): Promise<AppContext> {
  const paths = dataPaths();
  ensureDataDirs(paths);
  const db = openNodeDatabase(paths.db);
  await migrate(db.driver);
  const deps: CoreDeps = {
    db: db.driver,
    secrets: createKeychainStore(),
    archive: createFileArchive(paths.raw),
    now: () => new Date(),
    newId: createIdFactory(),
  };
  return { deps, paths, close: db.close };
}
