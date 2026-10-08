/**
 * RUN_REMOTE_AGENTS_APP_LIVE=1 NEXUS_REMOTE_APP_VAULT='<test vault basename>' \
 * npx jest tests/debug/remote-agents-app-live.test.ts --runInBand --no-coverage
 * Optional NEXUS_OBSIDIAN_CLI selects the Obsidian executable.
 *
 * Requires THIS build already installed in a running desktop Obsidian. The test
 * uses real promptManager, job service, JSONL writer and replay applier. It adds
 * one temporary endpoint and synthetic conversations, reloads Nexus, then removes
 * only its fixtures. No vault notes, embeddings or user conversations are edited.
 * A loopback HTTP fixture models Hermes; this is not a live-Hermes conformance test.
 * Jest mocks cannot establish persisted restart/replay delivery in the actual app.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import { CURRENT_SCHEMA_VERSION } from '../../src/database/schema/SchemaMigrator';

const execFileAsync = promisify(execFile);
const describeLive = process.env.RUN_REMOTE_AGENTS_APP_LIVE === '1' ? describe : describe.skip;
const TIMEOUT_MS = 90_000;

interface AppStatus { state: string; value?: Record<string, unknown>; error?: string }
interface FixtureRun { run_id: string; status: string; output?: string; updated_at: number }

describeLive('durable remote jobs in the real Obsidian app', () => {
  test('tool dispatch survives reload, real JSONL replay and cancellation without duplicate delivery', async () => {
    const vault = process.env.NEXUS_REMOTE_APP_VAULT?.trim();
    if (!vault) throw new Error('NEXUS_REMOTE_APP_VAULT is required when RUN_REMOTE_AGENTS_APP_LIVE=1.');
    const cli = process.env.NEXUS_OBSIDIAN_CLI || 'obsidian';
    const token = randomBytes(12).toString('hex');
    const endpointId = `remote-app-fixture-${token}`;
    const slot = `__nexusRemoteAppFixture_${token}`;
    const secret = `fixture-${randomBytes(16).toString('hex')}`;
    const output = `REMOTE-FIXTURE-COMPLETE-${randomBytes(8).toString('hex')}`;
    const runs = new Map<string, FixtureRun>();
    const keys = new Map<string, { payload: string; runId: string }>();
    const submissions: Array<{ key: string; body: Record<string, unknown> }> = [];
    let stopRequests = 0;
    let parentId: string | undefined;
    const branchIds: string[] = [];
    let mutationsAttempted = false;

    function safeError(error: unknown): Error {
      const message = (error instanceof Error ? error.message : String(error)).split(secret).join('[redacted]');
      const safe = new Error(message);
      if (error instanceof Error && error.stack) safe.stack = error.stack.split(secret).join('[redacted]');
      return safe;
    }

    async function evalCode(code: string): Promise<string> {
      try {
        const { stdout } = await execFileAsync(cli, ['eval', `vault=${vault}`, `code=${code}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
        if (!stdout.trim()) throw new Error('Obsidian returned empty eval output; its renderer/CLI route may be unavailable. No success is inferred.');
        return stdout;
      } catch (error) { throw safeError(error); }
    }
    const guard = `if(app.vault.getName()!==${JSON.stringify(vault)})throw Error("Wrong vault: refusing fixture access");`;
    function parseStatus(stdout: string): AppStatus {
      for (const raw of stdout.split(/\r?\n/).reverse()) {
        try {
          const parsed: unknown = JSON.parse(raw.replace(/^\s*=>\s*/, '').trim());
          const value = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
          if (value && typeof value === 'object' && 'state' in value) return value as AppStatus;
        } catch { /* startup/log output */ }
      }
      throw new Error('No synchronous Obsidian fixture status returned.');
    }
    async function appOperation(body: string): Promise<Record<string, unknown>> {
      const marker = `fixture-operation-${randomBytes(6).toString('hex')}`;
      const started = await evalCode(`(()=>{${guard}
        const state=window[${JSON.stringify(slot)}]={state:"running"};
        (async()=>{const plugin=app.plugins.plugins.nexus;if(!plugin)throw Error("Nexus not loaded");${body}})()
          .then(value=>{state.value=value;state.state="passed";}).catch(error=>{state.error=String(error);state.state="failed";});
        return ${JSON.stringify(marker)};
      })()`);
      if (!started.includes(marker)) throw new Error('Obsidian did not acknowledge the fixture operation.');
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = parseStatus(await evalCode(`(()=>{${guard}return JSON.stringify(window[${JSON.stringify(slot)}]||{state:"missing"});})()`));
        if (status.state === 'passed') return status.value ?? {};
        if (status.state !== 'running') throw new Error(`App fixture ${status.state}: ${status.error || 'missing status'}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('App fixture operation exceeded its bounded deadline.');
    }
    async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        const value = await read();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('Durable fixture did not settle before deadline.');
    }
    async function waitForRenderer(): Promise<void> {
      const deadline = Date.now() + 20_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const result = parseStatus(await evalCode(`(()=>{${guard}
            const plugin=app.plugins.plugins.nexus;
            return JSON.stringify({state:"passed",value:{ready:!!plugin?.getServiceIfReady("remoteAgentJobs")}});
          })()`));
          if (result.value?.ready) return;
        } catch (error) { lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Vault renderer/services did not become ready after reload: ${lastError instanceof Error ? lastError.message : "not ready"}`);
    }
    async function readJob(branchId: string): Promise<Record<string, unknown>> {
      return appOperation(`
        const jobs=await plugin.getService("remoteAgentJobs");await jobs.reconcile();
        const storage=await plugin.getService("hybridStorageAdapter");
        const branch=await storage.getConversation(${JSON.stringify(branchId)});
        const job=branch?.metadata?.remoteAgentJob;
        if(!job)throw Error("Synthetic remote job missing");
        const messages=await storage.getMessages(job.parentConversationId,{page:0,pageSize:200});
        return {job,parentMessages:messages.items.filter(message=>message.id===job.parentResultMessageId)};
      `);
    }

    // No fixture server, saved endpoint or conversation exists until this
    // synchronous, read-only vault/renderer check succeeds.
    const preflight = parseStatus(await evalCode(`(()=>{${guard}
      const plugin=app.plugins.plugins.nexus;
      if(!plugin||typeof plugin.getService!=="function")throw Error("Nexus is not loaded in the selected vault");
      return JSON.stringify({state:"passed",value:{vault:app.vault.getName(),loaded:true}});
    })()`));
    expect(preflight.value).toMatchObject({ vault, loaded: true });

    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${secret}`) { send(401, { error: { code: 'unauthorized' } }); return; }
      if (request.method === 'GET' && request.url === '/v1/capabilities') {
        send(200, { object: 'hermes.api_server.capabilities', features: {
          run_submission: true, run_status: true, run_stop: true,
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
        } }); return;
      }
      if (request.method === 'POST' && request.url === '/v1/runs') {
        let text = '';
        for await (const part of request) text += part.toString();
        const body = JSON.parse(text) as Record<string, unknown>;
        const key = String(request.headers['idempotency-key'] || '');
        if (!key) { send(400, { error: { code: 'missing_idempotency_key' } }); return; }
        submissions.push({ key, body });
        const prior = keys.get(key);
        if (prior) {
          if (prior.payload !== text) { send(409, { error: { code: 'idempotency_key_conflict' } }); return; }
          response.setHeader('Idempotency-Replayed', 'true');
          send(202, { run_id: prior.runId, status: runs.get(prior.runId)!.status, replayed: true }); return;
        }
        const runId = `run_${randomBytes(12).toString('hex')}`;
        keys.set(key, { payload: text, runId });
        runs.set(runId, { run_id: runId, status: 'running', updated_at: Date.now() / 1000 });
        send(202, { run_id: runId, status: 'started' }); return;
      }
      const match = request.url?.match(/^\/v1\/runs\/([^/]+)(\/stop)?$/);
      const run = match ? runs.get(decodeURIComponent(match[1])) : undefined;
      if (!run) { send(404, { error: { code: 'run_not_found' } }); return; }
      if (request.method === 'POST' && match?.[2]) {
        stopRequests++;
        if (['completed', 'failed', 'cancelled'].includes(run.status)) { send(200, { object: 'hermes.run', ...run }); return; }
        run.status = 'cancelled'; run.updated_at = Date.now() / 1000;
        send(200, { run_id: run.run_id, status: 'stopping' }); return;
      }
      if (request.method === 'GET' && !match?.[2]) { send(200, { object: 'hermes.run', ...run }); return; }
      send(405, { error: { code: 'method_not_allowed' } });
    });
    server.keepAliveTimeout = 1;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');

    let primaryError: Error | undefined;
    const cleanupErrors: Error[] = [];
    try {
      const schemaProof = await appOperation(`
        const storage=await plugin.getService("hybridStorageAdapter");
        await storage.waitForQueryReady();
        const cache=storage.cache;
        const columns=await cache.query("PRAGMA table_info(messages)");
        const versions=await cache.query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1");
        const fresh=cache.persistenceService.createFreshDatabase(cache.sqlite3,${JSON.stringify(SCHEMA_SQL)});
        try{
          const freshColumns=cache.bridge.collectValues(fresh,"PRAGMA table_info(messages)");
          const freshVersion=cache.bridge.collectValues(fresh,"SELECT version FROM schema_version ORDER BY version DESC LIMIT 1");
          return {installedHasMetadata:columns.some(column=>column.name==="metadataJson"),installedVersion:versions[0]?.version,
            freshHasMetadata:freshColumns.some(column=>column[1]==="metadataJson"),freshVersion:freshVersion[0]?.[0]};
        }finally{fresh.close();}
      `);
      expect(schemaProof).toEqual({installedHasMetadata:true,installedVersion:CURRENT_SCHEMA_VERSION,
        freshHasMetadata:true,freshVersion:CURRENT_SCHEMA_VERSION});
      console.info('Real SQLite schema verified in the installed cache and an isolated fresh in-memory database.');

      // An empty acknowledgement can still mean a command executed. Attempt
      // cleanup conservatively once a data-mutating expression has been sent.
      mutationsAttempted = true;
      const setup = await appOperation(`
        const connection={id:${JSON.stringify(endpointId)},connector:"hermes",displayName:"Remote app fixture",baseUrl:${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)},apiKey:${JSON.stringify(secret)},enabled:true};
        plugin.settings.settings.remoteAgents=[...(plugin.settings.settings.remoteAgents||[]),connection];
        await plugin.settings.saveSettings();
        const registry=await plugin.getService("remoteAgentRegistry");await registry.refresh(connection.id);
        if(!registry.getAvailable().some(item=>item.id===connection.id))throw Error("Fixture did not become available");
        const storage=await plugin.getService("hybridStorageAdapter");
        const parentId=await storage.createConversation({title:${JSON.stringify(`Remote app fixture ${token}`)},vaultName:app.vault.getName(),created:Date.now(),updated:Date.now(),metadata:{remoteFixture:${JSON.stringify(token)}}});
        const originId=await storage.addMessage(parentId,{role:"user",content:"Synthetic remote task",timestamp:Date.now(),state:"complete"});
        const chatView=app.workspace.getLeavesOfType("nexus-chat").map(leaf=>leaf.view).find(view=>view.modelAgentManager);
        let promptAvailability={checked:false};
        if(chatView){
          const Manager=chatView.modelAgentManager.constructor;
          const isolatedManager=new Manager(app,{},undefined,parentId);
          const prompt=await isolatedManager.getCurrentSystemPrompt()||"";
          promptAvailability={checked:true,containsFixture:prompt.includes(connection.id),leaksCredential:prompt.includes(connection.apiKey),leaksUrl:prompt.includes(connection.baseUrl)};
        }
        return {parentId,originId,promptAvailability};
      `);
      parentId = String(setup.parentId);
      const originId = String(setup.originId);
      const promptAvailability = setup.promptAvailability as Record<string, unknown>;
      if (promptAvailability.checked) {
        expect(promptAvailability).toMatchObject({ containsFixture: true, leaksCredential: false, leaksUrl: false });
      }
      console.info(`Live remote prompt availability ${promptAvailability.checked ? 'verified through an isolated ModelAgentManager' : 'not exercised: no ready Nexus chat view'}.`);
      const submit = async (task: string) => appOperation(`
        await plugin.getService("remoteAgentJobs");
        const agents=await plugin.getService("agentManager");
        const prompt=agents.getAgent("promptManager");
        const result=await prompt.getSubagentTool().execute({task:${JSON.stringify(task)},target:${JSON.stringify(endpointId)},taskContext:"explicit fixture context"},
          {conversationId:${JSON.stringify(parentId)},messageId:${JSON.stringify(originId)},source:"internal",isSubagentBranch:false,agentPrompt:"PRIVATE PARENT INSTRUCTIONS MUST NOT LEAK"});
        if(!result.success)throw Error(result.error||"Remote tool dispatch failed");
        return result.data;
      `);
      const started = await submit('Finish the first remote fixture task');
      const branchId = String(started.branchId); branchIds.push(branchId);
      await waitFor(async () => submissions.length, count => count === 1);
      expect(submissions[0].body).toEqual({ input: 'Finish the first remote fixture task\n\nContext:\nexplicit fixture context' });
      expect(submissions[0].key).toBe(String(started.subagentId));
      const before = await waitFor(() => readJob(branchId), value => typeof (value.job as Record<string, unknown>).runId === 'string');
      const runId = String((before.job as Record<string, unknown>).runId);
      const lifecycleSlot = `${slot}_oldJobs`;
      await appOperation(`
        window[${JSON.stringify(lifecycleSlot)}]=await plugin.getService("remoteAgentJobs");
        return {captured:true};
      `);
      await execFileAsync(cli, ['plugin:reload', 'id=nexus', `vault=${vault}`], { timeout: 30_000 });
      await waitForRenderer();
      const shutdown = await appOperation(`
        const previous=window[${JSON.stringify(lifecycleSlot)}];
        const current=await plugin.getService("remoteAgentJobs");
        const result={replaced:previous!==current,stopped:previous?.stopped,timerCleared:previous?.timer===null,aborted:previous?.lifecycleAbort.signal.aborted};
        delete window[${JSON.stringify(lifecycleSlot)}];
        return result;
      `);
      expect(shutdown).toEqual({replaced:true,stopped:true,timerCleared:true,aborted:true});
      const restored = await readJob(branchId);
      expect((restored.job as Record<string, unknown>).runId).toBe(runId);
      expect((restored.job as Record<string, unknown>).idempotencyKey).toBe(submissions[0].key);
      const run = runs.get(runId)!;
      run.status = 'completed'; run.output = output; run.updated_at = Date.now() / 1000;
      const completed = await waitFor(() => readJob(branchId), value => (value.job as Record<string, unknown>).deliveredAt !== undefined);
      expect((completed.job as Record<string, unknown>).state).toBe('completed');
      expect(completed.parentMessages).toEqual([expect.objectContaining({ content: expect.stringContaining(output) })]);
      expect(submissions).toHaveLength(1);

      // Foreground chat writes a complete message snapshot. A remote result can
      // arrive after that snapshot was captured and must survive its later save.
      const remoteResultId = String((completed.job as Record<string, unknown>).parentResultMessageId);
      const staleSnapshot = await appOperation(`
        const conversations=await plugin.getService("conversationService");
        const parent=await conversations.getConversation(${JSON.stringify(parentId)});
        if(!parent)throw Error("Synthetic parent missing before snapshot regression");
        const staleMessages=parent.messages.filter(message=>message.id!==${JSON.stringify(remoteResultId)});
        await conversations.updateConversation(parent.id,{messages:staleMessages});
        const storage=await plugin.getService("hybridStorageAdapter");
        const persisted=await storage.getMessage(${JSON.stringify(remoteResultId)});
        return {present:!!persisted,content:persisted?.content,type:persisted?.metadata?.type};
      `);
      expect(staleSnapshot).toMatchObject({ present: true, content: expect.stringContaining(output), type: 'subagent_result' });

      // Exercise the actual applier against only our synthetic cache rows. JSONL
      // remains untouched, proving these rows can be rebuilt rather than merely reread.
      const replayed = await appOperation(`
        const jobs=await plugin.getService("remoteAgentJobs");await jobs.cleanup();
        const storage=await plugin.getService("hybridStorageAdapter");
        const ids=${JSON.stringify([parentId, branchId])};
        const streams=await Promise.all(ids.map(id=>storage.jsonlWriter.readEvents("conversations/conv_"+id+".jsonl")));
        const events=streams.flat().sort((a,b)=>a.timestamp-b.timestamp);
        if(streams.some(events=>!events.length)||events.some(event=>event.type==="conversation_deleted"))throw Error("Synthetic replay source unavailable");
        try{
          for(const id of ids){await storage.cache.run("DELETE FROM messages WHERE conversationId = ?",[id]);await storage.cache.run("DELETE FROM conversations WHERE id = ?",[id]);}
          storage.queryCache.clear();
          for(const event of events)await storage.syncCoordinator.conversationApplier.apply(event);
          storage.queryCache.clear();
          const branch=await storage.getConversation(${JSON.stringify(branchId)});
          const job=branch?.metadata?.remoteAgentJob;
          const result=await storage.getMessage(job.parentResultMessageId);
          return {eventCount:events.length,state:job.state,runId:job.runId,deliveredAt:job.deliveredAt,resultContent:result?.content,resultMetadata:result?.metadata};
        }finally{await jobs.start();}
      `);
      expect(replayed.eventCount).toBeGreaterThan(0);
      expect(replayed).toMatchObject({ state: 'completed', runId, deliveredAt: expect.any(Number), resultContent: expect.stringContaining(output), resultMetadata: expect.objectContaining({ type: 'subagent_result', remoteJobId: String(started.subagentId) }) });
      expect((await readJob(branchId)).parentMessages).toHaveLength(1);
      expect(submissions).toHaveLength(1);

      const second = await submit('Cancel the second remote fixture task');
      const secondBranch = String(second.branchId); branchIds.push(secondBranch);
      await waitFor(() => readJob(secondBranch), value => typeof (value.job as Record<string, unknown>).runId === 'string');
      await appOperation(`const jobs=await plugin.getService("remoteAgentJobs");if(!await jobs.cancelSubagent(${JSON.stringify(second.subagentId)}))throw Error("Cancellation intent rejected");return {cancelled:true};`);
      const cancelled = await waitFor(() => readJob(secondBranch), value => (value.job as Record<string, unknown>).state === 'cancelled' && (value.job as Record<string, unknown>).deliveredAt !== undefined);
      expect(cancelled.parentMessages).toHaveLength(1);
      expect(stopRequests).toBeGreaterThan(0);
      expect(keys.size).toBe(2);
    } catch (error) {
      primaryError = safeError(error);
    } finally {
      try {
        if (mutationsAttempted) {
          const cleaned = await appOperation(`
          const jobs=await plugin.getService("remoteAgentJobs");await jobs.cleanup();
          try{
            const storage=await plugin.getService("hybridStorageAdapter");
            const collectConversations=async()=>{
              const all=[];
              for(let page=0;;page++){
                const result=await storage.getConversations({includeBranches:true,page,pageSize:200,sortBy:"id",sortOrder:"asc"});
                all.push(...result.items);
                if(!result.hasNextPage)return all;
              }
            };
            const conversations=await collectConversations();
            const ids=conversations.filter(item=>item.metadata?.remoteFixture===${JSON.stringify(token)}||item.metadata?.remoteAgentJob?.targetId===${JSON.stringify(endpointId)}).map(item=>item.id);
            for(const id of ids)await storage.deleteConversation(id);
            plugin.settings.settings.remoteAgents=(plugin.settings.settings.remoteAgents||[]).map(item=>item.id===${JSON.stringify(endpointId)}?{...item,apiKey:""}:item);
            await plugin.settings.saveSettings();
            plugin.settings.settings.remoteAgents=(plugin.settings.settings.remoteAgents||[]).filter(item=>item.id!==${JSON.stringify(endpointId)});
            await plugin.settings.saveSettings();
            const persisted=await plugin.loadData();
            const remainingConversations=(await collectConversations()).filter(item=>item.metadata?.remoteFixture===${JSON.stringify(token)}||item.metadata?.remoteAgentJob?.targetId===${JSON.stringify(endpointId)}).map(item=>item.id);
            const remainingConnections=(plugin.settings.settings.remoteAgents||[]).filter(item=>item.id===${JSON.stringify(endpointId)}).map(item=>item.id);
            const remainingPersistedConnections=(persisted?.remoteAgents||[]).filter(item=>item.id===${JSON.stringify(endpointId)}).map(item=>item.id);
            const remainingKnownIds=[];
            for(const id of ${JSON.stringify([...branchIds, ...(parentId ? [parentId] : [])])})if(await storage.getConversation(id))remainingKnownIds.push(id);
            return {removed:ids.length,remainingConversations,remainingConnections,remainingPersistedConnections,remainingKnownIds};
          }finally{await jobs.start();}
        `);
          expect(cleaned).toMatchObject({ remainingConversations: [], remainingConnections: [], remainingPersistedConnections: [], remainingKnownIds: [] });
          console.info('Remote fixture cleanup verified: no saved connection or synthetic conversations remain.');
        }
      } catch (error) {
        cleanupErrors.push(safeError(error));
      } finally {
        try {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } catch (error) { cleanupErrors.push(safeError(error)); }
      }
    }
    if (primaryError || cleanupErrors.length) {
      const identity = `Fixture endpoint=${endpointId}; token=${token}; parent=${parentId || 'not confirmed'}; branches=${branchIds.join(',') || 'not confirmed'}`;
      const report = [
        ...(primaryError ? [`Primary failure: ${primaryError.message}`] : []),
        ...cleanupErrors.map((error, index) => `Cleanup failure ${index + 1}: ${error.message}`),
        ...(cleanupErrors.length ? ['App cleanup is unconfirmed; inspect the fixture identity before another run.'] : ['App cleanup verified; fixture server stopped.']),
        identity,
      ].join('\n');
      throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], report);
    }
  }, 360_000);
});
