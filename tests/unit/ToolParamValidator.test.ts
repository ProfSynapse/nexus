/**
 * ToolParamValidator Unit Tests
 *
 * Verifies the defensive runtime guards reject clearly-malformed LLM-supplied
 * tool arguments (the historical `notePath: undefined` / PR #236 class of bug)
 * while passing valid input through unchanged.
 */

import { ToolParamValidator } from '../../src/agents/validation/ToolParamValidator';

describe('ToolParamValidator', () => {
  describe('requireString', () => {
    it('returns the value for a non-empty string', () => {
      expect(ToolParamValidator.requireString('hello', 'field')).toBe('hello');
    });

    it('rejects undefined', () => {
      expect(() => ToolParamValidator.requireString(undefined, 'field')).toThrow('field');
    });

    it('rejects a non-string', () => {
      expect(() => ToolParamValidator.requireString(123, 'field')).toThrow('field is required and must be a string');
    });

    it('rejects an empty string', () => {
      expect(() => ToolParamValidator.requireString('', 'field')).toThrow('field is required and cannot be empty');
    });

    it('rejects a whitespace-only string', () => {
      expect(() => ToolParamValidator.requireString('   ', 'field')).toThrow('field is required and cannot be empty');
    });
  });

  describe('optionalString', () => {
    it('returns undefined for undefined', () => {
      expect(ToolParamValidator.optionalString(undefined, 'field')).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(ToolParamValidator.optionalString(null, 'field')).toBeUndefined();
    });

    it('returns the value for a non-empty string', () => {
      expect(ToolParamValidator.optionalString('value', 'field')).toBe('value');
    });

    it('rejects a present non-string', () => {
      expect(() => ToolParamValidator.optionalString(5, 'field')).toThrow('field');
    });

    it('rejects a present empty string', () => {
      expect(() => ToolParamValidator.optionalString('  ', 'field')).toThrow('field');
    });
  });

  describe('requireArray', () => {
    it('returns the array for an array', () => {
      expect(ToolParamValidator.requireArray<number>([1, 2], 'field')).toEqual([1, 2]);
    });

    it('returns an empty array unchanged', () => {
      expect(ToolParamValidator.requireArray([], 'field')).toEqual([]);
    });

    it('rejects a non-array', () => {
      expect(() => ToolParamValidator.requireArray('nope', 'field')).toThrow('field is required and must be an array');
    });

    it('rejects undefined', () => {
      expect(() => ToolParamValidator.requireArray(undefined, 'field')).toThrow('field');
    });
  });

  describe('requireObject', () => {
    it('returns the object for a plain object', () => {
      const obj = { a: 1 };
      expect(ToolParamValidator.requireObject(obj, 'field')).toBe(obj);
    });

    it('rejects null', () => {
      expect(() => ToolParamValidator.requireObject(null, 'field')).toThrow('field is required and must be an object');
    });

    it('rejects an array', () => {
      expect(() => ToolParamValidator.requireObject([], 'field')).toThrow('field is required and must be an object');
    });

    it('rejects a string', () => {
      expect(() => ToolParamValidator.requireObject('x', 'field')).toThrow('field');
    });
  });

  describe('requireNumber', () => {
    it('returns the value for a finite number', () => {
      expect(ToolParamValidator.requireNumber(42, 'field')).toBe(42);
    });

    it('returns zero', () => {
      expect(ToolParamValidator.requireNumber(0, 'field')).toBe(0);
    });

    it('rejects NaN', () => {
      expect(() => ToolParamValidator.requireNumber(NaN, 'field')).toThrow('field is required and must be a number');
    });

    it('rejects Infinity', () => {
      expect(() => ToolParamValidator.requireNumber(Infinity, 'field')).toThrow('field');
    });

    it('rejects a numeric string', () => {
      expect(() => ToolParamValidator.requireNumber('5', 'field')).toThrow('field');
    });
  });

  describe('requireInteger', () => {
    it('returns the value for an integer', () => {
      expect(ToolParamValidator.requireInteger(7, 'field')).toBe(7);
    });

    it('rejects a non-integer number', () => {
      expect(() => ToolParamValidator.requireInteger(1.5, 'field')).toThrow('field is required and must be an integer');
    });

    it('rejects a non-number', () => {
      expect(() => ToolParamValidator.requireInteger('7', 'field')).toThrow('field');
    });
  });
});
