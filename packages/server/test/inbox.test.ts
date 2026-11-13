import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDiskInbox, safeName } from "../src/inbox.ts";

describe("disk inbox", () => {
  it("keeps names inside the inbox", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\History.csv")).toBe("History.csv");
    expect(safeName(".hidden")).toBe("hidden");
    expect(safeName("a/b<c>.csv")).toBe("b_c_.csv");
  });

  it("never overwrites, and archives files unchanged under a dated name", async () => {
    const root = mkdtempSync(join(tmpdir(), "fh-inbox-"));
    const inboxDir = join(root, "inbox");
    const importedDir = join(root, "imported");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(inboxDir);
    const inbox = createDiskInbox(inboxDir, importedDir, () => new Date("2026-11-12T10:00:00Z"));
    expect(await inbox.put("a.csv", new TextEncoder().encode("one"))).toBe("a.csv");
    expect(await inbox.put("a.csv", new TextEncoder().encode("two"))).toBe("a (1).csv");
    expect((await inbox.list()).map((f) => f.name)).toEqual(["a (1).csv", "a.csv"]);
    await inbox.archive("a.csv");
    expect(readdirSync(importedDir)).toEqual(["2026-11-12T10-00-00-000Z-a.csv"]);
    expect(readFileSync(join(importedDir, "2026-11-12T10-00-00-000Z-a.csv"), "utf8")).toBe("one");
    await inbox.discard("a (1).csv");
    expect(await inbox.list()).toEqual([]);
  });
});
