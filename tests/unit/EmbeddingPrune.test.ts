/**
 * Vectors of notes and chats removed while semantic search was off are pruned.
 *
 * The watcher removes a vector when a note is deleted or renamed, and the
 * conversation service when a chat is deleted, but only while semantic search
 * is running. The indexing passes walk only what still exists, so a note
 * deleted while search was off kept its vector forever, and kept turning up
 * as a semantic candidate.
 *
 * What is real: IndexingQueue. What is faked: the vault (a path set), the
 * embedding service (records removals) and the cache database (two in-memory
 * tables). The fake database answers the queue's SQL by computing it from
 * those tables, including the NOT IN for conversations, so the assertions
 * are about which rows the queue decides to remove, not about canned answers.
 */

import { TFile } from 'obsidian';
import { IndexingQueue } from '../../src/services/embeddings/IndexingQueue';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { App } from 'obsidian';

interface Fixture {
  vaultPaths: string[];
  embeddedNotes: string[];
  conversations: string[];
  embeddedConversations: string[];
}

function createQueue(fixture: Fixture) {
  const files = new Map(fixture.vaultPaths.map(path => [path, new TFile(path.split('/').pop() ?? path, path)]));
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path: string) => files.get(path) ?? null
    }
  } as unknown as App;

  const embeddedNotes = new Set(fixture.embeddedNotes);
  const embeddedConversations = [...fixture.embeddedConversations];
  const conversations = new Set(fixture.conversations);

  const service = {
    isServiceEnabled: () => true,
    removeEmbedding: jest.fn(async (path: string) => { embeddedNotes.delete(path); }),
    removeConversationEmbeddings: jest.fn(async (id: string) => {
      for (let i = embeddedConversations.length - 1; i >= 0; i--) {
        if (embeddedConversations[i] === id) embeddedConversations.splice(i, 1);
      }
    })
  };

  const db = {
    query: jest.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized === 'SELECT notePath FROM embedding_metadata') {
        return [...embeddedNotes].map(notePath => ({ notePath }));
      }
      if (normalized === 'SELECT DISTINCT conversationId FROM conversation_embedding_metadata WHERE conversationId NOT IN (SELECT id FROM conversations)') {
        return [...new Set(embeddedConversations)]
          .filter(id => !conversations.has(id))
          .map(conversationId => ({ conversationId }));
      }
      throw new Error(`Unexpected query: ${normalized}`);
    }),
    queryOne: jest.fn(async (sql: string) => {
      if (sql === 'SELECT COUNT(*) as count FROM conversations') {
        return { count: conversations.size };
      }
      throw new Error(`Unexpected queryOne: ${sql}`);
    }),
    save: jest.fn(async () => undefined)
  };

  const queue = new IndexingQueue(
    app,
    service as unknown as EmbeddingService,
    db as unknown as SQLiteCacheManager
  );
  return { queue, service, db, embeddedNotes, embeddedConversations };
}

describe('IndexingQueue.pruneMissingNotes', () => {
  it('removes vectors of deleted and renamed-away notes and keeps the rest', async () => {
    const h = createQueue({
      vaultPaths: ['Kept.md', 'Folder/Renamed new.md'],
      embeddedNotes: ['Kept.md', 'Deleted while off.md', 'Folder/Renamed old.md'],
      conversations: [],
      embeddedConversations: []
    });

    const removed = await h.queue.pruneMissingNotes();

    expect(removed).toBe(2);
    expect([...h.embeddedNotes].sort()).toEqual(['Kept.md']);
    expect(h.service.removeEmbedding).not.toHaveBeenCalledWith('Kept.md');
    expect(h.db.save).toHaveBeenCalledTimes(1);
  });

  it('removes nothing and does not save when every embedded note still exists', async () => {
    const h = createQueue({
      vaultPaths: ['A.md', 'B.md'],
      embeddedNotes: ['A.md', 'B.md'],
      conversations: [],
      embeddedConversations: []
    });

    expect(await h.queue.pruneMissingNotes()).toBe(0);
    expect(h.service.removeEmbedding).not.toHaveBeenCalled();
    expect(h.db.save).not.toHaveBeenCalled();
  });

  it('refuses to prune against an empty vault, which is more likely not loaded than emptied', async () => {
    const h = createQueue({
      vaultPaths: [],
      embeddedNotes: ['A.md', 'B.md'],
      conversations: [],
      embeddedConversations: []
    });

    expect(await h.queue.pruneMissingNotes()).toBe(0);
    expect([...h.embeddedNotes].sort()).toEqual(['A.md', 'B.md']);
  });

  it('does nothing once the queue is destroyed', async () => {
    const h = createQueue({
      vaultPaths: ['A.md'],
      embeddedNotes: ['A.md', 'Gone.md'],
      conversations: [],
      embeddedConversations: []
    });
    h.queue.destroy();

    expect(await h.queue.pruneMissingNotes()).toBe(0);
    expect(h.embeddedNotes.has('Gone.md')).toBe(true);
  });
});

describe('IndexingQueue.pruneMissingConversations', () => {
  it('removes vectors of deleted conversations and keeps existing ones', async () => {
    const h = createQueue({
      vaultPaths: ['A.md'],
      embeddedNotes: [],
      conversations: ['conv-kept'],
      embeddedConversations: ['conv-kept', 'conv-kept', 'conv-deleted', 'conv-deleted', 'conv-gone']
    });

    const removed = await h.queue.pruneMissingConversations();

    expect(removed).toBe(2);
    expect(h.embeddedConversations).toEqual(['conv-kept', 'conv-kept']);
    expect(h.service.removeConversationEmbeddings).not.toHaveBeenCalledWith('conv-kept');
    expect(h.db.save).toHaveBeenCalledTimes(1);
  });

  it('skips the pass when the conversations table is empty (cache not replayed yet)', async () => {
    const h = createQueue({
      vaultPaths: ['A.md'],
      embeddedNotes: [],
      conversations: [],
      embeddedConversations: ['conv-1', 'conv-2']
    });

    expect(await h.queue.pruneMissingConversations()).toBe(0);
    expect(h.embeddedConversations).toEqual(['conv-1', 'conv-2']);
  });
});
