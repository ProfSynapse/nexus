import { AdapterStore } from '../../src/services/embeddings/adapter/AdapterStore';
import { EmbeddingAdapter, AdapterSnapshot } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

function makeFs() {
  return {
    exists: jest.fn(),
    read: jest.fn(),
    write: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined)
  };
}

const settings = () => ({ storage: { rootPath: 'Nexus' } }) as never;
const ADAPTER_PATH = 'Nexus/data/embeddings/adapter.json';

describe('AdapterStore', () => {
  it('returns identity when no adapter file exists', async () => {
    const fs = makeFs();
    fs.exists.mockResolvedValue(false);
    const store = new AdapterStore(fs as never, settings);

    const adapter = await store.load();

    expect(adapter.isIdentity).toBe(true);
    expect(fs.exists).toHaveBeenCalledWith(ADAPTER_PATH);
  });

  it('loads a persisted snapshot', async () => {
    const fs = makeFs();
    const snap: AdapterSnapshot = {
      version: 3, dim: 2, rank: 1, alpha: 0.5, U: [[0.1], [0.2]], V: [[0.3], [0.4]]
    };
    fs.exists.mockResolvedValue(true);
    fs.read.mockResolvedValue(JSON.stringify(snap));
    const store = new AdapterStore(fs as never, settings);

    const adapter = await store.load();

    expect(adapter.isIdentity).toBe(false);
    expect(adapter.version).toBe(3);
  });

  it('falls back to identity on unreadable / corrupt content', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fs = makeFs();
    fs.exists.mockResolvedValue(true);
    fs.read.mockResolvedValue('{ not valid json');
    const store = new AdapterStore(fs as never, settings);

    const adapter = await store.load();

    expect(adapter.isIdentity).toBe(true);
    warn.mockRestore();
  });

  it('creates the directory on first save and writes the snapshot', async () => {
    const fs = makeFs();
    fs.exists.mockResolvedValue(false);
    const store = new AdapterStore(fs as never, settings);

    await store.save(EmbeddingAdapter.identity());

    expect(fs.mkdir).toHaveBeenCalledWith('Nexus/data/embeddings');
    expect(fs.write).toHaveBeenCalledWith(ADAPTER_PATH, expect.stringContaining('"rank":0'));
  });

  it('does not re-create the directory when it already exists', async () => {
    const fs = makeFs();
    fs.exists.mockResolvedValue(true);
    const store = new AdapterStore(fs as never, settings);

    await store.save(EmbeddingAdapter.identity());

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.write).toHaveBeenCalled();
  });
});
