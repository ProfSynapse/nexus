/**
 * Every service name looked up by string must be one something registers.
 *
 * The defect this buys: five call sites asked for
 * `getServiceIfReady('embeddingService')` after the registration was dropped.
 * `getServiceIfReady` answers null for an unknown name rather than throwing,
 * so semantic conversation search, semantic `[[` suggestions and semantic note
 * linking all switched off silently, and every test mocked around the gap.
 *
 * This test reads the source under `src/`, collects every string literal passed
 * to `getServiceIfReady(...)` or `getService(...)`, and requires each name to be
 * registered: a `CORE_SERVICE_DEFINITIONS` entry, an
 * `ADDITIONAL_SERVICE_FACTORIES` entry, or a `container.register('<name>', ...)`
 * call in `src/core/index.ts`. Nothing here is mocked; the registry lists are
 * the real exported arrays.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CORE_SERVICE_DEFINITIONS,
  ADDITIONAL_SERVICE_FACTORIES
} from '../../src/core/services/ServiceDefinitions';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * Lookups known to target a name nothing registers, kept so this contract can
 * land without widening its change. Each entry must stay unregistered (the
 * last test fails once it is fixed, so the list only shrinks) and must never
 * gain a member. It is empty now; keep it that way.
 */
const KNOWN_UNREGISTERED = new Set<string>();

/**
 * `getServiceIfReady('x')`, `getServiceIfReady<T>('x')`, `?.getService?.<T>("x")`
 * and multi-line variants. The type-argument group refuses parentheses so it
 * cannot run on into a later call.
 */
const LOOKUP = /\b(?:getServiceIfReady|getService)\s*(?:\?\.)?\s*(?:<[^()]*?>)?\s*(?:\?\.)?\s*\(\s*['"`]([A-Za-z0-9_]+)['"`]/g;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function collectLookups(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const file of listSourceFiles(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(LOOKUP)) {
      const name = match[1];
      const line = source.slice(0, match.index).split('\n').length;
      const where = `${path.relative(ROOT, file)}:${line}`;
      byName.set(name, [...(byName.get(name) ?? []), where]);
    }
  }
  return byName;
}

function registeredNames(): Set<string> {
  const names = new Set<string>();
  for (const def of CORE_SERVICE_DEFINITIONS) names.add(def.name);
  for (const factory of ADDITIONAL_SERVICE_FACTORIES) names.add(factory.name);

  const coreIndex = fs.readFileSync(path.join(SRC, 'core', 'index.ts'), 'utf8');
  for (const match of coreIndex.matchAll(/\.register\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
    names.add(match[1]);
  }
  return names;
}

describe('service name registry contract', () => {
  const lookups = collectLookups();
  const registered = registeredNames();

  it('scans real lookups (guards against a regex that matches nothing)', () => {
    expect(lookups.get('hybridStorageAdapter')?.length ?? 0).toBeGreaterThan(0);
    expect(lookups.get('workspaceService')?.length ?? 0).toBeGreaterThan(0);
    expect(registered.has('hybridStorageAdapter')).toBe(true);
    expect(registered.has('vaultOperations')).toBe(true);
  });

  it('matches the call shapes used in the codebase', () => {
    const sample = [
      "a.getServiceIfReady('one')",
      'b?.getServiceIfReady?.<Foo>("two")',
      'c.getService<Map<string, number>>(\n  `three`\n)',
      "d.getServiceIfReady<EmbeddingService>('four')"
    ].join('\n');
    const found = [...sample.matchAll(LOOKUP)].map(match => match[1]);
    expect(found).toEqual(['one', 'two', 'three', 'four']);
  });

  it('every looked-up service name is registered', () => {
    const unregistered = [...lookups.entries()]
      .filter(([name]) => !registered.has(name) && !KNOWN_UNREGISTERED.has(name))
      .map(([name, sites]) => `${name} (${sites.join(', ')})`);

    expect(unregistered).toEqual([]);
  });

  it('nothing looks up embeddingService; use resolveEmbeddingService(plugin)', () => {
    expect(lookups.get('embeddingService')).toBeUndefined();
  });

  it('known exceptions are still unregistered and still looked up', () => {
    for (const name of KNOWN_UNREGISTERED) {
      expect(registered.has(name)).toBe(false);
      expect(lookups.has(name)).toBe(true);
    }
  });
});
