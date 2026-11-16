import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LABEL = "com.finance-hub.sync";
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const SYNC_HOUR = 6;
export const SYNC_MINUTE = 30;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface PlistOptions {
  node: string;
  bin: string;
  repo: string;
  log: string;
  dataDir?: string;
}

/**
 * The launchd job: `fh sync --trigger schedule` every day at 06:30, or at
 * wake if the Mac was asleep then. It runs through /bin/bash, and not
 * straight into node, so it inherits the Full Disk Access that lets bash
 * reach iCloud Drive for the backup copy. The trailing `exit` stops bash
 * from replacing itself with node.
 */
export function plistFor(o: PlistOptions): string {
  const command = `${sh(o.node)} ${sh(o.bin)} sync --trigger schedule; exit $?`;
  const env = [`<key>PATH</key><string>${xml(`${dirname(o.node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>`];
  if (o.dataDir) env.push(`<key>FH_DATA_DIR</key><string>${xml(o.dataDir)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-c</string><string>${xml(command)}</string></array>
  <key>WorkingDirectory</key><string>${xml(o.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>${env.join("")}</dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${SYNC_HOUR}</integer><key>Minute</key><integer>${SYNC_MINUTE}</integer></dict>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/**
 * The node to run. Homebrew's `process.execPath` is a versioned Cellar path
 * that disappears on the next `brew upgrade`, so prefer a stable link that
 * points at the same binary.
 */
export function stableNodePath(execPath = process.execPath, candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(execPath);
  return candidates.find((c) => target !== null && real(c) === target) ?? execPath;
}

/** Paths for the job, taken from the running CLI. */
export function defaultPlistOptions(log: string): PlistOptions {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    node: stableNodePath(),
    bin: resolve(here, "..", "bin", "fh.js"),
    repo: resolve(here, "..", "..", ".."),
    log,
    dataDir: process.env.FH_DATA_DIR,
  };
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

/** Write the job and (re)load it. Safe to run again. */
export async function installSchedule(options: PlistOptions): Promise<void> {
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(options.log), { recursive: true, mode: 0o700 });
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await writeFile(PLIST, plistFor(options), { mode: 0o644 });
  await run("plutil", ["-lint", "-s", PLIST]);
  await run("launchctl", ["bootstrap", domain(), PLIST]);
}

/** Unload and remove the job. Leaves data and backups alone. */
export async function uninstallSchedule(): Promise<boolean> {
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  if (!existsSync(PLIST)) return false;
  await rm(PLIST, { force: true });
  return true;
}

export async function scheduleLoaded(): Promise<boolean> {
  return run("launchctl", ["print", `${domain()}/${LABEL}`]).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// The MCP server's registration with Claude

export const MCP_NAME = "finance-hub";
export const CLAUDE_DESKTOP_CONFIG = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** How Claude starts `fh mcp`: the same node and fh.js as the daily sync. */
export function mcpLaunch(o: Pick<PlistOptions, "node" | "bin" | "dataDir">): McpLaunch {
  return { command: o.node, args: [o.bin, "mcp"], env: o.dataDir ? { FH_DATA_DIR: o.dataDir } : {} };
}

/** The block to paste under "mcpServers" in Claude desktop's config. */
export function desktopConfigBlock(launch: McpLaunch): string {
  const entry: Record<string, unknown> = { command: launch.command, args: launch.args };
  if (Object.keys(launch.env).length) entry.env = launch.env;
  return JSON.stringify({ mcpServers: { [MCP_NAME]: entry } }, null, 2);
}

/** Arguments for `claude mcp add`, user scope, so every project sees it. */
export function claudeAddArgs(launch: McpLaunch): string[] {
  const env = Object.entries(launch.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["mcp", "add", "--scope", "user", ...env, MCP_NAME, "--", launch.command, ...launch.args];
}

/**
 * Register with Claude Code. Replaces an earlier registration of the same
 * name, so running install again picks up a moved repo or a new node.
 * Returns null when it worked, else why not (the caller prints the command).
 */
export async function registerWithClaudeCode(launch: McpLaunch): Promise<string | null> {
  try {
    await run("claude", ["--version"]);
  } catch {
    return "the claude command isn't on PATH";
  }
  await run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]).catch(() => {});
  try {
    await run("claude", claudeAddArgs(launch));
    return null;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr || e.message || String(err)).trim();
  }
}

/** Text for AppleScript's string literal. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Post a macOS notification. Never throws: a missed notification must not fail a sync. */
export async function notify(message: string, title = "Finance Hub"): Promise<void> {
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  await run("osascript", ["-e", script]).catch(() => {});
}
