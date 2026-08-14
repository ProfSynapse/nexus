/**
 * Bases availability probe + the headless `nexus-analyze` view registration.
 *
 * ## Why one function does both
 *
 * `Plugin.registerBasesView(viewId, registration)` returns `false` when Bases is
 * not enabled in the vault (public API, `@since 1.10.0`). That single call is
 * therefore both the availability probe and the registration Phase 3's
 * `analyze` needs — so the agent is registered only when the call succeeds, and
 * a vault with Bases off never sees the `base` commands in discovery at all
 * (plan §3). A tool that can only answer "not available" wastes a discovery
 * round-trip.
 *
 * `minAppVersion` is 1.8.7 and the method only exists from 1.10.0, so the
 * `typeof` guard comes first. For the same reason the `BasesView` base class is
 * dereferenced lazily, inside the view factory: `class X extends BasesView` at
 * module scope would throw "Class extends value undefined" on 1.8.7 and take
 * plugin init down with it.
 *
 * ## The two spike findings this file exists to handle
 *
 * 1. **Registering a duplicate view id is not a no-op.** Obsidian keeps the
 *    FIRST registration, still returns `true`, and shows the user a `Notice`.
 *    Re-registering on every plugin reload would therefore be user-visible
 *    noise. So a successful registration is recorded on a `globalThis` symbol,
 *    which outlives the plugin's module scope but not the app process — the
 *    same lifetime as Obsidian's own registration table. A reload of Nexus then
 *    reuses the recorded result instead of registering again.
 *
 *    Only successes are recorded. A `false` (Bases off) is deliberately NOT
 *    cached, because "enable Bases, then reload the plugin" is the documented
 *    way to get the agent to appear and a cached `false` would defeat it.
 *
 * 2. **Toggling the Bases core plugin off wipes the registration table.** Our
 *    recorded `true` then describes a registration that no longer exists, and
 *    `nexus-analyze` is a dead view type until Obsidian restarts. This is
 *    knowingly not repaired: detecting it needs either a poll or Obsidian's
 *    internal plugin events, and re-registering blindly reintroduces finding 1
 *    for every user who never touches the toggle. Runtime toggling is explicitly
 *    out of scope in plan §3 — enabling or disabling Bases mid-session means a
 *    restart. Phase 3's `analyze` must surface a clear error when its render
 *    never produces data rather than hanging, since a dead view type looks
 *    exactly like a slow query.
 */

// `BasesView` is imported as a VALUE but only dereferenced inside
// `createAnalyzeView`. With esbuild's cjs output `obsidian` is external, so the
// binding resolves at call time (`obsidian.BasesView`), never at module load —
// which is what keeps this file importable on an app that has no Bases API.
import { BasesView } from 'obsidian';
import type { BasesViewRegistration, Plugin, QueryController } from 'obsidian';
import { logger } from '../../../utils/logger';

/** View type id for the headless analyze view. Phase 3 fills in the body. */
export const NEXUS_ANALYZE_VIEW_ID = 'nexus-analyze';

/** Shape of the Bases entry points, optional because they post-date minAppVersion. */
type BasesCapablePlugin = Plugin & {
  registerBasesView?(viewId: string, registration: BasesViewRegistration): boolean;
};

/**
 * App-process-scoped record of view ids we have successfully registered.
 * Deliberately on `globalThis` rather than module scope: a plugin reload gets a
 * fresh module scope but talks to the same Obsidian registration table.
 */
const REGISTRATION_RECORD = Symbol.for('nexus:bases-view-registrations');

// `window`, not `activeWindow`: the record must be one per app, and
// `activeWindow` follows the focused popout. This module only ever runs in the
// main window, where the two are the same object.
type GlobalWithRecord = Window & { [REGISTRATION_RECORD]?: Set<string> };

function registeredViewIds(): Set<string> {
  const container = window as GlobalWithRecord;
  if (!container[REGISTRATION_RECORD]) {
    container[REGISTRATION_RECORD] = new Set<string>();
  }
  return container[REGISTRATION_RECORD];
}

/**
 * The `registerBasesView` entry point, or null on an app that predates it.
 *
 * This is the ONLY place the method is named. `obsidianmd/no-unsupported-api`
 * correctly points out that it requires 1.10.0 while `minAppVersion` is 1.8.7 —
 * the `typeof` check here IS the mitigation the rule is asking for, and it is
 * why nothing below can call into an API the running app does not have.
 */
function basesViewApi(plugin: Plugin): ((viewId: string, registration: BasesViewRegistration) => boolean) | null {
  const register = (plugin as BasesCapablePlugin).registerBasesView;
  return typeof register === 'function' ? register.bind(plugin) : null;
}

/** True when the running app exposes the Bases view API at all (1.10.0+). */
export function supportsBasesViews(plugin: Plugin): boolean {
  return basesViewApi(plugin) !== null;
}

/** True when `nexus-analyze` was registered in this app process. */
export function isAnalyzeViewRegistered(): boolean {
  return registeredViewIds().has(NEXUS_ANALYZE_VIEW_ID);
}

/**
 * Register the headless `nexus-analyze` view, and report whether Bases is
 * available.
 *
 * @returns `false` when the app predates the API or Bases is disabled — in
 * which case the caller must NOT register the agent.
 */
export function ensureAnalyzeViewRegistered(plugin: Plugin): boolean {
  const register = basesViewApi(plugin);

  if (!register) {
    logger.systemLog('Bases view API unavailable (app older than 1.10.0) — baseManager not registered');
    return false;
  }

  // Already registered in this app process: reusing the recorded result avoids
  // the duplicate-registration Notice on a plugin reload (finding 1 above).
  if (isAnalyzeViewRegistered()) {
    return true;
  }

  let registered = false;
  try {
    registered = register(NEXUS_ANALYZE_VIEW_ID, createAnalyzeRegistration());
  } catch (error) {
    logger.systemError(error as Error, 'baseManager - registerBasesView threw');
    return false;
  }

  if (registered) {
    registeredViewIds().add(NEXUS_ANALYZE_VIEW_ID);
  } else {
    logger.systemLog('Bases is disabled in this vault — baseManager not registered');
  }

  return registered;
}

/**
 * Forget the recorded registration. Test-only: production code must not call
 * this, because re-registering an id Obsidian already holds shows the user a
 * Notice and changes nothing.
 */
export function resetAnalyzeViewRegistrationRecord(): void {
  registeredViewIds().delete(NEXUS_ANALYZE_VIEW_ID);
}

/**
 * The registration object. Its `factory` is only called when Obsidian renders a
 * base whose view `type` is `nexus-analyze` — which nothing does until Phase 3,
 * so today it hands back an inert view.
 */
function createAnalyzeRegistration(): BasesViewRegistration {
  return {
    name: 'Nexus analyze',
    icon: 'bot',
    factory: (controller: QueryController, containerEl: HTMLElement) =>
      createAnalyzeView(controller, containerEl)
  };
}

/**
 * Stub headless view: renders nothing and ignores data updates.
 *
 * PHASE 3: `onDataUpdated()` is where the query result is harvested — resolve a
 * pending promise with a snapshot of `this.data` (entries, `groupedData`,
 * `properties`) rather than rendering. Everything else here already holds: the
 * view type is registered, and it must keep rendering nothing.
 *
 * The `BasesView` reference is resolved here, at call time, so this module
 * stays importable on an app without the Bases API.
 */
function createAnalyzeView(controller: QueryController, containerEl: HTMLElement): BasesView {
  // Only reachable through a factory Obsidian itself calls, which requires the
  // 1.10.0+ Bases API to exist.
  class NexusAnalyzeView extends BasesView {
    type = NEXUS_ANALYZE_VIEW_ID;

    constructor(queryController: QueryController) {
      super(queryController);
    }

    onDataUpdated(): void {
      // Intentionally inert until Phase 3.
    }
  }

  // The view owns nothing in the DOM; leaving the container untouched is what
  // makes it headless.
  void containerEl;
  return new NexusAnalyzeView(controller);
}
