/**
 * Bases availability probe + the headless `nexus-analyze` view registration.
 *
 * ## Why one function does both
 *
 * `Plugin.registerBasesView(viewId, registration)` returns `false` when Bases is
 * not enabled in the vault (public API, `@since 1.10.0`). That single call is
 * therefore both the availability probe and the registration `analyze` needs —
 * so the agent is registered only when the call succeeds, and a vault with Bases
 * off never sees the `base` commands in discovery at all (plan §3). A tool that
 * can only answer "not available" wastes a discovery round-trip.
 *
 * `minAppVersion` is 1.8.7 and the method only exists from 1.10.0, so the
 * `typeof` guard comes first. For the same reason the `BasesView` base class is
 * dereferenced lazily, inside the view factory: `class X extends BasesView` at
 * module scope would throw "Class extends value undefined" on 1.8.7 and take
 * plugin init down with it.
 *
 * ## The registered factory outlives the module that registered it
 *
 * This is the single most important fact in this file, and it shapes everything
 * below. Obsidian keeps the registration until the app process ends. A plugin
 * *reload* gives Nexus a fresh module scope, but Obsidian goes on calling the
 * factory closure from the build that registered first. So:
 *
 *   - Nothing the view does may depend on module-scope state — the module it
 *     closed over may be a previous build's. The rendezvous below lives on a
 *     `globalThis` symbol for exactly that reason.
 *   - The view↔runner contract is a WIRE PROTOCOL between two builds, not an
 *     internal call. {@link ANALYZE_PROTOCOL_VERSION} names its version, the
 *     version is recorded next to the registration, and
 *     {@link analyzeViewProtocolVersion} lets `analyze` fail with "restart
 *     Obsidian" instead of hanging when the live view predates the runner.
 *
 * ### The frozen v1 protocol
 *
 * 1. The view's `onDataUpdated()` looks up `SINKS.get(this.config.name)` and
 *    calls it with the view itself. The view name is the rendezvous key because
 *    the runner chooses it (it writes the scratch view) and `BasesViewConfig.name`
 *    is public API.
 * 2. The view exposes the `QueryController` it was constructed with as
 *    `nexusController`, which is the only way to reach `getSummaryValue`.
 * 3. Harvesting happens on the RUNNER's side, from the live view object. Keeping
 *    the view this dumb is what stops a stale factory from being a stale
 *    serialiser too.
 *
 * Changing any of those three is a protocol break: bump
 * {@link ANALYZE_PROTOCOL_VERSION} and keep the old path working, because a user
 * who updates Nexus without restarting Obsidian keeps the old view.
 *
 * ## The two other spike findings this file exists to handle
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
 *    recorded `true` then describes a registration that no longer exists.
 *    {@link refreshAnalyzeViewRegistration} repairs that: it asks Bases whether
 *    the id is still live and re-registers when it is not. The probe reads
 *    Bases' own registration map, which is not public API, so it is entirely
 *    optional — when the shape is unrecognisable the answer is "assume live",
 *    which is exactly the pre-repair behaviour. Blind re-registration is NOT an
 *    option: it reintroduces finding 1 (a `Notice`) for every user who never
 *    touches the toggle.
 */

// `BasesView` is imported as a VALUE but only dereferenced inside
// `createAnalyzeView`. With esbuild's cjs output `obsidian` is external, so the
// binding resolves at call time (`obsidian.BasesView`), never at module load —
// which is what keeps this file importable on an app that has no Bases API.
import { BasesView } from 'obsidian';
import type { App, BasesViewRegistration, Plugin, QueryController } from 'obsidian';
import { logger } from '../../../utils/logger';

/** View type id for the headless analyze view. */
export const NEXUS_ANALYZE_VIEW_ID = 'nexus-analyze';

/**
 * Version of the view↔runner protocol described in the header. Bump ONLY
 * together with a runner that still understands every older version it may
 * meet in a long-running app.
 */
export const ANALYZE_PROTOCOL_VERSION = 1;

/**
 * Version recorded for a registration made before the protocol existed (the
 * Phase 1 stub view, which never calls a sink). A runner that meets this must
 * not wait for data it will never receive.
 */
export const ANALYZE_PROTOCOL_INERT = 0;

/** A live analyze view handed to whoever is waiting for it. */
export type AnalyzeViewSink = (view: BasesView) => void;

/** Shape of the Bases entry points, optional because they post-date minAppVersion. */
type BasesCapablePlugin = Plugin & {
  registerBasesView?(viewId: string, registration: BasesViewRegistration): boolean;
};

/**
 * App-process-scoped record of view ids we have successfully registered, and
 * the protocol version of the code that registered them.
 *
 * Deliberately on `globalThis` rather than module scope: a plugin reload gets a
 * fresh module scope but talks to the same Obsidian registration table. Phase 1
 * stored a bare `Set<string>` under this same symbol, so a build that meets one
 * migrates it to `ANALYZE_PROTOCOL_INERT` entries rather than discarding it —
 * discarding would re-register and produce the Notice from finding 1.
 */
const REGISTRATION_RECORD = Symbol.for('nexus:bases-view-registrations');

/**
 * Rendezvous table, keyed by scratch view name. FROZEN — the value written here
 * is read by a factory closure that may belong to a different build of Nexus.
 */
const SINK_RECORD = Symbol.for('nexus:bases-analyze-sinks');

// `window`, not `activeWindow`: the record must be one per app, and
// `activeWindow` follows the focused popout. This module only ever runs in the
// main window, where the two are the same object.
type GlobalWithRecord = Window & {
  [REGISTRATION_RECORD]?: Map<string, number> | Set<string>;
  [SINK_RECORD]?: Map<string, AnalyzeViewSink>;
};

function registrations(): Map<string, number> {
  const container = window as GlobalWithRecord;
  const existing = container[REGISTRATION_RECORD];

  if (existing instanceof Map) return existing;

  // Phase 1 shape (Set of ids, no protocol): migrate in place so the recorded
  // registrations survive, marked as the inert views they are.
  const migrated = new Map<string, number>();
  if (existing instanceof Set) {
    for (const viewId of existing) migrated.set(viewId, ANALYZE_PROTOCOL_INERT);
  }
  container[REGISTRATION_RECORD] = migrated;
  return migrated;
}

function sinks(): Map<string, AnalyzeViewSink> {
  const container = window as GlobalWithRecord;
  if (!container[SINK_RECORD]) {
    container[SINK_RECORD] = new Map<string, AnalyzeViewSink>();
  }
  return container[SINK_RECORD];
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
  return registrations().has(NEXUS_ANALYZE_VIEW_ID);
}

/**
 * Protocol version of the LIVE `nexus-analyze` view, or `null` when nothing is
 * registered. `ANALYZE_PROTOCOL_INERT` means an older Nexus registered a view
 * that never reports data — the caller must say so rather than wait.
 */
export function analyzeViewProtocolVersion(): number | null {
  return registrations().get(NEXUS_ANALYZE_VIEW_ID) ?? null;
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
    registrations().set(NEXUS_ANALYZE_VIEW_ID, ANALYZE_PROTOCOL_VERSION);
  } else {
    logger.systemLog('Bases is disabled in this vault — baseManager not registered');
  }

  return registered;
}

/**
 * Repair the registration after a Bases off→on toggle, which wipes Obsidian's
 * table while our record still claims success.
 *
 * Called by `analyze` immediately before it renders, so the common path (no
 * toggle) costs one map lookup. Returns the protocol version now live, or
 * `null` when Bases is off / the app is too old.
 */
export function refreshAnalyzeViewRegistration(app: App, plugin: Plugin): number | null {
  if (isAnalyzeViewRegistered() && basesViewTypeIsLive(app) !== false) {
    return analyzeViewProtocolVersion();
  }

  // Either we never registered, or Bases positively says the id is gone. Drop
  // the stale record so the register call below is actually attempted.
  registrations().delete(NEXUS_ANALYZE_VIEW_ID);
  return ensureAnalyzeViewRegistered(plugin) ? analyzeViewProtocolVersion() : null;
}

/**
 * Ask Bases whether `nexus-analyze` is still in its registration table.
 *
 * NOT public API — `internalPlugins` and the `registrations` map are internals,
 * so every step is optional-chained and any surprise returns `null` ("cannot
 * tell"), which callers must treat as "assume live". Being wrong in that
 * direction costs a timeout with a clear message; being wrong in the other
 * direction shows every user a duplicate-registration Notice.
 */
function basesViewTypeIsLive(app: App): boolean | null {
  try {
    const internal = (app as unknown as {
      internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { registrations?: Record<string, unknown> } }> };
    }).internalPlugins;

    const bases = internal?.plugins?.bases;
    if (!bases) return null;
    if (bases.enabled === false) return false;

    const table = bases.instance?.registrations;
    if (!table || typeof table !== 'object') return null;

    return Object.prototype.hasOwnProperty.call(table, NEXUS_ANALYZE_VIEW_ID);
  } catch {
    return null;
  }
}

/**
 * Wait for the next data update of the scratch view named `viewName`.
 *
 * Registers the sink BEFORE the caller renders, so `onDataUpdated` cannot fire
 * into an empty table. The returned `dispose` MUST run in a `finally` — a
 * leaked sink keeps a view (and its whole query result) reachable forever.
 */
export function awaitAnalyzeView(viewName: string): { view: Promise<BasesView>; dispose: () => void } {
  let settle: ((view: BasesView) => void) | null = null;
  const view = new Promise<BasesView>(resolve => {
    settle = resolve;
  });

  sinks().set(viewName, (updated: BasesView) => {
    // Only the first update matters; later ones would resolve a settled promise.
    settle?.(updated);
    settle = null;
  });

  return {
    view,
    dispose: () => {
      settle = null;
      sinks().delete(viewName);
    }
  };
}

/**
 * Forget the recorded registration. Test-only: production code must not call
 * this, because re-registering an id Obsidian already holds shows the user a
 * Notice and changes nothing.
 */
export function resetAnalyzeViewRegistrationRecord(): void {
  registrations().delete(NEXUS_ANALYZE_VIEW_ID);
  sinks().clear();
}

/**
 * The registration object. Its `factory` is called when Obsidian renders a base
 * whose view `type` is `nexus-analyze` — which only the `analyze` runner's
 * scratch file ever does.
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
 * The headless view: renders nothing, and hands itself to whoever is waiting
 * under its own view name.
 *
 * Everything this function contains is the frozen v1 protocol described in the
 * header — it is called through a closure that may belong to an older build, so
 * treat its body as a published interface rather than as private code.
 *
 * The `BasesView` reference is resolved here, at call time, so this module
 * stays importable on an app without the Bases API.
 */
function createAnalyzeView(controller: QueryController, containerEl: HTMLElement): BasesView {
  // Only reachable through a factory Obsidian itself calls, which requires the
  // 1.10.0+ Bases API to exist.
  class NexusAnalyzeView extends BasesView {
    type = NEXUS_ANALYZE_VIEW_ID;

    /**
     * PROTOCOL v1: the runner reads this to call
     * `BasesQueryResult.getSummaryValue`, which needs the controller and has no
     * other public route to one.
     */
    readonly nexusController: QueryController;

    constructor(queryController: QueryController) {
      super(queryController);
      this.nexusController = queryController;
    }

    onDataUpdated(): void {
      // PROTOCOL v1: rendezvous by view name, hand over the live view. Any
      // throw here happens inside Obsidian's render path, so it is contained.
      try {
        const name = this.config?.name;
        if (typeof name === 'string') {
          (window as GlobalWithRecord)[SINK_RECORD]?.get(name)?.(this);
        }
      } catch (error) {
        logger.systemError(error as Error, 'baseManager - analyze sink threw');
      }
    }
  }

  // The view owns nothing in the DOM; leaving the container untouched is what
  // makes it headless.
  void containerEl;
  return new NexusAnalyzeView(controller);
}
