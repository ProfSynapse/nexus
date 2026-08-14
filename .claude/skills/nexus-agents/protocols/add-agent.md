# Protocol: add an agent

Context: you are adding a new agent, not a tool on an existing one. Two kinds
exist and they are wired in different places: a **core agent** starts with the
plugin, an **app agent** is opt-in and installed through settings. Background:
`../references/registration.md`.

## Mission
Get a new agent registered so its tools appear in `getTools` discovery and
execute through `useTools`, without disturbing initialization order.

## Steps
1. Choose the kind first, because it decides everything after it. Core agent:
   always available, no credentials, part of the plugin's baseline. App agent:
   opt-in, may carry credentials, may be desktop-only, extends `BaseAppAgent`
   and declares an `AppManifest`. If it needs an API key or a heavy runtime, it
   is an app agent.
2. Write the agent class extending `BaseAgent` (or `BaseAppAgent`), registering
   its tools in the constructor per `add-tool.md`. Check the agent name against
   the transform — the alias is `toKebabCase(agentName)`, with a trailing
   `Manager`/`Agent`/`Tools` stripped:
   ```bash
   python3 .claude/skills/nexus-agents/scripts/cli_name.py <yourAgentName>
   ```
3. For a **core agent**, wire exactly two touchpoints:
   - `initializeYourAgent()` in `src/services/agent/AgentInitializationService.ts`
   - `safeInitialize('yourAgent', …)` inside the right phase of
     `doInitializeAllAgents()` in `src/services/agent/AgentRegistrationService.ts`
     — phase 1 for no dependencies, phase 2 for dependent agents, phase 3 for
     apps. Phase 4 is ToolManager and it MUST stay last, because it snapshots
     the registry of everything else.
4. For an **app agent**, add a factory to the built-in registry in
   `src/services/apps/AppManager.ts` (the block marked `ADD NEW APPS HERE`), and
   declare required credentials in the manifest so `hasRequiredCredentials()`
   can surface a setup notice instead of failing opaquely. Put a desktop-only
   app behind the `isDesktop()` guard already in that registry, and read the
   `nexus-mobile-compat` skill before adding a Node-dependent runtime.
5. Make it conditional by returning early from the initializer when a hard
   dependency is missing. Do NOT thread a boolean flag through in imitation of
   `enableSearchModes`/`enableLLMModes` — those gate nothing, and
   `../references/registration.md` shows why.
6. Confirm your agent is not depending on another agent initialized in the same
   parallel phase. Cross-agent wiring belongs after the phase, where the
   TaskService-into-MemoryManager wiring already lives.
7. Verify. Run `verify.md`.

## Guidelines
- Pattern: let a broken agent be absent. `safeInitialize` catches the throw and
  logs it, which is the designed outcome — half-registered is worse.
- Pattern: an app agent whose credentials are missing should stay present and
  say so; the dynamic description appends the missing fields by name.
- Anti-pattern: adding a second dynamic registrar alongside `AppManager`. The
  `syncToolManagerAgent` bridge does not compose; see issue #174 before wiring
  one.
- Anti-pattern: an agent that registers a tool per configuration permutation.
  Register the tools, gate the agent.

## Next
`verify.md`. An agent that builds but never appears in discovery is the exact
failure this step exists to catch.
