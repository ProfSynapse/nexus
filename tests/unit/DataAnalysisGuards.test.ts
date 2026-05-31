/**
 * Unit tests for the Data Analysis host-side guardrails — the pure, deterministic
 * logic that bounds inputs/outputs (row cap, size/timeout clamps, path jailing,
 * sandbox filename derivation). No Pyodide / Electron involved.
 */

import {
  countResultRows,
  enforceRowCap,
  enforceOutputBudget,
  clampMaxRows,
  clampOutputBytes,
  clampInputBytes,
  clampTimeout,
  validateInputPath,
  sandboxFileName,
  formatBytesMb,
} from '../../src/agents/apps/dataAnalysis/services/guards';
import { DATA_ANALYSIS_DEFAULTS } from '../../src/agents/apps/dataAnalysis/types';

describe('Data Analysis guards', () => {
  describe('countResultRows', () => {
    it('counts array rows', () => {
      expect(countResultRows([{ a: 1 }, { a: 2 }])).toBe(2);
      expect(countResultRows([])).toBe(0);
    });
    it('returns null for non-arrays (scalars/objects are uncapped)', () => {
      expect(countResultRows(42)).toBeNull();
      expect(countResultRows({ total: 9 })).toBeNull();
      expect(countResultRows(null)).toBeNull();
      expect(countResultRows(undefined)).toBeNull();
    });
  });

  describe('enforceRowCap', () => {
    it('rejects an over-cap array with an aggregate-or-limit message', () => {
      const rows = Array.from({ length: 8432 }, (_, i) => ({ i }));
      const out = enforceRowCap(rows, 1500);
      expect(out.ok).toBe(false);
      expect(out.rowCount).toBe(8432);
      expect(out.error).toContain('8,432 rows');
      expect(out.error).toContain('max 1,500');
      expect(out.error?.toLowerCase()).toContain('aggregate');
    });
    it('passes an at/under-cap array', () => {
      expect(enforceRowCap([{ a: 1 }, { a: 2 }, { a: 3 }], 1500).ok).toBe(true);
      const exactly = Array.from({ length: 1500 }, (_, i) => ({ i }));
      expect(enforceRowCap(exactly, 1500).ok).toBe(true);
    });
    it('never caps scalar/object results', () => {
      expect(enforceRowCap({ avg: 12.5 }, 1500).ok).toBe(true);
      expect(enforceRowCap(7, 1).ok).toBe(true);
    });
  });

  describe('enforceOutputBudget (universal backstop)', () => {
    it('rejects oversized results of ANY shape — closing the non-array row-cap bypass', () => {
      // a nested-dict shape that the row cap (top-level array only) would miss
      const sneaky = { rows: Array.from({ length: 500 }, (_, i) => ({ i, v: 'x'.repeat(20) })) };
      const out = enforceOutputBudget(sneaky, 1024);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/KB/);
    });
    it('passes small results', () => {
      expect(enforceOutputBudget({ avg: 12.5 }, 512 * 1024).ok).toBe(true);
      expect(enforceOutputBudget([{ a: 1 }], 512 * 1024).ok).toBe(true);
    });
    it('rejects non-serializable results instead of throwing', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const out = enforceOutputBudget(circular, 1024);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/not JSON-serializable/);
    });
  });

  describe('clampOutputBytes', () => {
    it('clamps to default and hard cap', () => {
      expect(clampOutputBytes(undefined)).toBe(512 * 1024);
      expect(clampOutputBytes(2048)).toBe(2048);
      expect(clampOutputBytes(Number.MAX_SAFE_INTEGER)).toBe(4 * 1024 * 1024);
    });
  });

  describe('clampMaxRows', () => {
    it('defaults when missing/invalid', () => {
      expect(clampMaxRows(undefined)).toBe(DATA_ANALYSIS_DEFAULTS.maxRows);
      expect(clampMaxRows(0)).toBe(DATA_ANALYSIS_DEFAULTS.maxRows);
      expect(clampMaxRows(-5)).toBe(DATA_ANALYSIS_DEFAULTS.maxRows);
      expect(clampMaxRows(NaN)).toBe(DATA_ANALYSIS_DEFAULTS.maxRows);
    });
    it('honors valid requests but caps at the hard ceiling', () => {
      expect(clampMaxRows(50)).toBe(50);
      expect(clampMaxRows(999999)).toBe(DATA_ANALYSIS_DEFAULTS.maxRowsHardCap);
      expect(clampMaxRows(3.9)).toBe(3); // floored
    });
  });

  describe('clampInputBytes / clampTimeout', () => {
    it('clamp to defaults and hard caps', () => {
      expect(clampInputBytes(undefined)).toBe(DATA_ANALYSIS_DEFAULTS.maxInputBytes);
      expect(clampInputBytes(1_000_000)).toBe(1_000_000);
      expect(clampInputBytes(Number.MAX_SAFE_INTEGER)).toBe(DATA_ANALYSIS_DEFAULTS.maxInputBytesHardCap);

      expect(clampTimeout(undefined)).toBe(DATA_ANALYSIS_DEFAULTS.timeoutMs);
      expect(clampTimeout(2000)).toBe(2000);
      expect(clampTimeout(10 ** 9)).toBe(DATA_ANALYSIS_DEFAULTS.timeoutHardCapMs);
    });
  });

  describe('validateInputPath', () => {
    it('accepts vault-relative paths', () => {
      expect(validateInputPath('data/budget.csv').ok).toBe(true);
      expect(validateInputPath('Q3.xlsx').ok).toBe(true);
    });
    it('rejects traversal and absolute paths', () => {
      expect(validateInputPath('../../etc/passwd').ok).toBe(false);
      expect(validateInputPath('/etc/passwd').ok).toBe(false);
      expect(validateInputPath('a/../../b').ok).toBe(false);
    });
  });

  describe('sandboxFileName', () => {
    it('preserves the source extension and sanitizes the var name', () => {
      expect(sandboxFileName('budget', 'data/budget.csv')).toBe('budget.csv');
      expect(sandboxFileName('sales 2024', 'reports/q3.xlsx')).toBe('sales_2024.xlsx');
      expect(sandboxFileName('x', 'noext')).toBe('x');
    });
    it('falls back to "input" for empty/symbol-only names', () => {
      expect(sandboxFileName('***', 'a.csv')).toBe('input.csv');
    });
  });

  describe('formatBytesMb', () => {
    it('formats MB to one decimal', () => {
      expect(formatBytesMb(10 * 1024 * 1024)).toBe('10.0');
      expect(formatBytesMb(1024 * 1024 + 512 * 1024)).toBe('1.5');
    });
  });
});
