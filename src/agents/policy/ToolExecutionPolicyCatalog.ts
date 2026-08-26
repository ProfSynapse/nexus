import type { ToolExecutionPolicy } from './ToolExecutionPolicy';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from './ToolExecutionPolicy';

const readParallel = policy('read', true, 'safe', 'none');
const readSerial = policy('read', false, 'safe', 'none');
const vaultWrite = policy('vault-write', false, 'deduplicate', 'none');
const vaultWriteUndo = policy('vault-write', false, 'deduplicate', 'vault-preimage');
const externalWrite = policy('external-write', false, 'unsafe', 'none');
const destructive = policy('destructive', false, 'unsafe', 'none');

function policy(
  effect: ToolExecutionPolicy['effect'],
  parallelSafe: boolean,
  replay: ToolExecutionPolicy['replay'],
  undo: ToolExecutionPolicy['undo']
): Readonly<ToolExecutionPolicy> {
  return Object.freeze({ effect, parallelSafe, replay, undo });
}

/**
 * Source-owned inventory for every caller-visible registered tool.
 *
 * Keys deliberately use the internal agent and tool slugs because this is the
 * identity resolved by ToolBatchExecutionService. A contract test compares the
 * keys with the generated live CLI catalog so adding or removing a tool cannot
 * leave policy coverage stale.
 */
export const TOOL_EXECUTION_POLICY_CATALOG: Readonly<Record<string, Readonly<ToolExecutionPolicy>>> = Object.freeze({
  'baseManager/analyze': readParallel,
  'baseManager/list': readParallel,
  'baseManager/read': readParallel,
  'baseManager/update': vaultWrite,
  'baseManager/write': vaultWrite,

  'canvasManager/list': readParallel,
  'canvasManager/read': readParallel,
  'canvasManager/update': vaultWriteUndo,
  'canvasManager/write': vaultWriteUndo,

  'composer/compose': vaultWrite,
  'composer/listFormats': readParallel,

  'contentManager/insert': vaultWriteUndo,
  'contentManager/read': readParallel,
  'contentManager/removeProperty': vaultWriteUndo,
  'contentManager/replace': vaultWriteUndo,
  'contentManager/setProperty': vaultWriteUndo,
  'contentManager/write': vaultWriteUndo,

  'data/listCapabilities': readParallel,
  'data/runPython': vaultWrite,

  'elevenlabs/generateMusic': externalWrite,
  'elevenlabs/listVoices': readParallel,
  'elevenlabs/soundEffects': externalWrite,

  'ingestManager/capabilities': readParallel,
  'ingestManager/run': externalWrite,

  'memoryManager/archiveState': vaultWrite,
  'memoryManager/archiveWorkspace': vaultWrite,
  'memoryManager/createState': vaultWrite,
  'memoryManager/createWorkspace': vaultWrite,
  'memoryManager/listStates': readParallel,
  'memoryManager/listWorkspaces': readParallel,
  'memoryManager/loadState': readParallel,
  'memoryManager/loadWorkspace': readParallel,
  'memoryManager/run': externalWrite,
  'memoryManager/searchWorkspaces': readParallel,
  'memoryManager/updateState': vaultWrite,
  'memoryManager/updateWorkspace': vaultWrite,

  'promptManager/archive': vaultWrite,
  'promptManager/checkGeneratedArtifact': externalWrite,
  'promptManager/create': vaultWrite,
  'promptManager/execute': destructive,
  'promptManager/generateAudio': externalWrite,
  'promptManager/generateImage': externalWrite,
  'promptManager/generateVideo': externalWrite,
  'promptManager/get': readParallel,
  'promptManager/list': readParallel,
  'promptManager/listModels': readParallel,
  'promptManager/subagent': destructive,
  'promptManager/update': vaultWrite,

  'searchManager/content': readParallel,
  'searchManager/directory': readParallel,
  'searchManager/memory': readParallel,
  'searchManager/queryNotes': readParallel,

  'skills/archiveSkill': vaultWrite,
  'skills/createSkill': vaultWrite,
  'skills/listSkills': readParallel,
  'skills/loadSkill': readParallel,
  'skills/syncSkills': externalWrite,
  'skills/updateSkill': vaultWrite,

  'storageManager/archive': vaultWriteUndo,
  'storageManager/copy': vaultWriteUndo,
  'storageManager/createFolder': vaultWrite,
  'storageManager/list': readParallel,
  'storageManager/move': vaultWriteUndo,
  'storageManager/open': readSerial,

  'taskManager/archiveProject': vaultWrite,
  'taskManager/create': vaultWrite,
  'taskManager/createProject': vaultWrite,
  'taskManager/linkNote': vaultWrite,
  'taskManager/list': readParallel,
  'taskManager/listProjects': readParallel,
  'taskManager/move': vaultWrite,
  'taskManager/open': readSerial,
  'taskManager/query': readParallel,
  'taskManager/update': vaultWrite,
  'taskManager/updateProject': vaultWrite,

  'webTools/capture-markdown': vaultWrite,
  'webTools/capture-pdf': vaultWrite,
  'webTools/capture-png': vaultWrite,
  'webTools/links': readSerial,
  'webTools/open': readSerial,
});

export interface UnknownToolPolicyAllowlistEntry {
  owner: string;
  expires: string;
  reason: string;
}

/** Temporary exceptions must name an owner and an ISO expiry date. */
export const UNKNOWN_TOOL_POLICY_ALLOWLIST: Readonly<Record<string, UnknownToolPolicyAllowlistEntry>> = Object.freeze({});

export function getRegisteredToolExecutionPolicy(
  agentName: string,
  toolSlug: string
): Readonly<ToolExecutionPolicy> {
  return TOOL_EXECUTION_POLICY_CATALOG[`${agentName}/${toolSlug}`]
    ?? CONSERVATIVE_TOOL_EXECUTION_POLICY;
}
