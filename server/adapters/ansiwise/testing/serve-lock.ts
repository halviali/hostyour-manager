// ONE REAL SERVE PER DRIVE AT A TIME, ACROSS PROCESSES. The engine's run root is a compile-time
// constant of the machine's own code (serve-fixture.ts runRoot: `/var/lib/ansiwise/runs`, on Windows
// on the drive of the working directory), so two vitest processes on one workstation — two worktrees
// running scripts/check.sh at once — share it: each reads the other's records into its window
// (ansiwise-serve.fixture.ts recordWindow) and each close() removes the root from under the other.
// vitest's fileParallelism keeps ONE process's files apart (#72); this keeps processes apart (#186).
//
// The lock is a directory beside the run root, taken by mkdir, which is atomic on every platform the
// suite runs on: the one process whose mkdir succeeds holds it. The holder's pid stands inside, so a
// lock a dead process left behind is taken over rather than waited on forever; a live holder is
// waited for, because the alternative is the red run this lock exists to prevent.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SERVE_LOCK_NAME = "serve.lock";
const PID_FILE = "pid";

/** WHERE the lock stands for the run root at [root]: beside it, never inside it — close() removes
 *  the root whole. */
export function serveLockPath(root: string): string {
  return join(dirname(root), SERVE_LOCK_NAME);
}

/** Is a process with this pid alive? Signal 0 delivers nothing and answers the question; EPERM is a
 *  process that exists and is not ours, which is alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ServeLockOptions {
  pid?: number;
  alive?: (pid: number) => boolean;
  pollMs?: number;
  /** How long to wait for a live holder before refusing, naming it. */
  timeoutMs?: number;
}

/** Take the lock at [path], waiting for a live holder and taking over from a dead one. Resolves to
 *  the release; refuses after [timeoutMs] naming the holder's pid, because a lock held longer than a
 *  whole check takes is a process that will not finish, not one to wait for. */
export async function acquireServeLock(path: string, opts: ServeLockOptions = {}): Promise<() => void> {
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? processAlive;
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(path, { recursive: false });
      writeFileSync(join(path, PID_FILE), String(pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = holderOf(path);
    if (holder !== null && !alive(holder)) {
      // A lock a dead process left: take it over. The removal can race another waiter doing the same;
      // whichever mkdir wins next holds it, and the loser waits on a live holder.
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the real-serve lock ${path} is held by process ${holder ?? "(unknown)"} for longer than ${Math.round(timeoutMs / 60_000)} minutes — ` +
          "one real serve runs per drive at a time, and that process has not finished its check; end it, or remove the lock if it is not a check at all",
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function holderOf(path: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(join(path, PID_FILE), "utf8"), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    // The directory stands but the pid is not written yet: a holder mid-take. Treated as live.
    return null;
  }
}
