# Obsidian Plugin Development Guidelines

This plugin must follow official [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).

## Plugin Lifecycle

```typescript
export default class MyPlugin extends Plugin {
    async onload() {
        // Initialize UI, register commands, set up events
        // Use registration methods for auto-cleanup
    }
    async onunload() {
        // Clean up resources (most handled automatically)
    }
}
```

**Key lifecycle rules:**
- All registration methods (`registerEvent`, `addCommand`, `registerView`, `registerInterval`) auto-cleanup on unload
- Never store view references in the plugin instance (causes memory leaks)
- Use `this.app.workspace.onLayoutReady()` to defer startup operations

## Styling — ALL STYLES IN styles.css

**CRITICAL**: All styles must be defined in `styles.css`, never inline in TypeScript/JavaScript.

```typescript
// ❌ NEVER do this
element.style.color = 'white';
element.style.backgroundColor = 'red';

// ✅ ALWAYS do this
element.addClass('my-plugin-element');
```

```css
/* In styles.css - use CSS variables for theme compatibility */
.my-plugin-element {
    color: var(--text-normal);
    background-color: var(--background-primary);
    display: flex;
}
```

**Required CSS Variables** (never hardcode colors):
| Variable | Purpose |
|----------|---------|
| `--text-normal`, `--text-muted`, `--text-faint` | Text colors |
| `--text-accent` | Interactive/link text |
| `--background-primary`, `--background-secondary` | Background colors |
| `--background-modifier-border` | Borders |
| `--background-modifier-error` | Error states |
| `--interactive-accent`, `--interactive-accent-hover` | Buttons/interactive |
| `--radius-s`, `--radius-m`, `--radius-l` | Border radius |

## Security Requirements

**innerHTML is FORBIDDEN** with dynamic content:
```typescript
// ❌ NEVER - XSS vulnerability
element.innerHTML = userProvidedContent;
element.innerHTML = `<div>${dynamicData}</div>`;

// ✅ Safe patterns
element.textContent = userProvidedContent;  // For text
element.createEl('div', { text: dynamicData });  // Obsidian API

// ✅ Safe innerHTML patterns (only these are acceptable)
element.innerHTML = '';  // Clearing
const escaped = div.innerHTML;  // Reading already-escaped content
```

**Safe DOM creation with Obsidian API:**
```typescript
const container = contentEl.createDiv({ cls: 'my-container' });
const heading = container.createEl('h2', { text: 'Title' });
const button = container.createEl('button', { text: 'Click me', cls: 'my-button' });

// For icons, use setIcon
import { setIcon } from 'obsidian';
setIcon(button, 'chevron-right');
```

## Event Registration

**Always use `registerDomEvent` for DOM events:**
```typescript
// ❌ NEVER - causes memory leaks on unload
element.addEventListener('click', handler);

// ✅ ALWAYS - auto-cleanup on unload
this.registerDomEvent(element, 'click', handler);
this.registerDomEvent(document, 'keydown', handler);
this.registerDomEvent(window, 'resize', handler);

// ✅ For Obsidian workspace events
this.registerEvent(this.app.vault.on('modify', handler));
this.registerEvent(this.app.workspace.on('active-leaf-change', handler));
```

## File Operations

```typescript
// ❌ NEVER use vault.adapter directly (mobile incompatible)
await this.app.vault.adapter.read(path);

// ✅ Use Vault API
await this.app.vault.read(file);
await this.app.vault.cachedRead(file);  // Faster, uses cache

// ✅ For modifying files, use Vault.process() (atomic, prevents conflicts)
await this.app.vault.process(file, (content) => content.replace('old', 'new'));

// ✅ Use Editor API for active file (preserves cursor)
const editor = this.app.workspace.activeEditor?.editor;
if (editor) editor.replaceRange('new text', from, to);
```

**Exception**: Hidden files (like `.nexus/`, the legacy data folder) aren't indexed by Obsidian, so `vault.adapter` is acceptable for those paths. The primary data location is now `.obsidian/plugins/<plugin-folder>/data/`, which also requires `vault.adapter` since it lives outside the indexed vault tree. Use `isHiddenPath()` helper.

## API Best Practices

| Task | Do This | Not This |
|------|---------|----------|
| HTTP requests | `requestUrl()` | `fetch()` |
| Path handling | `normalizePath(userPath)` | Direct string concat |
| OS detection | `Platform.isMobile`, `Platform.isDesktop` | User agent sniffing |
| File lookup | `vault.getFileByPath(path)` | Iterating vault.getFiles() |
| View access | `workspace.getActiveViewOfType(MarkdownView)` | `workspace.activeLeaf.view` |

## Commands

```typescript
this.addCommand({
    id: 'my-action',  // Don't duplicate plugin ID
    name: 'My action',  // Sentence case, no "command" word
    // NO default hotkey - users set their own
    checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            if (!checking) { /* Execute */ }
            return true;
        }
        return false;
    }
});
```

## Mobile Compatibility

```typescript
import { Platform } from 'obsidian';
if (Platform.isMobile) { /* Mobile-specific code */ }

// ❌ NOT available on mobile
import { fs, path, crypto } from 'node:*';  // Node.js modules
require('electron');  // Electron APIs

// ✅ Mobile alternatives
// Use SubtleCrypto instead of crypto
// Set isDesktopOnly: true in manifest if Node.js required
```

## Accessibility Requirements

```typescript
// ✅ Interactive elements need aria-labels
const iconButton = container.createEl('button', { cls: 'icon-button' });
iconButton.setAttribute('aria-label', 'Open settings');
setIcon(iconButton, 'settings');

// ✅ Keyboard navigation (Tab, Enter, Space)
// ✅ Focus indicators with :focus-visible
// ✅ Touch targets minimum 44×44px on mobile
```

## Code Quality Rules

| Rule | Requirement |
|------|-------------|
| Type safety | No `as any` casts, use `instanceof` checks |
| Variables | Use `const`/`let`, never `var` |
| Console logging | No `console.log` in production, only `console.error` for actual errors |
| UI text | Sentence case everywhere |
| Cleanup | Remove all template/sample code before submission |

## Manifest Requirements

```json
{
    "id": "my-plugin-id",      // Lowercase, no "obsidian", doesn't end with "plugin"
    "name": "My Plugin Name",  // No "Obsidian" or "Plugin" suffix
    "version": "1.0.0",
    "minAppVersion": "1.0.0",
    "description": "Does something useful.",  // <250 chars, ends with punctuation
    "author": "Author Name",
    "isDesktopOnly": false     // true only if Node.js APIs required
}
```

## Performance Guidelines

```typescript
// ❌ Vault 'create' fires for ALL files on startup
this.registerEvent(this.app.vault.on('create', handler));

// ✅ Wait for layout ready
this.app.workspace.onLayoutReady(() => {
    this.registerEvent(this.app.vault.on('create', handler));
});
```

## References

- [Official Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Obsidian API Types](https://github.com/obsidianmd/obsidian-api)
- [CSS Variables Reference](https://docs.obsidian.md/Reference/CSS+variables)
- [Sample Plugin Template](https://github.com/obsidianmd/obsidian-sample-plugin)
