/**
 * Reproduction test using the actual user conversation: "The Intelligence Curse"
 * conv_3dde535c-1c26-4a8e-9b2c-42a33a0561bd
 *
 * This conversation hits the Azure call_id error on retry. We replay it
 * through buildContextForProvider and inspect what the OpenAI/OpenRouter
 * messages array looks like — every tool message should have a tool_call_id
 * that matches one of the assistant's tool_calls[i].id.
 */

import * as fs from 'node:fs';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import type { ConversationData, ConversationMessage } from '../../src/types';

function loadActualConversation(): ConversationData {
  // Apply JSONL events to build current state
  const fp = '/Users/jrosenbaum/Documents/Professor Synapse/Nexus/data/conversations/conv_3dde535c-1c26-4a8e-9b2c-42a33a0561bd/shard-000001.jsonl';
  const events = fs.readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));

  const messagesById = new Map<string, Record<string, unknown>>();
  const order: string[] = [];

  for (const e of events) {
    const t = e.type;
    if (t === 'message') {
      const d = e.data || {};
      const mid = d.id;
      if (mid && !messagesById.has(mid)) {
        order.push(mid);
        messagesById.set(mid, { ...d });
      }
    } else if (t === 'message_updated') {
      const mid = e.messageId || e.data?.id;
      if (mid) {
        if (!messagesById.has(mid)) {
          order.push(mid);
          messagesById.set(mid, { ...(e.data || {}) });
        } else {
          const existing = messagesById.get(mid)!;
          Object.assign(existing, e.data || {});
        }
      }
    }
  }

  const messages: ConversationMessage[] = order.map((mid) => {
    const m = messagesById.get(mid)!;
    return {
      id: mid,
      role: m.role as 'user' | 'assistant' | 'system',
      content: (m.content as string) || '',
      timestamp: (m.timestamp as number) || Date.now(),
      conversationId: '3dde535c-1c26-4a8e-9b2c-42a33a0561bd',
      state: m.state as ConversationMessage['state'],
      // tool_calls in JSONL is snake_case; runtime uses camelCase toolCalls
      toolCalls: m.tool_calls as ConversationMessage['toolCalls'],
    } as ConversationMessage;
  });

  return {
    id: '3dde535c-1c26-4a8e-9b2c-42a33a0561bd',
    title: 'The Intelligence Curse',
    created: Date.now(),
    updated: Date.now(),
    messages,
  } as unknown as ConversationData;
}

describe('Intelligence Curse reproduction', () => {
  it('loads conversation and replays through buildContextForProvider', () => {
    const conversation = loadActualConversation();

    console.log(`\n=== Conversation: ${conversation.messages.length} messages ===`);
    for (let i = 0; i < conversation.messages.length; i++) {
      const m = conversation.messages[i] as ConversationMessage & { toolCalls?: Array<{ id?: string; function?: { name?: string }; success?: boolean; result?: unknown }> };
      const tcs = m.toolCalls || [];
      const tcInfo = tcs.length > 0
        ? ` toolCalls=[${tcs.map(tc => `${tc.function?.name || '?'}(id=${tc.id || '<MISSING>'},success=${tc.success},hasResult=${tc.result !== undefined})`).join(', ')}]`
        : '';
      console.log(`  [${i}] ${m.id} role=${m.role} state=${m.state} content_len=${m.content.length}${tcInfo}`);
    }

    // Simulate retry: filter out the LAST message (the failed AI response)
    const lastIdx = conversation.messages.length - 1;
    const filteredConversation: ConversationData = {
      ...conversation,
      messages: conversation.messages.slice(0, lastIdx),
    } as ConversationData;

    console.log(`\n=== Filtered (excluding last AI msg): ${filteredConversation.messages.length} messages ===`);

    // Build messages for openrouter
    const built = ConversationContextBuilder.buildContextForProvider(
      filteredConversation,
      'openrouter',
      'You are a helpful assistant.'
    );

    console.log(`\n=== Built ${built.length} messages for OpenRouter ===`);
    const tcIdsByPosition: Record<number, string> = {};
    const toolCallIdsByPosition: Record<number, string> = {};
    for (let i = 0; i < built.length; i++) {
      const m = built[i] as { role: string; content?: unknown; tool_calls?: Array<{ id?: string }>; tool_call_id?: string };
      const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const contentPreview = (contentStr || '').slice(0, 60);
      let extra = '';
      if (m.tool_calls) {
        const ids = m.tool_calls.map(tc => tc.id || '<MISSING>');
        extra = ` tool_calls=[${ids.join(',')}]`;
        ids.forEach((id, j) => { tcIdsByPosition[i * 100 + j] = id; });
      }
      if (m.tool_call_id !== undefined) {
        extra += ` tool_call_id=${m.tool_call_id || '<EMPTY>'}`;
        toolCallIdsByPosition[i] = m.tool_call_id;
      }
      console.log(`  [${i}] role=${m.role}${extra} content="${contentPreview}"`);
    }

    // Verify pairing: every tool_call_id should match an assistant's tool_calls[i].id
    const allAssistantToolCallIds = new Set<string>();
    for (const m of built) {
      const tcs = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          if (tc.id) allAssistantToolCallIds.add(tc.id);
        }
      }
    }

    const orphanedToolMessages: number[] = [];
    for (let i = 0; i < built.length; i++) {
      const m = built[i] as { role: string; tool_call_id?: string };
      if (m.role === 'tool') {
        if (!m.tool_call_id || !allAssistantToolCallIds.has(m.tool_call_id)) {
          orphanedToolMessages.push(i);
        }
      }
    }

    if (orphanedToolMessages.length > 0) {
      console.log(`\n!!! ORPHANED tool messages at positions: ${orphanedToolMessages.join(', ')}`);
      for (const pos of orphanedToolMessages) {
        const m = built[pos] as { role: string; tool_call_id?: string; content?: string };
        console.log(`  [${pos}] tool_call_id="${m.tool_call_id}" content="${(m.content || '').slice(0, 80)}"`);
      }
    }

    expect(orphanedToolMessages).toEqual([]);

    // Verify all tool_call_ids are now in OpenAI-compatible format (start with "call_")
    // This prevents Azure (via OpenRouter) from rejecting Bedrock-format ids like
    // "toolu_bdrk_*" that some providers (Anthropic via AWS Bedrock) generate.
    const foreignFormatIds: Array<{ pos: number; id: string }> = [];
    for (let i = 0; i < built.length; i++) {
      const m = built[i] as { role: string; tool_call_id?: string; tool_calls?: Array<{ id?: string }> };
      if (m.tool_call_id && !m.tool_call_id.startsWith('call_')) {
        foreignFormatIds.push({ pos: i, id: m.tool_call_id });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id && !tc.id.startsWith('call_')) {
            foreignFormatIds.push({ pos: i, id: tc.id });
          }
        }
      }
    }

    if (foreignFormatIds.length > 0) {
      console.log(`\n!!! Foreign-format ids still present: ${JSON.stringify(foreignFormatIds, null, 2)}`);
    }

    expect(foreignFormatIds).toEqual([]);
  });

  it('full flow: buildLLMMessages → LLMService re-map preserves tool_call_id', () => {
    const conversation = loadActualConversation();
    const lastIdx = conversation.messages.length - 1;
    const filteredConversation: ConversationData = {
      ...conversation,
      messages: conversation.messages.slice(0, lastIdx),
    } as ConversationData;

    // Step 1: buildContextForProvider (mirrors StreamingResponseService.buildLLMMessages)
    const built = ConversationContextBuilder.buildContextForProvider(
      filteredConversation,
      'openrouter',
      'You are a helpful assistant.'
    );

    // Step 2: StreamingResponseService.buildLLMMessages mapping (preserves fields)
    const afterStreamingService = built.map((message) => {
      const m = message as { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
      const out: Record<string, unknown> = {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    // Step 3: LLMService.generateResponseStream re-mapping (the FIXED version)
    const afterLLMService = afterStreamingService.map(msg => {
      const m = msg as { role: string; content: string; tool_calls?: unknown; tool_call_id?: string };
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });

    console.log('\n=== After full flow (the messages that reach OpenRouter) ===');
    let orphans = 0;
    for (let i = 0; i < afterLLMService.length; i++) {
      const m = afterLLMService[i] as { role: string; tool_call_id?: string; tool_calls?: Array<{ id?: string }> };
      const tcIds = m.tool_calls?.map(tc => tc.id).join(',');
      const info = m.tool_call_id ? ` tool_call_id=${m.tool_call_id}`
        : m.tool_calls ? ` tool_calls=[${tcIds}]`
        : '';
      console.log(`  [${i}] role=${m.role}${info}`);
      if (m.role === 'tool' && !m.tool_call_id) orphans++;
    }

    expect(orphans).toBe(0);
  });
});
