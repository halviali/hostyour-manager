// The catalog's trunk carried into this installation's books branch on a TIMER — the third road
// beside the boot (boot.ts, behind the listener) and the tenant plan (create-tenant.run.ts). A member
// Application of a standing tenant follows the books branch, so without this a chart fix pushed to
// the catalog's trunk reached a standing tenant only when somebody booted the Manager or planned a
// tenant (#169). A merge with nothing to bring in is "Already up to date" and pushes nothing
// (adapters/git/git.ts carryTrunkToBooksBranch), so a tick with no change costs one fetch.
import type { Logger } from "../kernel/logger.ts";

export const CARRY_INTERVAL_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;

/** Run `carry` every `intervalMs`, never overlapping and never throwing through the timer: the
 *  carry boot hands in (Wired.carryCatalogTrunk) already logs and swallows its own failure. Unref'd,
 *  so a Manager that is shutting down is not held open by it. Idempotent: a second call schedules
 *  nothing. */
export function scheduleCatalogCarry(carry: () => Promise<void>, logger: Logger, intervalMs = CARRY_INTERVAL_MS): void {
  if (timer) return;
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void carry()
      .catch((err: unknown) => logger.error({ err: String(err) }, "the scheduled catalog carry threw past its own guard"))
      .finally(() => {
        inFlight = false;
      });
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  logger.info({ intervalMinutes: intervalMs / 60_000 }, "catalog carry scheduled");
}

/** Stops the schedule — tests, and nothing else, call it. */
export function stopCatalogCarrySchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
