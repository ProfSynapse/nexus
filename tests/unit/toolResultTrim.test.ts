import {
  MAX_STORED_TOOL_RESULT_BYTES,
  TRIMMED_KEEP_BYTES,
  trimLongString,
  trimToolResultForStorage
} from '../../src/utils/toolResultTrim';

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;

describe('trimToolResultForStorage', () => {
  it('returns results within the limit as the same reference', () => {
    const result = { success: true, content: 'x'.repeat(MAX_STORED_TOOL_RESULT_BYTES - 100) };
    expect(trimToolResultForStorage(result)).toBe(result);
    expect(trimToolResultForStorage(undefined)).toBeUndefined();
    expect(trimToolResultForStorage(null)).toBeNull();
  });

  it('keeps the head and tail of a large string result and says what was dropped', () => {
    const result = `START${'m'.repeat(1024 * 1024)}END`;
    const trimmed = trimToolResultForStorage(result) as string;
    expect(trimmed.startsWith('START')).toBe(true);
    expect(trimmed.endsWith('END')).toBe(true);
    expect(trimmed).toMatch(/\[Nexus trimmed this tool result: 1\.0 MB in total; the middle \d+ KB was dropped, the first and last 64 KB are kept\.\]/);
    expect(bytes(trimmed)).toBeLessThan(TRIMMED_KEEP_BYTES * 2 + 512);
  });

  it('keeps an object result structured and trims only its long strings', () => {
    const result = { success: true, path: 'Notes/Big.md', content: 'c'.repeat(2 * 1024 * 1024), meta: { lines: 40000 } };
    const trimmed = trimToolResultForStorage(result) as typeof result;
    expect(trimmed).toEqual(expect.objectContaining({ success: true, path: 'Notes/Big.md', meta: { lines: 40000 } }));
    expect(trimmed.content).toContain('[Nexus trimmed this tool result');
    expect(bytes(trimmed)).toBeLessThanOrEqual(MAX_STORED_TOOL_RESULT_BYTES);
    expect(result.content).toHaveLength(2 * 1024 * 1024); // input untouched
  });

  it('falls back to the head and tail of the serialized result when no single string is long', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ index, text: 'row text '.repeat(10) }));
    const trimmed = trimToolResultForStorage({ rows });
    expect(typeof trimmed).toBe('string');
    expect(trimmed as string).toMatch(/^\{"rows":\[\{"index":0/);
    expect(bytes(trimmed)).toBeLessThanOrEqual(MAX_STORED_TOOL_RESULT_BYTES);
  });

  it('never splits an emoji at either cut', () => {
    const value = '🧪'.repeat(200_000);
    const trimmed = trimLongString(value);
    expect(trimmed).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(trimmed).not.toMatch(/(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/);
  });

  it('is stable: trimming a trimmed result changes nothing', () => {
    const once = trimToolResultForStorage({ content: 'z'.repeat(1024 * 1024) });
    expect(trimToolResultForStorage(once)).toEqual(once);
  });
});
