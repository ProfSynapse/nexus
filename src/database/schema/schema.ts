/**
 * SQLite Schema for Hybrid Storage System
 * Location: src/database/schema/schema.ts
 * Purpose: Complete database schema with indexes and FTS
 * Version: 3.0.0
 *
 * CHANGELOG:
 * - v3.0.0: Added alternativesJson and activeAlternativeIndex to messages table for branching support
 *
 * NOTE: Uses camelCase column names to match TypeScript/JavaScript conventions.
 * This eliminates the need for snake_case <-> camelCase translation at the repository layer.
 */

export const SCHEMA_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);

-- ==================== WORKSPACES ====================

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rootFolder TEXT NOT NULL,
  created INTEGER NOT NULL,
  lastAccessed INTEGER NOT NULL,
  isActive INTEGER DEFAULT 1,
  contextJson TEXT,
  dedicatedAgentId TEXT,
  UNIQUE(name)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name);
CREATE INDEX IF NOT EXISTS idx_workspaces_folder ON workspaces(rootFolder);
CREATE INDEX IF NOT EXISTS idx_workspaces_active ON workspaces(isActive);
CREATE INDEX IF NOT EXISTS idx_workspaces_accessed ON workspaces(lastAccessed);

-- ==================== SESSIONS ====================

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  startTime INTEGER,
  endTime INTEGER,
  isActive INTEGER DEFAULT 0,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspaceId);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(isActive);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(startTime);

-- ==================== STATES ====================

CREATE TABLE IF NOT EXISTS states (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created INTEGER NOT NULL,
  stateJson TEXT,
  tagsJson TEXT,
  FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_states_session ON states(sessionId);
CREATE INDEX IF NOT EXISTS idx_states_workspace ON states(workspaceId);
CREATE INDEX IF NOT EXISTS idx_states_created ON states(created);

-- ==================== MEMORY TRACES ====================

CREATE TABLE IF NOT EXISTS memory_traces (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT,
  content TEXT,
  metadataJson TEXT,
  FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_traces_session ON memory_traces(sessionId);
CREATE INDEX IF NOT EXISTS idx_traces_workspace ON memory_traces(workspaceId);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON memory_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_traces_type ON memory_traces(type);

-- ==================== CONVERSATIONS ====================

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  vaultName TEXT NOT NULL,
  messageCount INTEGER DEFAULT 0,
  metadataJson TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_vault ON conversations(vaultName);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created);

-- ==================== MESSAGES ====================

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  timestamp INTEGER NOT NULL,
  state TEXT,
  toolCallsJson TEXT,
  toolCallId TEXT,
  reasoningContent TEXT,
  sequenceNumber INTEGER NOT NULL,
  alternativesJson TEXT,
  activeAlternativeIndex INTEGER DEFAULT 0,
  FOREIGN KEY(conversationId) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(conversationId, sequenceNumber);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

-- ==================== FULL-TEXT SEARCH (FTS4) ====================
-- Note: Using FTS4 instead of FTS5 for compatibility with default sql.js build

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts4(
  id,
  name,
  description,
  content='workspaces',
  tokenize=porter
);

CREATE TRIGGER IF NOT EXISTS workspace_fts_insert AFTER INSERT ON workspaces BEGIN
  INSERT INTO workspace_fts(docid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS workspace_fts_delete AFTER DELETE ON workspaces BEGIN
  DELETE FROM workspace_fts WHERE docid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS workspace_fts_update AFTER UPDATE ON workspaces BEGIN
  DELETE FROM workspace_fts WHERE docid = old.rowid;
  INSERT INTO workspace_fts(docid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts4(
  id,
  title,
  content='conversations',
  tokenize=porter
);

CREATE TRIGGER IF NOT EXISTS conversation_fts_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO conversation_fts(docid, id, title)
  VALUES (new.rowid, new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS conversation_fts_delete AFTER DELETE ON conversations BEGIN
  DELETE FROM conversation_fts WHERE docid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS conversation_fts_update AFTER UPDATE ON conversations BEGIN
  DELETE FROM conversation_fts WHERE docid = old.rowid;
  INSERT INTO conversation_fts(docid, id, title)
  VALUES (new.rowid, new.id, new.title);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4(
  id,
  conversationId,
  content,
  reasoningContent,
  content='messages',
  tokenize=porter
);

CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(docid, id, conversationId, content, reasoningContent)
  VALUES (new.rowid, new.id, new.conversationId, new.content, new.reasoningContent);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_fts WHERE docid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON messages BEGIN
  DELETE FROM message_fts WHERE docid = old.rowid;
  INSERT INTO message_fts(docid, id, conversationId, content, reasoningContent)
  VALUES (new.rowid, new.id, new.conversationId, new.content, new.reasoningContent);
END;

-- ==================== SYNC STATE ====================

CREATE TABLE IF NOT EXISTS sync_state (
  deviceId TEXT PRIMARY KEY,
  lastEventTimestamp INTEGER NOT NULL,
  syncedFilesJson TEXT
);

CREATE TABLE IF NOT EXISTS applied_events (
  eventId TEXT PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applied_events_time ON applied_events(appliedAt);

-- ==================== INITIALIZATION ====================

INSERT OR IGNORE INTO schema_version VALUES (3, strftime('%s', 'now') * 1000);
`;
