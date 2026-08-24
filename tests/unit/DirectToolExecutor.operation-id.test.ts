import { createNativeToolOperationId } from '../../src/services/chat/DirectToolExecutor';

describe('native tool operation identity', () => {
  it('scopes repeated provider-local ids by turn and continuation response', () => {
    const context = { turnId: 'turn-1' };
    expect(createNativeToolOperationId('google-tool_0', { ...context, operationSequence: 0 }))
      .toBe('turn-1:0:google-tool_0');
    expect(createNativeToolOperationId('google-tool_0', { ...context, operationSequence: 1 }))
      .toBe('turn-1:1:google-tool_0');
    expect(createNativeToolOperationId('google-tool_0', { turnId: 'turn-2', operationSequence: 0 }))
      .toBe('turn-2:0:google-tool_0');
  });
});
