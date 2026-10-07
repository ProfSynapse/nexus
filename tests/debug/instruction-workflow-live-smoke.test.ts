/**
 * Live instruction-library/workflow preload smoke. No model/provider calls.
 *
 * Jest's Obsidian mocks cannot prove plugin hydration, IPC serialization,
 * persisted activation after reload, or the actual SettingsView DOM. A live
 * load exposed summary skill refs replaced with '[Circular Reference]' even
 * though the unit/service tests passed. This lane banks that real boundary.
 *
 * Build/deploy the intended bundle before running. Run serially against an
 * explicitly named scratch-capable vault (directory basename, case-sensitive):
 *
 * RUN_INSTRUCTION_WORKFLOW_SMOKE=1 INSTRUCTION_WORKFLOW_SMOKE_VAULT=<name> \
 *   npx jest tests/debug/instruction-workflow-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Optional INSTRUCTION_WORKFLOW_SMOKE_OBSIDIAN chooses the Obsidian CLI binary
 * (e.g. /Applications/Obsidian.app/Contents/MacOS/obsidian-cli).
 * Every eval checks app.vault.getName() BEFORE any writes. All content stays in
 * a unique scratch folder; the native skill has its own uniquely named package
 * under the configured skills root. Cleanup archives only these fixtures.
 * Reloading the plugin and opening its real settings surface are deliberate.
 * An existing CLI current handle is restored after cleanup. If none existed,
 * the archived fixture handle remains current (there is no public null setter);
 * choose a real session explicitly on the next use of that vault.
 * The lane is inert unless explicitly enabled, and fails if vault is omitted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUN_LIVE = process.env.RUN_INSTRUCTION_WORKFLOW_SMOKE === '1';
const VAULT = process.env.INSTRUCTION_WORKFLOW_SMOKE_VAULT;
const OBSIDIAN = process.env.INSTRUCTION_WORKFLOW_SMOKE_OBSIDIAN || 'obsidian';
const PREFIX = `instruction-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SCRATCH = `_instruction-workflow-smoke-${PREFIX}`;
const PROMPT_NAME = `${PREFIX} prompt`;
const SKILL_NAME = `${PREFIX}-skill`;
const WORKSPACE_NAME = `${PREFIX} workspace`;
const SESSION = `${PREFIX}-session`;
const CATEGORY = `${PREFIX} category`;
const WORKFLOW_ID = `${PREFIX}-review`;
const SECOND_WORKFLOW_ID = `${PREFIX}-verify`;
const PROMPT_BODY = `${PREFIX} PROMPT BODY: distinguish claims from evidence.`;
const SKILL_BODY = `${PREFIX} SKILL BODY: inspect the source before drawing conclusions.`;
const STEPS = `${PREFIX} STEPS: review the supplied source and list unresolved questions.`;
const MEMORY = 'Verifying isolated instruction-library and workflow fixtures in the running plugin.';
const GOAL = 'Prove discovery, schema preloading, canonical session inheritance, persistence, and real Instructions UI.';

jest.setTimeout(240_000);

type JsonObject = Record<string, unknown>;
interface LiveSelection { workspaceId: string; workflowId: string; revision: string }
interface LiveState { sessionId?: string; workspaceId?: string; selection: LiveSelection | null; skills: string[] }

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as JsonObject;
}
function payload(value: JsonObject): JsonObject { return value.data ? { ...object(value.data), ...value } : value; }
function parseJson(stdout: string): JsonObject {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`CLI returned no JSON: ${stdout}`);
  return object(JSON.parse(stdout.slice(start)));
}

/** execFile keeps interpolated JS/CLI data out of shell interpretation. */
async function evalInVault<T>(body: string): Promise<T> {
  if (!VAULT?.trim()) throw new Error('INSTRUCTION_WORKFLOW_SMOKE_VAULT is required for live writes.');
  const code = `(() => { if (app.vault.getName() !== ${JSON.stringify(VAULT)}) throw new Error('Wrong vault: ' + app.vault.getName()); return (async () => { const plugin = app.plugins.plugins.nexus; if (!plugin) throw new Error('Nexus is not loaded'); ${body} })().then(value => JSON.stringify(value)); })()`;
  const { stdout } = await execFileAsync(OBSIDIAN, ['eval', `vault=${VAULT}`, `code=${code}`], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
  const resultLine = stdout.split(/\r?\n/).filter(line => line.startsWith('=> ')).pop();
  if (!resultLine) throw new Error(`No eval result: ${stdout}`);
  const parsed: unknown = JSON.parse(resultLine.slice(3));
  return parsed as T;
}

async function nexus(verb: 'tools' | 'use', command: string[], chooseSession = false): Promise<JsonObject> {
  if (!VAULT?.trim()) throw new Error('INSTRUCTION_WORKFLOW_SMOKE_VAULT is required.');
  const args = ['--vault', VAULT, verb, '--memory', MEMORY, '--goal', GOAL,
    ...(chooseSession ? ['--session', SESSION] : []), ...(verb === 'use' ? ['--'] : []), ...command];
  try {
    const { stdout } = await execFileAsync('nexus', args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
    return parseJson(stdout);
  } catch (error) {
    // Expected failed preparation can produce exit 1 while returning valid JSON.
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.includes('{')) return parseJson(error.stdout);
    throw error;
  }
}

/** Expected service rejection is distinct from a disconnected IPC transport. */
async function expectedPreparationFailure(command: string[], workflowId: string): Promise<void> {
  try {
    const result = await nexus('use', command);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(`Workflow "${workflowId}" was not found`);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('stderr' in error) || typeof error.stderr !== 'string') throw error;
    const stderr = error.stderr;
    if (/ENOENT|ECONNREFUSED|socket|timed?\s*out|handshake/i.test(stderr)) throw error;
    expect(stderr).toContain(`Workflow "${workflowId}" was not found`);
  }
}

async function assertCleanDiagnostics(): Promise<void> {
  await evalInVault('return { vault: app.vault.getName() };');
  const errors = await execFileAsync(OBSIDIAN, ['dev:errors', `vault=${VAULT}`], { timeout: 30_000, killSignal: 'SIGKILL' });
  const consoleErrors = await execFileAsync(OBSIDIAN, ['dev:console', 'level=error', `vault=${VAULT}`], { timeout: 30_000, killSignal: 'SIGKILL' });
  // Recognize explicit empty responses; unfamiliar output is a failed assertion.
  const clean = (output: string, consoleOutput = false): boolean => {
    const text = output.trim();
    if (!text || /^\[\s*\]$/.test(text) || /^\{\s*"errors"\s*:\s*\[\s*\]\s*\}$/.test(text)) return true;
    if (/^(?:no|0) errors?(?: (?:found|recorded|captured))?\.?$/i.test(text)) return true;
    return consoleOutput && /^(?:no|0) (?:console )?(?:messages|entries|logs)(?: (?:found|recorded|captured))?\.?$/i.test(text);
  };
  expect({ clean: clean(errors.stdout), output: errors.stdout }).toMatchObject({ clean: true });
  expect({ clean: clean(consoleErrors.stdout, true), output: consoleErrors.stdout }).toMatchObject({ clean: true });
}

let workspaceId: string | undefined;
let promptId: string | undefined;
let skillCreated = false;
let scratchCreated = false;
let previousCliHandle: string | null = null;

async function state(): Promise<LiveState> {
  return evalInVault<LiveState>(`
    const sessions = await plugin.getService('sessionContextManager'); await sessions.ensureBindingsRestored();
    const bound = sessions.resolveHandleWorkspace(${JSON.stringify(SESSION)});
    const handle = sessions.describeHandle(${JSON.stringify(SESSION)}, bound || 'default');
    return { sessionId: handle && handle.id, workspaceId: bound, selection: handle ? sessions.getWorkflowSelection(handle.id) : null, skills: handle ? sessions.getActiveSkills(handle.id) : [] };
  `);
}

async function reload(): Promise<void> {
  await evalInVault('return { vault: app.vault.getName() };');
  await execFileAsync(OBSIDIAN, ['dev:debug', 'on', `vault=${VAULT}`], { timeout: 30_000, killSignal: 'SIGKILL' });
  await execFileAsync(OBSIDIAN, ['dev:console', 'clear', `vault=${VAULT}`], { timeout: 30_000, killSignal: 'SIGKILL' });
  await execFileAsync(OBSIDIAN, ['plugin:reload', 'id=nexus', `vault=${VAULT}`], { timeout: 60_000, killSignal: 'SIGKILL' });
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const ready = await evalInVault<boolean>(`return !!(await plugin.getService('instructionLibraryService')) && !!(await plugin.getService('sessionWorkflowService'));`);
      if (ready && (await nexus('tools', ['memory load-workspace'])).success === true) return;
    } catch (error) { failure = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Plugin services/IPC did not recover after reload: ${String(failure)}`);
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('instruction workflow preload in a verified live vault', () => {
  beforeAll(async () => {
    // Offline manual first; runtime context/transport syntax is authoritative.
    await execFileAsync('nexus', ['--help']);
    previousCliHandle = await evalInVault<string | null>(`const sessions = await plugin.getService('sessionContextManager'); await sessions.ensureBindingsRestored(); return sessions.getCliCurrentSession();`);
    await evalInVault(`if (app.vault.getAbstractFileByPath(${JSON.stringify(SCRATCH)})) throw new Error('Scratch fixture collision'); await app.vault.createFolder(${JSON.stringify(SCRATCH)}); await app.vault.create(${JSON.stringify(`${SCRATCH}/source.md`)}, ${JSON.stringify(`${PREFIX} SOURCE BODY`)}); return true;`);
    scratchCreated = true;
    const createdPrompt = await evalInVault<JsonObject>(`const library = await plugin.getService('instructionLibraryService'); return library.create(${JSON.stringify({ type: 'prompt', name: PROMPT_NAME, description: 'Disposable live preload verification prompt', body: PROMPT_BODY, categories: [CATEGORY] })});`);
    if (createdPrompt.ok === true) promptId = String(object(object(createdPrompt.value).reference).id);
    else if (object(createdPrompt.error).reference) promptId = String(object(object(createdPrompt.error).reference).id);
    expect(createdPrompt.ok).toBe(true);
    const createdSkill = await evalInVault<JsonObject>(`const library = await plugin.getService('instructionLibraryService'); return library.create(${JSON.stringify({ type: 'skill', source: 'nexus', name: SKILL_NAME, description: 'Disposable live preload verification skill', body: SKILL_BODY, categories: [CATEGORY], toolSelectors: ['content read'] })});`);
    skillCreated = createdSkill.ok === true || !!object(createdSkill.error ?? {}).reference;
    expect(createdSkill.ok).toBe(true);
    workspaceId = await evalInVault<string>(`
      const service = await plugin.getService('workspaceService');
      if (await service.getWorkspaceByNameOrId(${JSON.stringify(WORKSPACE_NAME)})) throw new Error('Workspace fixture collision');
      const workspace = await service.createWorkspace(${JSON.stringify({ name: WORKSPACE_NAME, description: 'Disposable instruction workflow smoke workspace', rootFolder: SCRATCH, created: Date.now(), lastAccessed: Date.now(), sessions: {}, context: { purpose: GOAL, workflows: [
        { id: WORKFLOW_ID, name: `${PREFIX} Review`, when: 'Explicit test request', steps: STEPS, promptId, skills: [{ provider: 'nexus', name: SKILL_NAME }], tools: ['storage list'] },
        { id: SECOND_WORKFLOW_ID, name: `${PREFIX} Verify`, when: 'Explicit verification request', steps: `${PREFIX} INACTIVE STEPS`, skills: [{ provider: 'nexus', name: SKILL_NAME }] }
      ] } })}); return workspace.id;
    `);
  });

  afterAll(async () => {
    if (!VAULT || (!workspaceId && !promptId && !skillCreated && !scratchCreated)) return;
    // Call the real archive APIs/tools through verified eval so cleanup remains
    // possible even if the reload test exposed an IPC transport failure.
    await evalInVault(`
      const agents = await plugin.getService('agentManager');
      const library = await plugin.getService('instructionLibraryService');
      const context = { workspaceId: ${JSON.stringify(workspaceId ?? 'default')}, sessionId: ${JSON.stringify(SESSION)}, memory: ${JSON.stringify(MEMORY)}, goal: 'Archive only this smoke run fixtures' };
      const errors = [];
      async function check(label, operation) { try { const result = await operation(); if (result.ok === false || result.success === false) errors.push(label + ': ' + JSON.stringify(result)); } catch (error) { errors.push(label + ': ' + String(error)); } }
      ${workspaceId ? `const sessions = await plugin.getService('sessionContextManager'); await sessions.ensureBindingsRestored(); const handle = sessions.describeHandle(${JSON.stringify(SESSION)}, ${JSON.stringify(workspaceId)}); if (handle) { const activation = await plugin.getService('sessionWorkflowService'); await check('clear selection', () => activation.commit(handle.id, ${JSON.stringify(workspaceId)}, null, activation.begin(handle.id, ${JSON.stringify(workspaceId)}))); } await check('workspace archive', () => agents.getAgent('memoryManager').executeTool('archiveWorkspace', {name: ${JSON.stringify(workspaceId)}, context}));` : ''}
      ${promptId ? `await check('prompt archive', () => library.archive({type: 'prompt', id: ${JSON.stringify(promptId)}}));` : ''}
      ${skillCreated ? `await check('skill archive', () => library.archive({type: 'skill', provider: 'nexus', name: ${JSON.stringify(SKILL_NAME)}}));` : ''}
      ${scratchCreated ? `await check('scratch archive', () => agents.getAgent('storageManager').executeTool('archive', {path: ${JSON.stringify(SCRATCH)}, context}));` : ''}
      ${previousCliHandle ? `const restoredSessions = await plugin.getService('sessionContextManager'); restoredSessions.setCliCurrentSession(${JSON.stringify(previousCliHandle)}); await restoredSessions.flushBindings();` : ''}
      if (errors.length) throw new Error(errors.join('; ')); return true;
    `);
  });

  it('discovers core skills, preloads schemas, preserves failures, inherits the same UUID, survives reload, then clears explicitly', async () => {
    const discovery = await nexus('tools', ['skills, memory load-workspace, content read']);
    expect(discovery.success).toBe(true);
    const discovered = payload(discovery);
    const tools = discovered.tools as Array<{ command: string }>;
    expect(tools.some(tool => tool.command === 'skills load-skill')).toBe(true);
    const entry = (discovered.workspaceDetails as Array<{ id: string; workflows: Array<{ id: string; loadCommand: string; skills: unknown[] }> }>).find(value => value.id === workspaceId);
    const discoveredWorkflow = entry?.workflows.find(value => value.id === WORKFLOW_ID);
    expect(discoveredWorkflow?.skills).toEqual([{ provider: 'nexus', name: SKILL_NAME }]);
    expect(discoveredWorkflow?.loadCommand).toContain(WORKFLOW_ID);
    const loadedResult = await nexus('use', [discoveredWorkflow!.loadCommand], true);
    expect(loadedResult.success).toBe(true);
    expect(JSON.stringify(loadedResult)).not.toContain('[Circular Reference]');
    const loaded = payload(loadedResult);
    expect(object(object(loaded.loadedWorkflow).prompt).instructions).toBe(PROMPT_BODY);
    expect(object(loaded.loadedWorkflow).skills).toEqual(expect.arrayContaining([expect.objectContaining({ reference: { type: 'skill', provider: 'nexus', name: SKILL_NAME }, instructions: SKILL_BODY })]));
    const schemas = loaded.preloadedTools as Array<{ agent: string; tool: string; command: string; usage: string; arguments: unknown[] }>;
    expect(schemas.map(schema => schema.command).sort()).toEqual(['content read', 'storage list']);
    expect(new Set(schemas.map(schema => `${schema.agent}/${schema.tool}`)).size).toBe(schemas.length);
    schemas.forEach(schema => { expect(schema.usage).toBeTruthy(); expect(Array.isArray(schema.arguments)).toBe(true); });
    const summaries = loaded.availableWorkflows as Array<{ skills: unknown[] }>;
    summaries.forEach(summary => expect(summary.skills).toEqual([{ provider: 'nexus', name: SKILL_NAME }]));
    const selected = await state();
    expect(typeof selected.sessionId).toBe('string');
    expect(selected.sessionId?.trim().length).toBeGreaterThan(0);
    expect(selected.workspaceId).toBe(workspaceId);
    expect(selected.selection).toMatchObject({ workspaceId, workflowId: WORKFLOW_ID });
    expect(selected.skills).toContain(`nexus/${SKILL_NAME}`);
    await expectedPreparationFailure(['memory', 'load-workspace', workspaceId!, '--workflow', `${PREFIX}-missing`], `${PREFIX}-missing`);
    expect(await state()).toEqual(selected);
    const read = await nexus('use', ['content', 'read', '--path', `${SCRATCH}/source.md`, '--start-line', '1']);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read)).toContain(`${PREFIX} SOURCE BODY`);
    expect(await state()).toEqual(selected);
    await reload();
    expect(await state()).toEqual(selected);
    const reread = await nexus('use', ['content', 'read', '--path', `${SCRATCH}/source.md`, '--start-line', '1']);
    expect(reread.success).toBe(true);
    expect(await state()).toEqual(selected);
    // A disposed instance's delayed IPC cleanup once killed the new socket
    // after an initially healthy reload. Verify the drain, not just first paint.
    await new Promise(resolve => setTimeout(resolve, 40_000));
    const delayedRead = await nexus('use', ['content', 'read', '--path', `${SCRATCH}/source.md`, '--start-line', '1']);
    expect(delayedRead.success).toBe(true);
    expect(await state()).toEqual(selected);
    const plain = await nexus('use', ['memory', 'load-workspace', workspaceId!]);
    expect(plain.success).toBe(true);
    expect(payload(plain).loadedWorkflow).toBeNull();
    expect(payload(plain).preloadedTools).toEqual([]);
    expect(await state()).toMatchObject({ sessionId: selected.sessionId, workspaceId, selection: null, skills: [] });
    await assertCleanDiagnostics();
  });

  it('renders the actual shared Instructions components, applies type/category/source filters, and omits the removed helper', async () => {
    const ui = await evalInVault<{ connected: boolean; tabs: string[]; all: string[]; prompts: string[]; skills: string[]; sourceSkills: string[]; sections: string[]; helper: boolean; detailBody: string }>(`
      app.setting.open(); app.setting.openTabById('nexus');
      const tab = app.setting.pluginTabs.find(candidate => candidate.id === 'nexus'); if (!tab) throw new Error('Nexus settings tab missing');
      tab.router.setTab('instructions'); await tab.instructionsTab.load();
      const host = () => tab.instructionsTab.container;
      const names = () => [...host().querySelectorAll('.agent-management-card-title')].map(element => element.textContent.trim());
      function choose(label, value) { const row = [...host().querySelectorAll('.nexus-instruction-filters .setting-item')].find(element => element.querySelector('.setting-item-name')?.textContent === label); const select = row?.querySelector('select'); if (!select) throw new Error('Missing filter: ' + label); select.value = value; select.dispatchEvent(new Event('change', {bubbles: true})); }
      choose('Category', ${JSON.stringify(CATEGORY)}); const all = names();
      choose('Type', 'prompt'); const prompts = names();
      choose('Type', 'skill'); const skills = names();
      choose('Type', ''); choose('Source', 'nexus'); const sourceSkills = names();
      const connected = host().isConnected && host().getBoundingClientRect().width > 0;
      const helper = host().textContent.includes('Available means selectable');
      const tabs = [...tab.containerEl.querySelectorAll('.memory-tab.nexus-settings-tab')].map(element => element.textContent.trim());
      tab.router.showDetail(JSON.stringify(['skill', 'nexus', ${JSON.stringify(SKILL_NAME)}]));
      await tab.instructionsTab.openDetail({type: 'skill', provider: 'nexus', name: ${JSON.stringify(SKILL_NAME)}});
      const sections = [...host().querySelectorAll('section.ws-section .ws-section-title')].map(element => element.textContent.trim());
      const detailBody = host().querySelector('textarea[aria-label="Skill instructions"]')?.value;
      tab.router.back(); app.setting.close();
      return { connected, tabs, all, prompts, skills, sourceSkills, sections, helper, detailBody };
    `);
    expect(ui.connected).toBe(true);
    expect(ui.tabs).toContain('Instructions'); expect(ui.tabs).not.toContain('Prompts'); expect(ui.tabs).not.toContain('Skills');
    expect(ui.all.sort()).toEqual([PROMPT_NAME, SKILL_NAME].sort());
    expect(ui.prompts).toEqual([PROMPT_NAME]); expect(ui.skills).toEqual([SKILL_NAME]); expect(ui.sourceSkills).toEqual([SKILL_NAME]);
    expect(ui.helper).toBe(false);
    expect(ui.sections).toEqual(expect.arrayContaining(['Details', 'SKILL.md', 'Required tools', 'Resource files', 'Source and sync']));
    expect(ui.detailBody).toBe(SKILL_BODY);
    await assertCleanDiagnostics();
  });
});
