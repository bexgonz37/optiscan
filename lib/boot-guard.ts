/**
 * boot-guard.ts — the once-per-PROCESS guard for background runtime startup.
 *
 * Extracted from server-boot.ts so the invariant can be tested without importing
 * the boot module itself (which calls require("@/lib/...") and would really start
 * the scanner, scheduler, paper engine and graders).
 *
 * WHY PROCESS-LEVEL, NOT MODULE-LEVEL: webpack inlines server-boot into more than
 * one server chunk — instrumentation boots it, /api/healthz kickstarts it off the
 * Railway probe, and 34 API routes call deferServerBoot. Verified in the built
 * artifact: the module body appears in two separate chunks. Module-scoped flags
 * would therefore exist more than once in a single process and start every
 * background worker twice. A Symbol.for key lives in the cross-realm global
 * registry, so every copy of the module resolves to the SAME state object.
 *
 * The claim* helpers are the only safe way to read it: they test and set in one
 * step, so two callers can never both believe they are first.
 */

export const BOOT_STATE_KEY = Symbol.for("optiscan.serverBoot");

export interface BootState {
  started: boolean;
  bootScheduled: boolean;
}

type GlobalScope = Record<PropertyKey, unknown>;

/** The shared state object for a scope. `scope` is injectable for tests only. */
export function bootState(scope: GlobalScope = globalThis as unknown as GlobalScope): BootState {
  const existing = scope[BOOT_STATE_KEY] as BootState | undefined;
  if (existing) return existing;
  const fresh: BootState = { started: false, bootScheduled: false };
  scope[BOOT_STATE_KEY] = fresh;
  return fresh;
}

/**
 * Claim the right to run the real boot. Returns true for exactly ONE caller per
 * scope; every later caller gets false and must do nothing.
 */
export function claimBootStart(scope?: GlobalScope): boolean {
  const state = bootState(scope);
  if (state.started) return false;
  state.started = true;
  return true;
}

/**
 * Claim the right to SCHEDULE a deferred boot. Returns false when boot has already
 * run or is already scheduled, so repeated requests collapse into one.
 */
export function claimBootSchedule(scope?: GlobalScope): boolean {
  const state = bootState(scope);
  if (state.started || state.bootScheduled) return false;
  state.bootScheduled = true;
  return true;
}

/** True once the real boot has been claimed. Read-only. */
export function bootHasStarted(scope?: GlobalScope): boolean {
  return bootState(scope).started;
}
