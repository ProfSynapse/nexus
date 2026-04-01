import { CompactionTranscriptRecoveryService } from '../../src/services/chat/CompactionTranscriptRecoveryService';
import type { MessageData } from '../../src/types/storage/HybridStorageTypes';

function createMessage(
  id: string,
  conversationId: string,
  sequenceNumber: number,
  role: MessageData['role'] = 'user'
): MessageData {
  return {
    id,
    conversationId,
    role,
    content: `${role}-${sequenceNumber}`,
    timestamp: 1_742_900_000_000 + sequenceNumber,
    state: 'complete',
    sequenceNumber
  };
}

describe('CompactionTranscriptRecoveryService', () => {
  const conversationId = 'conv_compaction';
  const storedMessages: MessageData[] = [
    createMessage('m1', conversationId, 0, 'user'),
    createMessage('m2', conversationId, 1, 'assistant'),
    createMessage('m3', conversationId, 2, 'user'),
    createMessage('m4', conversationId, 3, 'assistant'),
    createMessage('m5', conversationId, 4, 'user'),
    createMessage('m6', conversationId, 5, 'assistant')
  ];

  function createService() {
    const adapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue([
        JSON.stringify({
          id: 'evt1',
          type: 'message',
          deviceId: 'device-1',
          timestamp: 1000,
          conversationId,
          data: {
            id: 'm1',
            role: 'user',
            content: 'user-0',
            state: 'complete',
            sequenceNumber: 0
          }
        }),
        JSON.stringify({
          id: 'evt2',
          type: 'message',
          deviceId: 'device-1',
          timestamp: 1001,
          conversationId,
          data: {
            id: 'm2',
            role: 'assistant',
            content: 'assistant-1',
            state: 'complete',
            sequenceNumber: 1
          }
        }),
        JSON.stringify({
          id: 'evt3',
          type: 'message_updated',
          deviceId: 'device-1',
          timestamp: 1002,
          conversationId,
          messageId: 'm2',
          data: {
            content: 'assistant-1-updated'
          }
        }),
        JSON.stringify({
          id: 'evt4',
          type: 'message_deleted',
          deviceId: 'device-1',
          timestamp: 1003,
          conversationId,
          messageId: 'm1'
        })
      ].join('\n'))
    };

    const app = {
      vault: {
        adapter
      }
    };

    const repository = {
      getMessages: jest.fn().mockImplementation(async (_convId: string, options?: { page?: number; pageSize?: number }) => {
        const page = options?.page ?? 0;
        const pageSize = options?.pageSize ?? 200;
        const start = page * pageSize;
        const items = storedMessages.slice(start, start + pageSize);

        return {
          items,
          total: storedMessages.length,
          page,
          pageSize,
          hasNextPage: start + pageSize < storedMessages.length
        };
      }),
      getMessagesBySequenceRange: jest.fn().mockImplementation(async (convId: string, startSeq: number, endSeq: number) => {
        return storedMessages.filter(
          message =>
            message.conversationId === convId &&
            message.sequenceNumber >= startSeq &&
            message.sequenceNumber <= endSeq
        );
      })
    };

    return {
      adapter,
      repository,
      service: new CompactionTranscriptRecoveryService(repository, app as typeof app)
    };
  }

  it('builds a coverage ref from compacted message ids', async () => {
    const { repository, service } = createService();

    const coverage = await service.buildCoverageRef(conversationId, ['m1', 'm2', 'm3', 'm4']);

    expect(repository.getMessages).toHaveBeenCalledWith(conversationId, {
      page: 0,
      pageSize: 200
    });
    expect(coverage).toEqual({
      conversationId,
      startSequenceNumber: 0,
      endSequenceNumber: 3
    });
  });

  it('returns null when not all compacted message ids can be resolved exactly', async () => {
    const { service } = createService();

    const coverage = await service.buildCoverageRef(conversationId, ['m1', 'missing']);

    expect(coverage).toBeNull();
  });

  it('recovers the exact transcript range from the append-only conversation event log', async () => {
    const { adapter, service } = createService();

    const recovered = await service.recoverTranscript({
      conversationId,
      startSequenceNumber: 0,
      endSequenceNumber: 1
    });

    expect(adapter.exists).toHaveBeenCalledWith(
      `.nexus/conversations/conv_${conversationId}.jsonl`
    );
    expect(recovered.map(message => ({
      id: message.id,
      content: message.content
    }))).toEqual([
      { id: 'm1', content: 'user-0' },
      { id: 'm2', content: 'assistant-1-updated' }
    ]);
  });
});
