/**
 * Real Nexus getTools roundtrip in the running Obsidian app. Jest's Obsidian
 * mocks cannot prove provider-instance routing, real tool execution, or the
 * runtime continuation loop. This lane invokes the installed plugin, not a mock.
 * It never reloads the plugin, changes settings, or reads/writes vault notes.
 * Requires a configured enabled endpoint/model and a reachable server.
 *
 * RUN_OPENAI_COMPATIBLE_APP_LIVE=1 \
 * NEXUS_COMPAT_APP_VAULT='<vault directory basename>' \
 * NEXUS_COMPAT_APP_ENDPOINT_ID='<configured stable endpoint ID>' \
 * NEXUS_COMPAT_APP_MODEL='<saved model ID>' \
 * npx jest tests/debug/openai-compatible-app-live.test.ts --runInBand --no-coverage
 * Optional NEXUS_OBSIDIAN_CLI selects the binary; otherwise uses obsidian on PATH.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUN_LIVE = process.env.RUN_OPENAI_COMPATIBLE_APP_LIVE === '1';
const describeLive = RUN_LIVE ? describe : describe.skip;
const PROBE_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 210_000;

interface ProbeStatus {
  state: 'running' | 'passed' | 'failed' | 'missing';
  events?: string[];
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  toolSuccess?: boolean;
  error?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when RUN_OPENAI_COMPATIBLE_APP_LIVE=1.`);
  return value;
}

async function evaluate(cli: string, vault: string, code: string): Promise<string> {
  // Arguments are passed directly: no shell interpolation, quoting or substitution.
  const { stdout } = await execFileAsync(cli, ['eval', `vault=${vault}`, `code=${code}`], {
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function parseStatus(stdout: string): ProbeStatus {
  for (const raw of stdout.split(/\r?\n/).reverse()) {
    const line = raw.replace(/^\s*=>\s*/, '').trim();
    try {
      const parsed: unknown = JSON.parse(line);
      const value: unknown = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      if (value && typeof value === 'object' && 'state' in value) return value as ProbeStatus;
    } catch { /* CLI startup/log lines are not the synchronous eval result. */ }
  }
  throw new Error('Obsidian did not return the probe status. Check CLI targeting and eval errors.');
}

function startExpression(vault: string, endpointId: string, model: string, slot: string, marker: string): string {
  const input = JSON.stringify({ vault, endpointId, model, slot, marker, timeoutMs: PROBE_TIMEOUT_MS });
  return `(()=>{
    const input=${input};
    if(app.vault.getName()!==input.vault)throw Error("Wrong vault: refusing to run probe");
    const plugin=app.plugins.plugins.nexus;
    if(!plugin)throw Error("Nexus is not loaded in the selected vault");
    const config=plugin.settings.settings.llmProviders.providers[input.endpointId];
    if(!config||config.driverKind!=="openai-compatible"||!config.enabled)throw Error("Enabled OpenAI-compatible endpoint not found");
    if(!Object.prototype.hasOwnProperty.call(config.openaiCompatible?.models||{},input.model)
      ||config.models?.[input.model]?.enabled===false)throw Error("Enabled saved model not found on selected endpoint");
    const state=window[input.slot]={state:"running",events:[],text:"",calls:[]};
    plugin.getService("llmService").then(async live=>{
      const probe=new live.constructor({providers:{[input.endpointId]:config},defaultModel:{provider:input.endpointId,model:input.model}},app.vault);
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),input.timeoutMs);
      let completed=false;
      try{
        await probe.waitForInit();
        const executor=await plugin.getService("directToolExecutor");
        const tools=(await executor.getAvailableTools()).filter(tool=>tool.function?.name==="getTools");
        if(tools.length!==1)throw Error("Missing real getTools schema");
        probe.setToolExecutor({executeToolCalls:async(calls,context,onEvent)=>{
          if(controller.signal.aborted)throw Error("Probe aborted");
          if(calls.some(call=>call.function.name!=="getTools"))throw Error("Only getTools discovery is allowed in this probe");
          state.calls.push(...calls.map(call=>({name:call.function.name,args:JSON.parse(call.function.arguments)})));
          const results=await executor.executeToolCalls(calls,context,onEvent);
          state.toolSuccess=state.toolSuccess!==false&&results.every(result=>result.success);
          return results;
        }});
        for await(const event of probe.generateResponseStream([
          {role:"user",content:"Call getTools with tool content read, memory Testing the generic endpoint, goal Discover the read command. Then tell me the required flags from the result. Do not read or modify any notes."}
        ],{provider:input.endpointId,model:input.model,tools,abortSignal:controller.signal,temperature:0.1})){
          state.events.push(event.type);
          if(event.type==="assistant.delta")state.text+=event.text;
          if(event.type==="turn.failed")state.error=String(event.error);
          if(event.type==="turn.aborted")state.error="Probe aborted";
        }
        completed=state.calls.length&&state.toolSuccess&&state.events.includes("turn.completed")&&!state.error;
      }finally{clearTimeout(timer);await probe.cleanup();}
      state.state=completed?"passed":"failed";
    }).catch(error=>{state.state="failed";state.error=String(error)});
    return input.marker;
  })()`;
}

describeLive('OpenAI-compatible roundtrip in the real Obsidian app', () => {
  test('selected endpoint completes getTools discovery and consumes its real result', async () => {
    const vault = required('NEXUS_COMPAT_APP_VAULT');
    const endpointId = required('NEXUS_COMPAT_APP_ENDPOINT_ID');
    const model = required('NEXUS_COMPAT_APP_MODEL');
    const cli = process.env.NEXUS_OBSIDIAN_CLI || 'obsidian';
    const runId = randomBytes(8).toString('hex');
    const slot = `__nexusCompatibleAppProbe_${runId}`;
    const marker = `Nexus compatible probe started ${runId}`;
    let started = false;
    try {
      const stdout = await evaluate(cli, vault, startExpression(vault, endpointId, model, slot, marker));
      expect(stdout).toContain(marker);
      started = true;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let status: ProbeStatus = { state: 'running' };
      while (status.state === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        status = parseStatus(await evaluate(cli, vault, `(()=>{
          if(app.vault.getName()!==${JSON.stringify(vault)})throw Error("Wrong vault during probe polling");
          return JSON.stringify(window[${JSON.stringify(slot)}]||{state:"missing"});
        })()`));
      }
      if (status.state !== 'passed') throw new Error(`In-app probe ${status.state}: ${status.error || 'no terminal success before deadline'}`);
      expect(status.calls?.length).toBeGreaterThan(0);
      expect(status.calls?.every(call => call.name === 'getTools')).toBe(true);
      expect(status.toolSuccess).toBe(true);
      expect(status.events).toContain('turn.completed');
      expect(status.events).not.toContain('turn.failed');
      expect(status.text?.trim().length).toBeGreaterThan(0);
      expect(status.text).toMatch(/start(?:-|_|\s)?line/i);
      expect(status.error).toBeUndefined();
    } finally {
      if (started) await evaluate(cli, vault, `(()=>{
        if(app.vault.getName()!==${JSON.stringify(vault)})throw Error("Wrong vault during probe cleanup");
        const key=${JSON.stringify(slot)};
        if(window[key]?.state!=="running")delete window[key];
        return "Probe status cleanup complete";
      })()`);
    }
  }, 240_000);
});
