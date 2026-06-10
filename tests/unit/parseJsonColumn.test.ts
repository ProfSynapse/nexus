import { parseJsonColumn } from '../../src/database/utils/jsonColumn';

describe('parseJsonColumn', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('parses valid JSON', () => {
    expect(parseJsonColumn<{ a: number }>('{"a":1}', 'ctx')).toEqual({ a: 1 });
    expect(parseJsonColumn<string[]>('["x","y"]', 'ctx')).toEqual(['x', 'y']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined for null/undefined/empty without warning', () => {
    expect(parseJsonColumn(null, 'ctx')).toBeUndefined();
    expect(parseJsonColumn(undefined, 'ctx')).toBeUndefined();
    expect(parseJsonColumn('', 'ctx')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined AND warns (with context) on a corrupt column', () => {
    expect(parseJsonColumn('{not json', 'MessageRepository.metadata#42')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MessageRepository.metadata#42');
  });
});
