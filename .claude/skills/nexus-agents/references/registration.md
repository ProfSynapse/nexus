# Registration and what actually gates an agent

Context: where an agent gets wired, why ordering matters, and which
capability-gating patterns in this codebase work versus which only look like
they do. Read before adding an agent or making one conditional.

## Key idea
There are two registration paths and they are not interchangeable. A **core
agent** is initialized at startup by `src/services/agent/AgentInitializationService.ts`
and wired into a phase of `doInitializeAllAgents()` in
`src/services/agent/AgentRegistrationService.ts`. An **app agent** is opt-in,
extends `BaseAppAgent`, and is created by a factory in the built-in registry
inside `src/services/apps/AppManager.ts`.

No factory classes, no ServiceDefinitions entry, for either.

## Phase order, and why ToolManager is last
`doInitializeAllAgents()` runs four phases:

1. Independent agents, in parallel.
2. Dependent agents, in parallel. Cross-agent wiring (currently TaskService into
   MemoryManager) happens after this phase, once both sides exist.
3. App agents, via `AppManager.loadInstalledApps()`.
4. ToolManager — last, always.

ToolManager is last because `ToolManagerAgent` holds `allAgents`, a snapshot of
the registry taken when it is constructed. An agent initialized after it is
invisible to `getTools` unless something calls `registerDynamicAgent`.

Every phase entry goes through `safeInitialize(name, fn)`, which catches and logs
any throw and records it in `initializationErrors`. A failed agent is therefore
**absent rather than half-registered**, which is the correct outcome: a tool that
can only answer "unavailable" wastes a discovery round-trip.

## Making an agent conditional
Return early from the initializer when a hard dependency is missing. That is the
whole pattern — `safeInitialize` handles the rest. For a single tool rather than
a whole agent, register it conditionally in the agent constructor.

## The gating anti-pattern in this codebase
`enableSearchModes` and `enableLLMModes` are threaded from
`getCapabilityStatus()` into the initializers and **gate nothing**. Verify before
copying either:

- `initializeSearchManager(enableSearchModes, …)` passes the flag into
  `SearchManagerAgent`, whose constructor names that parameter
  `_enableVectorModes` and ignores it. All its tools register regardless.
- `initializePromptManager(enableLLMModes)` uses the flag to decide whether to
  build a full `LLMProviderManager`, then registers PromptManager either way —
  the `else` branch constructs a minimal provider manager and registers the agent
  anyway.

Copying that shape produces a flag a reader believes is load-bearing and a build
that ships every tool regardless.

## Gating patterns that do work
- **Opt-in installation.** An app agent only becomes an agent when its config
  exists and is enabled; `getAvailableApps()` reports `installed`, `enabled` and
  `configured` separately.
- **Platform.** The built-in app registry adds desktop-only apps inside an
  `isDesktop()` guard, so heavy Node-dependent runtimes never register on mobile.
  See the `nexus-mobile-compat` skill before adding one.
- **Credentials.** `BaseAppAgent.hasRequiredCredentials()` drives a dynamic
  `description` getter that appends a `SETUP REQUIRED` notice naming the missing
  fields, and `validate()` refuses with `Missing required credentials`. The agent
  stays present and honest instead of vanishing.

## Dynamic registration at runtime
`AppManager` installs and uninstalls agents after startup. `AgentRegistrationService`
wraps its register/unregister callbacks with a `syncToolManagerAgent` bridge that
does a two-step dance: `AgentManager.registerAgent` plus
`ToolManagerAgent.registerDynamicAgent`, which also refreshes the `getTools`
description.

This works only because `AppManager` is the sole dynamic registrar. It does not
compose for a second one: the coupling lives in the caller, so every new
registrar must be hand-wired and must never forget the sync half, or `getTools`
silently hides the agent. When a second registrar actually lands, replace the
bridge with `onAgentRegistered`/`onAgentUnregistered` events on `AgentManager`
subscribed once in `ToolManagerAgent` — the plan is written up at
https://github.com/ProfSynapse/nexus/issues/174 and is explicitly deferred until
a real second consumer shapes the contract. Do not do it speculatively.
