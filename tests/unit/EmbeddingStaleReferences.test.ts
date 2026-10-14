/**
 * Turning semantic search off must leave nothing that can wake the model up.
 *
 * Failure this buys: teardown disposed the engine but left the service marked
 * enabled, and EmbeddingEngine lazily re-initialized on the next call. Anything
 * still holding the old service (an open task modal's note suggester, a dream
 * cycle or a search already under way) then rebuilt a hidden iframe with the
 * model loaded while search was "off", and nothing ever disposed it.
 *
 * Real pieces: EmbeddingEngine and EmbeddingService. Faked: EmbeddingIframe
 * (counts how many are built) and the domain services (record calls).
 */
const mockIframes: Array<{ disposed: boolean }> = [];
jest.mock('../../src/services/embeddings/EmbeddingIframe', () => ({
  EmbeddingIframe: jest.fn().mockImplementation(() => {
    const iframe = {
      disposed: false,
      ready: () => !iframe.disposed,
      initialize: jest.fn().mockResolvedValue(undefined),
      generateEmbedding: jest.fn().mockResolvedValue(new Float32Array(384)),
      generateEmbeddings: jest.fn().mockResolvedValue([new Float32Array(384)]),
      dispose: jest.fn(async () => { iframe.disposed = true; })
    };
    mockIframes.push(iframe);
    return iframe;
  })
}));

const mockNoteSearch = jest.fn().mockResolvedValue([{ notePath: 'a.md', similarity: 1 }]);
jest.mock('../../src/services/embeddings/NoteEmbeddingService', () => ({
  NoteEmbeddingService: jest.fn().mockImplementation(() => ({ semanticSearch: mockNoteSearch, setQueryAdapter: jest.fn() }))
}));
jest.mock('../../src/services/embeddings/TraceEmbeddingService', () => ({ TraceEmbeddingService: jest.fn() }));
jest.mock('../../src/services/embeddings/ConversationEmbeddingService', () => ({ ConversationEmbeddingService: jest.fn() }));

import { EmbeddingEngine } from '../../src/services/embeddings/EmbeddingEngine';
import { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';

beforeEach(() => {
  mockIframes.length = 0;
  mockNoteSearch.mockClear();
});

it('a disposed engine refuses to embed instead of building a new iframe', async () => {
  const engine = new EmbeddingEngine();
  await engine.generateEmbedding('first');
  expect(mockIframes).toHaveLength(1);

  await engine.dispose();
  expect(mockIframes[0].disposed).toBe(true);

  await expect(engine.generateEmbedding('late')).rejects.toThrow('disposed');
  await expect(engine.generateEmbeddings(['late'])).rejects.toThrow('disposed');
  await expect(engine.initialize()).rejects.toThrow('disposed');
  expect(mockIframes).toHaveLength(1);
});

it('a disabled service answers empty and never reaches its engine', async () => {
  const engine = new EmbeddingEngine();
  const service = new EmbeddingService({} as never, {} as never, engine);
  expect(await service.semanticSearch('query')).toHaveLength(1);

  service.disable();

  expect(service.isServiceEnabled()).toBe(false);
  expect(await service.semanticSearch('query')).toEqual([]);
  expect(await service.embedQueryText('query')).toBeNull();
  expect(mockNoteSearch).toHaveBeenCalledTimes(1);
  expect(mockIframes).toHaveLength(0);
});
