import { NoteEmbeddingService } from '../../src/services/embeddings/NoteEmbeddingService';
import { EmbeddingAdapter, type QueryAdapter } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

/**
 * Apply-point coverage for PR2: the query-side adapter is applied in
 * semanticSearch, and the shipped identity adapter changes nothing.
 */
function makeService(adapter: QueryAdapter | undefined, engineOutput: Float32Array) {
  const db = { query: jest.fn().mockResolvedValue([]) };
  const engine = { generateEmbedding: jest.fn().mockResolvedValue(engineOutput) };
  const service = new NoteEmbeddingService({} as never, db as never, engine as never, adapter);
  return { service, db, engine };
}

const queryBufferArg = (db: { query: jest.Mock }): Buffer =>
  db.query.mock.calls[0][1][0] as Buffer;

describe('NoteEmbeddingService query adapter', () => {
  it('passes the raw query vector through unchanged under the identity adapter', async () => {
    const engineOutput = new Float32Array([0.1, 0.2, 0.3]);
    const { service, db } = makeService(EmbeddingAdapter.identity(), engineOutput);

    await service.semanticSearch('graph theory', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(engineOutput.buffer));
  });

  it('defaults to identity when no adapter is supplied', async () => {
    const engineOutput = new Float32Array([0.4, 0.5, 0.6]);
    const { service, db } = makeService(undefined, engineOutput);

    await service.semanticSearch('q', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(engineOutput.buffer));
  });

  it('uses the adapter-transformed vector for the KNN query', async () => {
    const engineOutput = new Float32Array([1, 0, 0]);
    const transformed = new Float32Array([0, 1, 0]);
    const adapter: QueryAdapter = {
      isIdentity: false,
      version: 1,
      transform: jest.fn().mockReturnValue(transformed)
    };
    const { service, db, engine } = makeService(adapter, engineOutput);

    await service.semanticSearch('q', 5);

    expect(adapter.transform).toHaveBeenCalledWith(engineOutput);
    expect(queryBufferArg(db)).toEqual(Buffer.from(transformed.buffer));
    expect(engine.generateEmbedding).toHaveBeenCalledWith('q');
  });

  it('swaps the adapter at runtime via setQueryAdapter', async () => {
    const engineOutput = new Float32Array([1, 0, 0]);
    const transformed = new Float32Array([0, 0, 1]);
    const { service, db } = makeService(undefined, engineOutput);
    service.setQueryAdapter({ isIdentity: false, version: 2, transform: () => transformed });

    await service.semanticSearch('q', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(transformed.buffer));
  });
});
