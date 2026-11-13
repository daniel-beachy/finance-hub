import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { InboxFile, InboxStore } from "@finance-hub/core";

/** Largest file the inbox accepts. Real exports are far smaller. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** A file name safe to write: no directories, no hidden files. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "");
  return base || "upload";
}

/**
 * `<data>/inbox/` on disk. Processed files move to `<data>/imported/`
 * unchanged, under a dated name so two downloads called the same thing
 * never collide.
 */
export function createDiskInbox(inboxDir: string, importedDir: string, now: () => Date = () => new Date()): InboxStore {
  return {
    async list(): Promise<InboxFile[]> {
      const names = (await readdir(inboxDir)).filter((n) => !n.startsWith(".")).sort();
      const files: InboxFile[] = [];
      for (const name of names) {
        const path = join(inboxDir, name);
        if (!(await stat(path)).isFile()) continue;
        files.push({ name, bytes: new Uint8Array(await readFile(path)) });
      }
      return files;
    },
    async put(name, bytes) {
      if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error(`${name} is larger than 20 MB`);
      const clean = safeName(name);
      const ext = extname(clean);
      const stem = clean.slice(0, clean.length - ext.length);
      for (let n = 0; ; n++) {
        const candidate = n === 0 ? clean : `${stem} (${n})${ext}`;
        try {
          await writeFile(join(inboxDir, candidate), bytes, { flag: "wx", mode: 0o600 });
          return candidate;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
    },
    async archive(name) {
      await mkdir(importedDir, { recursive: true, mode: 0o700 });
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      await rename(join(inboxDir, safeName(name)), join(importedDir, `${stamp}-${safeName(name)}`));
    },
    async discard(name) {
      await rm(join(inboxDir, safeName(name)));
    },
  };
}
