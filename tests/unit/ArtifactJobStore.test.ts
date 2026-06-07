import type { Vault } from 'obsidian';
import { ArtifactJobStore } from '../../src/services/artifacts/ArtifactJobStore';

type MockVault = Vault & {
  adapter: {
    exists: jest.Mock<Promise<boolean>, [string]>;
    read: jest.Mock<Promise<string>, [string]>;
    append: jest.Mock<Promise<void>, [string, string]>;
    mkdir: jest.Mock<Promise<void>, [string]>;
  };
};

function makeVault(): MockVault {
  const files = new Map<string, string>();
  return {
    adapter: {
      exists: jest.fn(async (path: string) => files.has(path)),
      read: jest.fn(async (path: string) => files.get(path) || ''),
      append: jest.fn(async (path: string, data: string) => {
        files.set(path, `${files.get(path) || ''}${data}`);
      }),
      mkdir: jest.fn(async (path: string) => {
        files.set(path, files.get(path) || '');
      }),
    },
  } as unknown as MockVault;
}

describe('ArtifactJobStore', () => {
  it('appends and reduces artifact job records', async () => {
    const vault = makeVault();
    const store = new ArtifactJobStore(vault);

    const created = await store.create({
      kind: 'video',
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      providerJobId: 'job-1',
      pollingUrl: 'https://openrouter.ai/api/v1/videos/job-1',
      outputPath: 'video/result.mp4',
      overwrite: true,
      request: {
        seconds: 4,
        aspectRatio: '16:9',
        resolution: '720p',
      },
    });

    await store.update(created.id, {
      status: 'completed',
      result: {
        path: 'video/result.mp4',
      },
    });

    const loaded = await store.get(created.id);
    expect(loaded).toMatchObject({
      id: created.id,
      kind: 'video',
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      providerJobId: 'job-1',
      status: 'completed',
      outputPath: 'video/result.mp4',
      overwrite: true,
      result: {
        path: 'video/result.mp4',
      },
    });
    expect(vault.adapter.mkdir).toHaveBeenCalledWith('Nexus');
    expect(vault.adapter.mkdir).toHaveBeenCalledWith('Nexus/data');
    expect(vault.adapter.append).toHaveBeenCalledWith(
      'Nexus/data/artifact-jobs.jsonl',
      expect.any(String)
    );
    expect(vault.adapter.append).toHaveBeenCalledTimes(2);
  });

  it('uses the caller-provided storage path', async () => {
    const vault = makeVault();
    const store = new ArtifactJobStore(vault, 'Assistant data/data/artifact-jobs.jsonl');

    await store.create({
      kind: 'video',
      provider: 'google',
      providerJobId: 'operations/video-1',
      outputPath: 'video/result.mp4',
    });

    expect(vault.adapter.mkdir).toHaveBeenCalledWith('Assistant data');
    expect(vault.adapter.mkdir).toHaveBeenCalledWith('Assistant data/data');
    expect(vault.adapter.append).toHaveBeenCalledWith(
      'Assistant data/data/artifact-jobs.jsonl',
      expect.any(String)
    );
  });
});
