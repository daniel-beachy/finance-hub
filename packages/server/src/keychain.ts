import { execFile, spawn } from "node:child_process";
import type { SecretStore } from "@finance-hub/core";

const SERVICE = "finance-hub";
/** `security` exit code for "item not found". */
const NOT_FOUND = 44;
/** Values are passed to `security -i` on stdin, so keep them to a safe alphabet. */
const SAFE_VALUE = /^[A-Za-z0-9._\-+=/:]+$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function run(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", args, (err, stdout) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? (err.code as number) : 0, stdout });
    });
  });
}

/**
 * Secrets in the macOS login Keychain under the service "finance-hub".
 * Values are never written to disk by this app and never logged.
 */
export function createKeychainStore(service = SERVICE): SecretStore {
  return {
    async get(name) {
      const { code, stdout } = await run(["find-generic-password", "-s", service, "-a", name, "-w"]);
      if (code === NOT_FOUND) return null;
      if (code !== 0) throw new Error(`Keychain read failed for ${name} (exit ${code})`);
      return stdout.replace(/\n$/, "");
    },
    async set(name, value) {
      if (!SAFE_NAME.test(name)) throw new Error("Unsupported secret name");
      if (!SAFE_VALUE.test(value)) throw new Error("Secret contains characters this store does not accept");
      // The value goes over stdin to `security -i`, not on the command line,
      // so it never shows up in the process list.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`Keychain write failed for ${name} (exit ${code})`)),
        );
        child.stdin.end(`add-generic-password -U -s ${service} -a ${name} -w ${value}\n`);
      });
      const check = await run(["find-generic-password", "-s", service, "-a", name]);
      if (check.code !== 0) throw new Error(`Keychain write for ${name} could not be confirmed`);
    },
    async delete(name) {
      const { code } = await run(["delete-generic-password", "-s", service, "-a", name]);
      if (code !== 0 && code !== NOT_FOUND) throw new Error(`Keychain delete failed for ${name} (exit ${code})`);
    },
  };
}
