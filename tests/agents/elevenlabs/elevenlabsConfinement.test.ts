/**
 * Regression test: the ElevenLabs textToSpeech tool confines the caller-supplied
 * `outputPath` to the vault. An escaping path must be rejected WITHOUT writing the
 * audio binary. (soundEffects / musicGeneration share the identical guard.)
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { __setRequestUrlMock } from 'obsidian';
import { TextToSpeechTool } from '@/agents/apps/elevenlabs/tools/textToSpeech';

// A POSIX leading slash (/tmp/ESCAPE.mp3) is stripped to vault-relative (backward-compat), not an escape.
const ESCAPING = ['../../../../tmp/ESCAPE.mp3', '~/ESCAPE.mp3'];

function makeAgent(): { agent: any; createBinary: jest.Mock } {
  const createBinary = jest.fn().mockResolvedValue(undefined);
  const vault = {
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    createFolder: jest.fn().mockResolvedValue(undefined),
    createBinary,
  };
  const agent = {
    hasRequiredCredentials: () => true,
    getMissingCredentials: () => [],
    getCredential: () => 'api-key',
    getDefaultModelId: () => 'eleven_multilingual_v2',
    getVault: () => vault,
  };
  return { agent, createBinary };
}

beforeEach(() => {
  __setRequestUrlMock(async () => ({
    status: 200,
    arrayBuffer: new ArrayBuffer(8),
    text: '',
    headers: {},
    json: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
});

describe('TextToSpeechTool outputPath confinement', () => {
  it.each(ESCAPING)('rejects escaping outputPath %s with no binary write', async (outputPath) => {
    const { agent, createBinary } = makeAgent();
    const result = await new TextToSpeechTool(agent).execute({ prompt: 'hello', outputPath } as any);
    expect(result.success).toBe(false);
    expect(createBinary).not.toHaveBeenCalled();
  });

  it('writes audio to a normal vault path', async () => {
    const { agent, createBinary } = makeAgent();
    const result = await new TextToSpeechTool(agent).execute({ prompt: 'hello', outputPath: 'audio/out.mp3' } as any);
    expect(result.success).toBe(true);
    expect(createBinary).toHaveBeenCalledWith('audio/out.mp3', expect.anything());
  });
});
