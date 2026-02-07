# Obsidian Secrets API Research

**Date**: 2026-02-07
**Researcher**: PACT Preparer
**Obsidian API Package Version Analyzed**: `obsidian@1.11.0` (npm)
**Feature Introduced**: Obsidian v1.11.0 (Early Access, Dec 10, 2025), API types since v1.11.4

---

## Executive Summary

Obsidian introduced a Keychain settings section and a new SecretStorage API for plugins starting in v1.11.0 (December 2025), with the Plugin API types finalized in v1.11.4 (January 7, 2026) and going public on January 12, 2026. The API provides a simple synchronous interface (setSecret, getSecret, listSecrets) for storing shared secrets that can be used across multiple plugins. Secrets are encrypted at rest using the OS-provided encryption (Electron safeStorage on desktop, which delegates to macOS Keychain, Windows DPAPI, or Linux secret stores). The API is also available on mobile (v1.11.4+), with keychain UI improvements shipped in v1.11.5 mobile.

The claudesidian-mcp plugin currently stores all API keys in plain text within data.json via Obsidian's standard plugin.loadData()/plugin.saveData() mechanism. The data.json file is synced across devices (Obsidian Sync, iCloud, etc.), which means API keys travel with it. Adopting the SecretStorage API would move sensitive keys out of data.json and into an encrypted, vault-scoped keychain.

**Recommendation**: Adopt with a hybrid approach -- use SecretStorage when available (Obsidian >= 1.11.4), fall back to the existing data.json storage for older Obsidian versions. This is achievable with relatively low effort and provides immediate security benefits for users on current Obsidian versions. However, be aware that (1) the API is only ~4 weeks old in public release, (2) at least one forum report suggests desktop secrets may be stored in LevelDB/localStorage rather than truly in the OS keychain, and (3) there are no known community plugins using it yet as reference implementations.

---

## Technology Overview

### What Is the Secrets API?

The Obsidian Secrets API is an opt-in mechanism for plugins to store sensitive values (API keys, tokens, passwords) in a shared, vault-scoped keychain rather than in each plugin's data.json. It consists of two parts:

1. **SecretStorage** -- A class available at `app.secretStorage` that provides programmatic access to read/write secrets
2. **SecretComponent** -- A UI component (extending BaseComponent) that renders a secret input field in plugin settings, tied to the keychain

The design allows cross-plugin secret sharing: if Plugin A stores an OpenAI key under the ID openai-api-key, Plugin B can read the same key without the user needing to enter it twice.

### Timeline

| Date | Version | Event |
|------|---------|-------|
| Dec 10, 2025 | 1.11.0 Desktop (Early Access) | Keychain settings section introduced; Plugin API coming soon |
| Dec 12, 2025 | 1.11.1 Desktop (Early Access) | SecretComponent class first appears in API types |
| Jan 7, 2026 | 1.11.4 Desktop (Early Access) | Full SecretStorage class + SecretComponent.setValue/onChange added |
| Jan 12, 2026 | 1.11.4 Desktop (Public) | Public release of all secrets functionality |
| Jan 12, 2026 | 1.11.4 Mobile (Public) | Mobile keychain support included |
| Jan 15, 2026 | 1.11.5 Mobile (Early Access) | Keychain layout improvements, auto-capitalization fix |
| Jan 20, 2026 | 1.11.5 Desktop (Public) | Secret Storage is now encrypted while on disk confirmed |
| Jan 20, 2026 | 1.11.5 Mobile (Public) | Mobile keychain polish |

---

## API Reference

### SecretStorage Class

Available at `app.secretStorage` (since v1.11.4).

```typescript
export class SecretStorage {
    /**
     * Sets a secret in the storage.
     * @param id - Lowercase alphanumeric ID with optional dashes
     * @param secret - The secret value to store
     * @throws Error if ID is invalid
     * @since 1.11.4
     */
    setSecret(id: string, secret: string): void;

    /**
     * Gets a secret from storage.
     * @param id - The secret ID
     * @returns The secret value or null if not found
     * @since 1.11.4
     */
    getSecret(id: string): string | null;

    /**
     * Lists all secrets in storage.
     * @returns Array of secret IDs
     * @since 1.11.4
     */
    listSecrets(): string[];
}
```

Key observations:
- All methods are synchronous (no Promises)
- setSecret validates the ID format (lowercase alphanumeric with optional dashes)
- getSecret returns null when not found, not undefined
- There is no deleteSecret method in the current API -- this is a notable gap
- The loadSecrets method is private -- loading is handled internally

### SecretComponent Class

A UI component for rendering secret input fields in plugin settings.

```typescript
export class SecretComponent extends BaseComponent {
    constructor(app: App, containerEl: HTMLElement);

    /** @since 1.11.4 */
    setValue(value: string): this;

    /** @since 1.11.4 */
    onChange(cb: (value: string) => unknown): this;
}
```

Key observations:
- Extends BaseComponent (has disabled, then(), setDisabled())
- Constructor requires both app and containerEl
- Supports chaining via setValue().onChange() pattern
- Class introduced in v1.11.1, but setValue/onChange only added in v1.11.4

### App.secretStorage Property

```typescript
// On the App class:
/** @since 1.11.4 */
secretStorage: SecretStorage;
```

Access pattern: `this.app.secretStorage.getSecret('my-api-key')`

---

## Encryption and Storage Mechanism

### Desktop (Electron)

Based on the changelog statement "Secret Storage is now encrypted while on disk, relying on encryption provided by your operating system" and Obsidian's use of Electron, the secrets API almost certainly uses Electron's safeStorage API under the hood.

Electron safeStorage delegates to:

| Platform | Backend | Protection Level |
|----------|---------|------------------|
| macOS | Keychain Access | Protected from other apps and other users |
| Windows | DPAPI (Data Protection API) | Protected from other users, NOT from other apps in same user session |
| Linux | kwallet / kwallet5 / kwallet6 / gnome-libsecret | Varies by window manager; if no secret store available, falls back to hardcoded plaintext |

**Important caveat**: A forum thread titled "SecretStorage API stores records in plain text within LevelDB local storage" suggests that secrets may be stored in Electron's LevelDB/localStorage rather than in a separate encrypted file. This would mean the encryption happens at the Electron level (via safeStorage.encryptString()) but the encrypted blob is stored in the same LevelDB that stores other app data. The encryption key itself is managed by the OS keychain.

**Linux fallback risk**: If no secret store backend is available on Linux, Electron's safeStorage uses a hardcoded plaintext password. This can be detected via safeStorage.getSelectedStorageBackend() returning 'basic_text', but Obsidian's API does not expose this check to plugins.

### Mobile

The mobile changelog includes keychain UI improvements (v1.11.5), confirming mobile support. The encryption mechanism on mobile is not documented, but iOS provides Keychain Services and Android provides the Keystore system. Since Obsidian mobile is not Electron-based, the implementation is likely platform-native.

### Sync Behavior

Critical question: Are secrets synced across devices?

- data.json IS synced by Obsidian Sync and third-party sync tools (iCloud, Dropbox, etc.) -- API keys currently travel in plain text
- The SecretStorage location is almost certainly NOT inside the vault folder, meaning it would NOT be synced by file-based sync tools
- Whether Obsidian Sync has special handling for secrets is unknown -- the original forum feature request specifically asked for secrets that "can be sync'd"
- Users may need to re-enter API keys on each device when using SecretStorage

This is a trade-off: better security (keys don't travel) vs. worse UX (must enter keys per-device).

---

## Current Plugin API Key Storage Analysis

### Storage Mechanism

The claudesidian-mcp plugin stores all settings, including API keys, in Obsidian's standard data.json:

```typescript
// src/settings.ts
async loadSettings() {
    const loadedData = await this.plugin.loadData();  // Reads data.json
    this.applyLoadedData(loadedData);
}

async saveSettings() {
    await this.plugin.saveData(this.settings);  // Writes data.json
}
```

### Where API Keys Live

API keys are stored in MCPSettings.llmProviders.providers[providerId].apiKey:

```typescript
// src/types/llm/ProviderTypes.ts
export interface LLMProviderConfig {
    apiKey: string;          // Plain text in data.json
    userDescription?: string;
    enabled: boolean;
    models?: { [modelId: string]: ModelConfig };
}
```

### Providers with API Keys (10 total)

| Provider | Key Format | Needs API Key |
|----------|-----------|---------------|
| OpenAI | sk-proj-... | Yes |
| Anthropic | sk-ant-... | Yes |
| Google AI | AIza... | Yes |
| Mistral | msak_... | Yes |
| Groq | gsk_... | Yes |
| OpenRouter | sk-or-... | Yes |
| Requesty | req_... | Yes |
| Perplexity | pplx-... | Yes |
| Ollama | Server URL | No (URL, not secret) |
| LM Studio | Server URL | No (URL, not secret) |

WebLLM does not use an API key.

### Files That Access API Keys

The API key flows through these layers:

1. **Storage**: src/settings.ts -- loadData()/saveData() to data.json
2. **Settings UI**: src/settings/tabs/ProvidersTab.ts -- provider cards
3. **Provider Modal**: src/components/llm-provider/providers/GenericProviderModal.ts -- API key input (type="password")
4. **Provider Manager**: src/services/llm/providers/ProviderManager.ts -- key availability checks
5. **Adapters**: src/services/llm/adapters/BaseAdapter.ts + all provider adapters -- uses apiKey for API calls
6. **Validation**: src/services/llm/validation/ValidationService.ts -- validates keys against provider APIs
7. **MCP Connector**: src/connector.ts -- accesses settings via plugin reference

### Current Security Measures

- API key input fields use type="password" in the UI (masked display)
- No encryption at rest -- plain text in data.json
- data.json lives in the vault under .obsidian/plugins/nexus/data.json
- This file is synced by Obsidian Sync and file-based sync services

---

## Migration Path

### Approach: Hybrid (Recommended)

Use SecretStorage when available, fall back to data.json for older Obsidian versions.

### High-Level Changes Required

1. **Version Detection**: Check if app.secretStorage exists (feature detection, not version checking)

```typescript
const hasSecretStorage = 'secretStorage' in this.app && this.app.secretStorage;
```

2. **Secret ID Convention**: Define consistent IDs for each provider key

```
openai-api-key
anthropic-api-key
google-api-key
mistral-api-key
groq-api-key
openrouter-api-key
requesty-api-key
perplexity-api-key
```

3. **Settings Service Changes** (src/settings.ts):
   - On load: Try app.secretStorage.getSecret(id) first; if null, fall back to data.json
   - On save: Write to app.secretStorage.setSecret(id, key) AND keep in data.json (for backward compat + connector access)
   - Migration: On first run with SecretStorage available, copy existing keys from data.json to SecretStorage

4. **Provider Modal Changes** (GenericProviderModal.ts):
   - Could replace the manual type="password" input with SecretComponent
   - OR keep existing UI and just change the storage backend

5. **MCP Connector Consideration**:
   - The MCP connector runs as a separate Node.js process outside Obsidian
   - It accesses settings via the plugin reference (plugin.settings)
   - It does NOT have access to app.secretStorage directly
   - This means the connector may still need keys in data.json OR a different mechanism
   - This is the biggest integration challenge

6. **obsidian npm package update**: Bump from 1.8.7 to 1.11.0

7. **manifest.json update**: Consider updating minAppVersion from 0.15.0
   - If using hybrid approach: minAppVersion can stay at current value
   - The plugin gracefully degrades when SecretStorage is not available

### Effort Estimate

| Component | Effort | Risk |
|-----------|--------|------|
| Settings service (load/save/migrate) | Medium | Low |
| Provider modal UI | Low | Low |
| Version detection + fallback | Low | Low |
| MCP connector compatibility | High | High |
| npm package bump + testing | Low | Medium |
| Cross-device UX (docs/messaging) | Low | Low |

---

## Community Adoption

### Current State (as of Feb 7, 2026)

- No known community plugins have adopted the SecretStorage API yet
- The API has been publicly available for ~4 weeks (since Jan 12, 2026)
- The Obsidian sample plugin template has not been updated with SecretStorage examples
- The official developer documentation at docs.obsidian.md does not yet have a guide for SecretStorage
- The only type documentation is in obsidian.d.ts JSDoc comments

### Forum Activity

- Cross-platform secure storage for secrets -- Original feature request thread
- Hide secrets in plugin settings -- Related request for masked inputs
- SecretStorage API stores records in plain text within LevelDB -- Security concern about storage mechanism
- Mind Your Obsidian Plugin Secrets -- Nov 2025 blog post about plugin secret exposure

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| API changes in upcoming Obsidian versions | Medium | Medium | Feature detection, not version checks; hybrid approach absorbs changes |
| Secrets not synced across devices | High | Medium | Document clearly; users must enter keys per-device; keep data.json fallback |
| MCP connector cannot access SecretStorage | High | High | Keep keys in data.json for connector; dual-write strategy |
| Linux plaintext fallback | Low | Medium | Cannot detect from plugin; document the risk for Linux users |
| No deleteSecret method | Medium | Low | Set secret to empty string as workaround |
| API is too new / undiscovered bugs | Medium | Medium | Hybrid approach means fallback always works |
| minAppVersion bump breaks older users | Low | High | Hybrid approach avoids this; no version bump needed |
| SecretStorage stores in LevelDB plain text | Low | High | Verify with testing; 1.11.5 changelog says encrypted while on disk |

---

## Security Considerations

### Improvement Over Current Approach

| Aspect | Current (data.json) | With SecretStorage |
|--------|---------------------|-------------------|
| At rest (desktop) | Plain text JSON | Encrypted via OS keychain |
| At rest (mobile) | Plain text JSON | Platform keychain (likely) |
| Synced across devices | Yes (plain text in transit) | Not synced (keys stay local) |
| Accessible by other plugins | Yes (can read data.json) | Yes (shared keychain by design) |
| Accessible by filesystem | Yes (plain text file) | Encrypted on disk |
| Exposed in backups | Yes | Depends on backup method |

### Notable Limitations

1. Cross-plugin access is by design -- any plugin can read any secret by ID
2. No access control -- no mechanism to restrict which plugins read which secrets
3. No audit logging -- no way to know which plugins accessed which secrets
4. Shared namespace -- secret IDs are global; plugins must use unique IDs to avoid collisions

---

## Compatibility Matrix

| Component | Current | Required for Secrets API | Notes |
|-----------|---------|-------------------------|-------|
| obsidian npm package | 1.8.7 | 1.11.0 | Must update for type definitions |
| minAppVersion (manifest) | 0.15.0 | No change needed | Hybrid approach degrades gracefully |
| Obsidian Desktop | Any | >= 1.11.4 | For SecretStorage; older versions use data.json |
| Obsidian Mobile | Any | >= 1.11.4 | For Keychain; older versions use data.json |
| Electron | Current | >= 39.2.6 | Obsidian 1.11 upgraded Electron |

---

## Recommendation

### Adopt with Hybrid Approach (Recommended)

**When**: After the API stabilizes with 1-2 more Obsidian releases (~1-2 months, targeting March 2026)

**Why wait slightly**:
- The API is only ~4 weeks old in public release
- No community plugins are using it yet (no battle-testing)
- There is an open forum thread questioning whether encryption actually works as advertised
- No official developer documentation or guide exists yet
- The deleteSecret gap needs clarification

**Why not wait too long**:
- The security benefit is real and meaningful
- Users on current Obsidian versions would benefit immediately
- The hybrid approach has zero downside for users on older versions
- Being an early adopter of a security-improving API is a positive signal

**Implementation priority**:
1. Update obsidian npm package to 1.11.0
2. Add feature detection for app.secretStorage
3. Implement dual-write: SecretStorage + data.json
4. On load, prefer SecretStorage; fall back to data.json
5. One-time migration of existing keys to SecretStorage
6. Keep data.json keys for MCP connector compatibility
7. Document per-device key entry requirement for users

**What to watch**:
- Obsidian developer docs for an official SecretStorage guide
- Community plugin adoption for reference implementations
- Resolution of the LevelDB/plain text storage concern
- Whether Obsidian Sync adds secret syncing support
- Whether a deleteSecret method is added

### Alternative: Wait for Full Maturity

If risk tolerance is low, wait until:
- At least 5+ community plugins adopt the API
- Official developer documentation is published
- The LevelDB storage concern is resolved
- A deleteSecret method is added

Estimated timeline for full maturity: Q2-Q3 2026

---

## References

### Official Sources

- Obsidian 1.11.0 Desktop Changelog (Early Access, Dec 10, 2025): https://obsidian.md/changelog/2025-12-10-desktop-v1.11.0/
- Obsidian 1.11.4 Desktop Changelog (Public, Jan 12, 2026): https://obsidian.md/changelog/2026-01-12-desktop-v1.11.4/
- Obsidian 1.11.5 Desktop Changelog (Public, Jan 20, 2026): https://obsidian.md/changelog/2026-01-20-desktop-v1.11.5/
- Obsidian 1.11.5 Mobile Changelog (Public, Jan 20, 2026): https://obsidian.md/changelog/2026-01-20-mobile-v1.11.5/
- Obsidian API Type Definitions (GitHub): https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- Obsidian npm package: https://www.npmjs.com/package/obsidian
- Obsidian Plugin Guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Obsidian Developer Documentation: https://docs.obsidian.md/

### Community Discussions

- Cross-platform secure storage for secrets (Forum): https://forum.obsidian.md/t/cross-platform-secure-storage-for-secrets-and-tokens-that-can-be-syncd/100716
- Hide secrets in plugin settings (Forum): https://forum.obsidian.md/t/hide-secrets-in-plugin-settings/104420
- SecretStorage API stores records in plain text within LevelDB (Forum): https://forum.obsidian.md/t/secretstorage-api-stores-records-in-plain-text-within-leveldb-local-storage/109890
- Store secrets like API key outside of data.json (Forum): https://forum.obsidian.md/t/store-secrets-like-api-key-outside-of-data-json/56035

### Security References

- Mind Your Obsidian Plugin Secrets (Medium, Nov 2025): https://blog-ssh3ll.medium.com/mind-your-obsidian-plugin-secrets-fc141f34b936
- Electron safeStorage API Documentation: https://www.electronjs.org/docs/latest/api/safe-storage
- Obsidian Security and Privacy (Help): https://help.obsidian.md/Obsidian+Sync/Security+and+privacy

### Codebase References (Claudesidian-MCP)

- src/settings.ts -- Main settings load/save
- src/types/llm/ProviderTypes.ts -- LLMProviderConfig.apiKey definition
- src/settings/tabs/ProvidersTab.ts -- Provider settings UI
- src/components/llm-provider/providers/GenericProviderModal.ts -- API key input
- src/services/llm/adapters/BaseAdapter.ts -- API key usage in LLM adapters
- src/services/llm/providers/ProviderManager.ts -- Provider availability checks
- src/services/llm/validation/ValidationService.ts -- API key validation
- src/connector.ts -- MCP connector accessing settings
- manifest.json -- Currently minAppVersion 0.15.0, obsidian npm at v1.8.7
