// The cross-process lock on the engine's run root (serve-lock.ts): one real serve per drive at a
// time, a dead holder's lock taken over, a live holder waited for and then refused by name.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServeLock, serveLockPath } from "./serve-lock.ts";

const dirs: string[] = [];
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "serve-lock-"));
  dirs.push(dir);
  return serveLockPath(join(dir, "runs"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the real-serve lock", () => {
  it("stands beside the run root, never inside it", () => {
    expect(serveLockPath("/var/lib/ansiwise/runs").replaceAll("\\", "/")).toBe("/var/lib/ansiwise/serve.lock");
  });

  it("a second taker waits until the first releases", async () => {
    const path = lockPath();
    const release = await acquireServeLock(path, { pid: 1001, alive: () => true, pollMs: 10 });
    expect(readFileSync(join(path, "pid"), "utf8")).toBe("1001");
    let second: (() => void) | null = null;
    const waiting = acquireServeLock(path, { pid: 1002, alive: () => true, pollMs: 10 }).then((r) => { second = r; });
    await new Promise((r) => setTimeout(r, 60));
    expect(second).toBeNull(); // still held by 1001
    release();
    await waiting;
    expect(readFileSync(join(path, "pid"), "utf8")).toBe("1002");
    second!();
    expect(existsSync(path)).toBe(false);
  });

  it("takes over a lock a dead process left behind", async () => {
    const path = lockPath();
    await acquireServeLock(path, { pid: 4242, alive: () => true, pollMs: 10 }); // never released
    const release = await acquireServeLock(path, { pid: 4343, alive: (pid) => pid !== 4242, pollMs: 10, timeoutMs: 1000 });
    expect(readFileSync(join(path, "pid"), "utf8")).toBe("4343");
    release();
  });

  it("refuses after the timeout, naming the live holder", async () => {
    const path = lockPath();
    await acquireServeLock(path, { pid: 777, alive: () => true, pollMs: 10 });
    await expect(acquireServeLock(path, { pid: 778, alive: () => true, pollMs: 10, timeoutMs: 50 })).rejects.toThrow(/held by process 777/);
  });
});
