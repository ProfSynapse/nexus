/**
 * Location: src/agents/validation/ToolParamValidator.ts
 *
 * Defensive runtime guards for LLM-supplied tool arguments at the tool
 * execution boundary. Tool JSON schemas (`getParameterSchema`) are advisory
 * documentation only — there is NO ajv/JSON-schema validation behind
 * `useTools`, so a malformed LLM payload otherwise flows straight into a
 * service (the historical `notePath: undefined` / PR #236 class of bug).
 *
 * Each guard throws a descriptive `Error` on failure. The intended integration
 * pattern in a tool's `execute()` is a top-level try/catch that returns
 * `prepareResult(false, undefined, error.message)` on throw, so a clearly
 * malformed argument becomes a clean error result instead of a crash or a
 * silently-persisted `undefined`.
 */
export class ToolParamValidator {
  /**
   * Require a non-empty, non-whitespace string. Rejects non-strings, empty
   * strings, and whitespace-only strings.
   */
  static requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} is required and must be a string`);
    }
    if (value.trim() === '') {
      throw new Error(`${fieldName} is required and cannot be empty`);
    }
    return value;
  }

  /**
   * Accept an absent value (undefined/null) or a non-empty string. A present
   * value that is not a string, or is empty/whitespace-only, is rejected so an
   * explicitly-supplied bad value is not silently treated as absent.
   */
  static optionalString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return ToolParamValidator.requireString(value, fieldName);
  }

  /**
   * Require an array. Does not constrain element types — the caller narrows
   * elements as needed.
   */
  static requireArray<T>(value: unknown, fieldName: string): T[] {
    if (!Array.isArray(value)) {
      throw new Error(`${fieldName} is required and must be an array`);
    }
    return value as T[];
  }

  /**
   * Require a plain object (non-null, non-array).
   */
  static requireObject(value: unknown, fieldName: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${fieldName} is required and must be an object`);
    }
    return value as Record<string, unknown>;
  }

  /**
   * Require a finite number. Rejects non-numbers, NaN, and Infinity.
   */
  static requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${fieldName} is required and must be a number`);
    }
    return value;
  }

  /**
   * Require an integer. Rejects non-integers in addition to the rules of
   * `requireNumber`.
   */
  static requireInteger(value: unknown, fieldName: string): number {
    const num = ToolParamValidator.requireNumber(value, fieldName);
    if (!Number.isInteger(num)) {
      throw new Error(`${fieldName} is required and must be an integer`);
    }
    return num;
  }
}
