"""Opt-in actual Nexus -> OpenClaw verification. Never downloads/configures models.

Required: RUN_NEXUS_OPENCLAW_LIVE=1, NEXUS_OPENCLAW_TEST_VAULT,
NEXUS_OPENCLAW_BASE_URL, NEXUS_OPENCLAW_CONFIG_FILE, NEXUS_OPENCLAW_CLI.
Set NEXUS_OPENCLAW_OWN_GATEWAY=1 only to launch and restart an isolated foreground
gateway on an unused loopback port. A preexisting gateway is never stopped.
See docs/plans/openclaw-live-verification.md. No credentials are printed.
"""
from pathlib import Path
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlparse


class Verification:
    def __init__(self):
        self.vault = os.environ['NEXUS_OPENCLAW_TEST_VAULT']
        self.base_url = os.environ['NEXUS_OPENCLAW_BASE_URL'].rstrip('/')
        self.config_path = Path(os.environ['NEXUS_OPENCLAW_CONFIG_FILE']).resolve()
        self.cli_path = Path(os.environ['NEXUS_OPENCLAW_CLI']).resolve()
        if not self.cli_path.is_file():
            raise RuntimeError('The explicitly selected OpenClaw CLI file is missing')
        if self.config_path.stat().st_mode & 0o077:
            raise RuntimeError('The OpenClaw config must be a private file (mode 0600)')
        config = json.loads(self.config_path.read_text())
        if set(config.get('tools', {}).get('allow', [])) != {'session_status'}:
            raise RuntimeError('Live test requires tools.allow to contain only session_status')
        def reject_extra_tools(value):
            if isinstance(value, dict):
                if value.get('alsoAllow'):
                    raise RuntimeError('Live test refuses additional tool allowlists')
                for child in value.values():
                    reject_extra_tools(child)
            elif isinstance(value, list):
                for child in value:
                    reject_extra_tools(child)
        reject_extra_tools(config)
        self.key = config.get('gateway', {}).get('auth', {}).get('token')
        if not isinstance(self.key, str) or not self.key.strip():
            raise RuntimeError('The private config needs a direct gateway.auth.token')
        self.key = self.key.strip()
        self.token = secrets.token_hex(8)
        self.target = 'openclaw-live-' + self.token
        self.name = 'OpenClaw local live test'
        self.marker = 'NEXUS-OPENCLAW-' + self.token
        self.guard = f'if(app.vault.getName()!=={js(self.vault)})throw Error("Wrong vault");'
        self.proof_path = Path(os.environ.get('NEXUS_OPENCLAW_PROOF_PATH', '/tmp/nexus-openclaw-live-proof.json'))
        self.workspace = Path(config.get('agents', {}).get('defaults', {}).get('workspace', '')).resolve()
        if not config.get('agents', {}).get('defaults', {}).get('workspace') or not self.workspace.is_dir():
            raise RuntimeError('Configure an existing isolated agent workspace before this test')
        self.env = {name: os.environ[name] for name in ('PATH', 'LANG', 'TMPDIR') if name in os.environ}
        self.env.update(OPENCLAW_CONFIG_PATH=str(self.config_path),
                        OPENCLAW_HOME=str(self.config_path.parent),
                        OPENCLAW_STATE_DIR=str(self.config_path.parent),
                        OPENCLAW_GATEWAY_TOKEN=self.key,
                        OPENCLAW_GATEWAY_URL=self.base_url)
        self.own_gateway = os.environ.get('NEXUS_OPENCLAW_OWN_GATEWAY') == '1'
        self.approve_device = os.environ.get('NEXUS_OPENCLAW_APPROVE_TEST_DEVICE') == '1'
        if self.approve_device and not self.own_gateway:
            raise RuntimeError('Automatic test-device approval requires an owned isolated gateway')
        if self.own_gateway:
            temporary_roots = {Path(tempfile.gettempdir()).resolve(), Path('/tmp').resolve()}
            if (not any(self.config_path.is_relative_to(root) for root in temporary_roots)
                    or not any(self.workspace.is_relative_to(root) for root in temporary_roots)):
                raise RuntimeError('Owned gateway requires config and workspace in an isolated temporary directory')
        self.device_id = None
        self.gateway = None
        self.mutated = False
        self.fixtures = []
        self.errors = []

    def safe(self, value):
        return str(value).replace(self.key, '[redacted]')

    def command(self, argv, timeout=30, env=None):
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env,
                                    cwd=self.workspace if env is self.env else None)
        except subprocess.TimeoutExpired:
            # TimeoutExpired includes argv, which can contain a private eval literal.
            raise RuntimeError('CLI acknowledgement timed out') from None
        if result.returncode:
            raise RuntimeError(self.safe(result.stderr or result.stdout))
        return result.stdout

    def obsidian(self, command, *args):
        return self.command(['obsidian', command, 'vault=' + self.vault, *args])

    def evaluate(self, code):
        output = self.obsidian('eval', 'code=(()=>{' + self.guard + code + '})()')
        for line in reversed(output.splitlines()):
            if line.startswith('=> '):
                value = line[3:]
                try:
                    return json.loads(value)
                except ValueError:
                    return value
        raise RuntimeError('No synchronous eval acknowledgement')

    def operation(self, body, timeout=90):
        """Invoke once; missing acknowledgement permits ONLY reading its unique marker."""
        slot = '__nexusOpenClawLive_' + self.token + '_' + secrets.token_hex(5)
        code = f'''
          const state=window[{js(slot)}]={{state:"running"}};
          (async()=>{{const plugin=app.plugins.plugins.nexus; {body}
          }})().then(value=>{{state.value=value;state.state="passed";}})
            .catch(error=>{{state.error=String(error);state.state="failed";}});
          return "started";
        '''
        try:
            self.evaluate(code)
        except RuntimeError:
            pass
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                state = self.evaluate(f'return JSON.stringify(window[{js(slot)}]||{{state:"missing"}});')
            except RuntimeError:
                time.sleep(.5)
                continue
            if state['state'] == 'passed':
                return state.get('value')
            if state['state'] == 'failed':
                raise RuntimeError(self.safe(state['error']))
            time.sleep(.5)
        raise RuntimeError('App operation did not settle; mutation was not retried')

    def ready(self):
        self.wait_ready()

    def wait_ready(self, replaced_slot=None):
        started = time.monotonic()
        deadline = started + 300
        last_status = None
        last_report = started - 15
        while time.monotonic() < deadline:
            try:
                state = self.evaluate(f'''
                  const plugin=app.plugins.plugins.nexus;
                  const jobs=plugin?.getServiceIfReady("remoteAgentJobs");
                  const storage=plugin?.getServiceIfReady("hybridStorageAdapter");
                  return JSON.stringify({{jobsReady:!!jobs,
                    replacementReady:!!jobs&&({js(replaced_slot is None)}||jobs!==window[{js(replaced_slot)}]),
                    storageReady:!!storage?.isQueryReady()}});
                ''')
                if state['jobsReady'] and state['replacementReady'] and state['storageReady']:
                    print(f'{time.strftime("%H:%M:%S")} Ready after {time.monotonic() - started:.1f}s: jobs and storage queries', flush=True)
                    return
            except RuntimeError:
                state = {'status': 'waiting for app acknowledgement'}
            now = time.monotonic()
            if state != last_status or now - last_report >= 15:
                print(f'{time.strftime("%H:%M:%S")} Readiness +{now - started:.1f}s: storage hydration / service startup {json.dumps(state)}', flush=True)
                last_status, last_report = state, now
            time.sleep(.5)
        raise RuntimeError('Nexus jobs and storage queries did not become ready within 300 seconds')

    def reload(self):
        slot = '__nexusOpenClawReload_' + self.token + '_' + secrets.token_hex(4)
        self.operation(f'window[{js(slot)}]=plugin.getServiceIfReady("remoteAgentJobs");return true;')
        # Reload is issued once, then only readiness is polled if its ack is lost.
        try:
            self.obsidian('plugin:reload', 'id=nexus')
        except RuntimeError:
            pass
        self.wait_ready(replaced_slot=slot)

    def rpc(self, method, params):
        # Env URL + token avoid secret command-line arguments. --expect-url binds
        # every read to the explicit destination, even if CLI defaults differ.
        output = self.command([
            'node', str(self.cli_path), 'gateway', 'call', method,
            '--params', json.dumps(params), '--expect-url', self.base_url,
            '--timeout', '20000', '--json',
        ], timeout=30, env=self.env)
        return self.parse_cli_json(output)

    @staticmethod
    def parse_cli_json(output):
        decoder = json.JSONDecoder()
        for index, char in enumerate(output):
            if char == '{':
                try:
                    value, end = decoder.raw_decode(output[index:])
                    if not output[index + end:].strip():
                        return value
                except ValueError:
                    pass
        raise RuntimeError('OpenClaw CLI returned no JSON result')

    def devices(self, *args):
        output = self.command(['node', str(self.cli_path), 'devices', *args, '--json'],
                              env=self.env)
        return self.parse_cli_json(output)

    def approve_exact_device(self):
        identity_key = self.target + ':' + self.base_url
        device_id = self.operation(f'''
          return await new Promise((resolve,reject)=>{{
            const request=indexedDB.open("nexus-openclaw-devices",1);
            request.onupgradeneeded=()=>request.transaction.abort();
            request.onerror=()=>reject(Error("Nexus test device identity not available"));
            request.onsuccess=()=>{{
              const db=request.result;
              const tx=db.transaction("identities","readonly");
              const read=tx.objectStore("identities").get({js(identity_key)});
              let id;
              read.onsuccess=()=>{{id=read.result?.id;}};
              tx.oncomplete=()=>{{db.close();resolve(typeof id==="string"?id:null);}};
              tx.onerror=()=>{{db.close();reject(Error("Cannot read test device ID"));}};
            }};
          }});
        ''')
        if not device_id:
            return False
        self.device_id = device_id
        before = self.devices('list')
        matches = [item for item in before.get('pending', []) if item.get('deviceId') == device_id]
        if not matches:
            return False
        if len(matches) != 1:
            raise RuntimeError('Ambiguous pairing requests for the exact Nexus test device')
        request = matches[0]
        roles = set(request.get('roles') or [request.get('role')])
        scopes = set(request.get('scopes', []))
        if roles != {'operator'} or scopes != {'operator.read', 'operator.write'}:
            raise RuntimeError('Test device requested unexpected role or scopes; approval refused')
        if any(item.get('deviceId') == device_id for item in before.get('paired', [])):
            raise RuntimeError('Expected a new test device, not an existing approval or scope upgrade')
        request_id = request.get('requestId')
        if not isinstance(request_id, str) or not request_id:
            raise RuntimeError('Exact pairing request ID is missing')
        approved = None
        try:
            approved = self.devices('approve', request_id)
        except RuntimeError:
            # Approval is not repeated after a lost acknowledgement.
            pass
        if approved and approved.get('requestId') != request_id:
            raise RuntimeError('Pairing approval acknowledged a different request')
        after = self.devices('list')
        paired = [item for item in after.get('paired', []) if item.get('deviceId') == device_id]
        if (len(paired) != 1 or set(paired[0].get('scopes', [])) != scopes
                or set(paired[0].get('roles') or [paired[0].get('role')]) != {'operator'}):
            raise RuntimeError('Exact read/write device approval was not confirmed')
        if any(item.get('requestId') == request_id for item in after.get('pending', [])):
            raise RuntimeError('Approved test request is still pending')
        return True

    def start_gateway(self):
        if not self.own_gateway:
            return
        address = urlparse(self.base_url)
        if address.scheme != 'ws' or address.hostname not in ('127.0.0.1', 'localhost') or address.path not in ('', '/'):
            raise RuntimeError('Owned gateway requires a direct loopback ws:// address')
        if not address.port:
            raise RuntimeError('Owned gateway requires an explicit unused port')
        with socket.socket() as probe:
            probe.settimeout(.5)
            if probe.connect_ex((address.hostname, address.port)) == 0:
                raise RuntimeError('Gateway port already occupied; refusing to stop or replace its owner')
        self.gateway = subprocess.Popen([
            'node', str(self.cli_path), 'gateway', 'run', '--bind', 'loopback',
            '--port', str(address.port),
        ], env=self.env, cwd=self.workspace, stdin=subprocess.DEVNULL,
           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.gateway.poll() is not None:
                raise RuntimeError('Owned foreground gateway exited during startup')
            try:
                self.rpc('health', {})
                return
            except RuntimeError:
                time.sleep(1)
        raise RuntimeError('Owned gateway did not become ready')

    def stop_gateway(self):
        if self.gateway is None:
            return
        process, self.gateway = self.gateway, None
        if process.poll() is None:
            process.terminate()  # Exact Popen child only; never gateway stop/restart.
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    def setup(self):
        self.mutated = True
        self.operation(f'''
          const connection={{id:{js(self.target)},connector:"openclaw",
            displayName:{js(self.name)},baseUrl:{js(self.base_url)},apiKey:{js(self.key)},enabled:true}};
          plugin.settings.settings.remoteAgents=[...(plugin.settings.settings.remoteAgents||[]),connection];
          await plugin.settings.saveSettings();
          const registry=await plugin.getService("remoteAgentRegistry");
          await registry.refresh(connection.id);
          return true;
        ''')
        deadline = time.monotonic() + 120
        approved = False
        while time.monotonic() < deadline:
            result = self.operation(f'''
              const registry=await plugin.getService("remoteAgentRegistry");
              await registry.refresh({js(self.target)});
              return {{ready:registry.getAvailable().some(item=>item.id==={js(self.target)}),
                recoveryMode:registry.getHealth({js(self.target)})?.recoveryMode}};
            ''')
            if result['ready']:
                return {**result, 'testDeviceApproved': approved}
            if self.approve_device and not approved:
                approved = self.approve_exact_device()
            time.sleep(2)
        raise RuntimeError('OpenClaw unavailable after bounded pairing/probe wait')

    def submit(self, label, task, pause=False):
        result = self.operation(f'''
          const storage=await plugin.getService("hybridStorageAdapter");
          const parent=await storage.createConversation({{title:{js(self.marker + '-' + label)},
            vaultName:app.vault.getName(),created:Date.now(),updated:Date.now(),
            metadata:{{openclawLiveFixture:{js(self.token)}}}}});
          const origin=await storage.addMessage(parent,{{role:"user",content:{js('Synthetic ' + label + ' task')},
            timestamp:Date.now(),state:"complete"}});
          const agents=await plugin.getService("agentManager");
          const result=await agents.getAgent("promptManager").getSubagentTool().execute(
            {{target:{js(self.target)},task:{js(task)}}},
            {{conversationId:parent,messageId:origin,source:"internal",isSubagentBranch:false}});
          if(!result.success)throw Error(result.error);
          const jobs=await plugin.getService("remoteAgentJobs");
          if({js(pause)}){{
            const deadline=Date.now()+60000;
            let submitted=false;
            while(Date.now()<deadline){{
              const branch=await storage.getConversation(result.data.branchId);
              const job=branch?.metadata?.remoteAgentJob;
              if(job?.runId){{submitted=true;break;}}
              if(job?.state==="failed"||job?.state==="attention")throw Error("Recovery fixture submission failed");
              await new Promise(resolve=>window.setTimeout(resolve,100));
            }}
            await jobs.cleanup();
            if(!submitted)throw Error("Recovery fixture native identity was not persisted");
          }}
          return {{parent,origin,...result.data}};
        ''')
        self.fixtures.append(result)
        return result

    def job(self, fixture, reconcile=True):
        return self.operation(f'''
          const jobs=await plugin.getService("remoteAgentJobs");
          if({js(reconcile)})await jobs.reconcile();
          const storage=await plugin.getService("hybridStorageAdapter");
          const branch=await storage.getConversation({js(fixture['branchId'])});
          const job=branch?.metadata?.remoteAgentJob;
          if(job?.targetId!=={js(self.target)})throw Error("Not an owned fixture job");
          const messages=await storage.getMessages(job.parentConversationId,{{page:0,pageSize:200}});
          return {{job,replies:messages.items.filter(message=>message.id===job.parentResultMessageId||message.metadata?.remoteJobId===job.jobId)}};
        ''')

    def wait_job(self, fixture, predicate, timeout=300, reconcile=True):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.job(fixture, reconcile)
            if predicate(result):
                return result
            job = result['job']
            unconfirmed = job.get('runId') and (job.get('remoteStatus') == 'unconfirmed'
                or job.get('error', '').startswith('No final reply is available for this run.'))
            if job['state'] == 'failed' or (job['state'] == 'attention' and not unconfirmed):
                raise RuntimeError('Remote job became ' + job['state'] + ': ' + self.safe(job.get('error', '')))
            time.sleep(2)
        raise RuntimeError('Remote job did not reach the required state')

    def history(self, job):
        session = job.get('remoteSessionId') or job['request'].get('sessionId')
        if not session:
            raise RuntimeError('Persisted OpenClaw session key is missing')
        return self.rpc('sessions.get', {'key': session, 'limit': 200})['messages']

    @staticmethod
    def final_message(messages, run_id):
        found = []
        for row in messages:
            message = row.get('message', row)
            identity = message.get('__openclaw', row.get('__openclaw', {}))
            if (message.get('role') == 'assistant' and identity.get('runId') == run_id
                    and message.get('stopReason') in ('stop', 'end_turn')):
                found.append(message)
        if len(found) != 1:
            return None
        content = found[0].get('content', [])
        return content if isinstance(content, str) else '\n'.join(part['text'] for part in content if part.get('type') == 'text')

    def wait_history(self, job):
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            messages = self.history(job)
            output = self.final_message(messages, job['runId'])
            if output:
                return messages, output
            time.sleep(2)
        raise RuntimeError('No matching final OpenClaw history reply')

    def prove_reply(self, result):
        job = result['job']
        messages, output = self.wait_history(job)
        expected = f'[Remote agent "{self.name}" completed]\n\n' + output
        assert job['state'] == 'completed', 'Nexus job did not complete'
        assert len(result['replies']) == 1, 'Expected exactly one Nexus reply'
        assert result['replies'][0]['content'] == expected, 'Nexus reply differs from actual OpenClaw final'
        assert result['replies'][0]['metadata']['runId'] == job['runId'], 'Reply run identity mismatch'
        inputs = [row for row in messages if row.get('message', row).get('role') == 'user']
        assert len(inputs) == 1, 'OpenClaw session has duplicate task inputs'
        tool_rows = [row for row in messages if row.get('customType') == 'openclaw.nested-tool.v1'
                     and row.get('details', {}).get('runId') == job['runId']
                     and row.get('details', {}).get('toolName') == 'session_status'
                     and row.get('details', {}).get('isError') is False]
        assert tool_rows, 'No successful actual nested session_status result'
        return {'jobId': job['jobId'], 'runId': job['runId'], 'sessionId': job.get('remoteSessionId'),
                'replyCount': 1, 'inputCount': 1, 'sessionStatusResults': len(tool_rows), 'exactFinalMatch': True}

    def replay_fixture(self, fixture, expected):
        return self.operation(f'''
          const jobs=await plugin.getService("remoteAgentJobs");await jobs.cleanup();
          const storage=await plugin.getService("hybridStorageAdapter");
          const ids={js([fixture['parent'], fixture['branchId']])};
          for(const id of ids){{
            const row=await storage.getConversation(id);
            if(row?.metadata?.openclawLiveFixture!=={js(self.token)}&&row?.metadata?.remoteAgentJob?.targetId!=={js(self.target)})
              throw Error("Replay refused for non-fixture row");
          }}
          const streams=await Promise.all(ids.map(id=>storage.jsonlWriter.readEvents("conversations/conv_"+id+".jsonl")));
          const events=streams.flat().sort((a,b)=>a.timestamp-b.timestamp);
          if(streams.some(items=>!items.length)||events.some(event=>event.type==="conversation_deleted"))throw Error("Fixture replay source unavailable");
          try{{
            for(const id of ids){{
              await storage.cache.run("DELETE FROM messages WHERE conversationId = ?",[id]);
              await storage.cache.run("DELETE FROM conversations WHERE id = ?",[id]);
            }}
            storage.queryCache.clear();
            for(const event of events)await storage.syncCoordinator.conversationApplier.apply(event);
            storage.queryCache.clear();
            const branch=await storage.getConversation({js(fixture['branchId'])});
            const job=branch?.metadata?.remoteAgentJob;
            const reply=await storage.getMessage(job.parentResultMessageId);
            if(job.runId!=={js(expected['runId'])}||job.remoteSessionId!=={js(expected['sessionId'])})throw Error("Replay lost native identity");
            if(job.state!=="completed"||!job.deliveredAt||!reply)throw Error("Replay lost delivery");
            return {{eventCount:events.length,nativeIdentityPreserved:true,delivered:true}};
          }}finally{{await jobs.start();}}
        ''')

    def cleanup(self):
        if not self.mutated:
            return
        self.ready()
        # Mark/cancel only jobs with our unique endpoint. Never cancel unrelated work.
        try:
            self.operation(f'''
              const jobs=await plugin.getService("remoteAgentJobs");await jobs.start();
              for(const item of jobs.getActiveSubagents())if(item.remoteTargetId==={js(self.target)}){{
                try{{await jobs.cancelSubagent(item.subagentId);}}catch{{}}
              }}
              await jobs.reconcile();return true;
            ''')
        except Exception as error:
            self.errors.append('Best-effort remote stop unconfirmed: ' + self.safe(error))
        result = self.operation(f'''
          const jobs=await plugin.getService("remoteAgentJobs");await jobs.cleanup();
          try{{
            const storage=await plugin.getService("hybridStorageAdapter");
            const collect=async()=>{{const owned=[];for(let page=0;;page++){{
              const result=await storage.getConversations({{includeBranches:true,page,pageSize:200,sortBy:"id",sortOrder:"asc"}});
              owned.push(...result.items.filter(row=>row.metadata?.openclawLiveFixture==={js(self.token)}||row.metadata?.remoteAgentJob?.targetId==={js(self.target)}));
              if(!result.hasNextPage)return owned;
            }}}};
            const owned=await collect();
            for(const row of owned)await storage.deleteConversation(row.id);
            plugin.settings.settings.remoteAgents=(plugin.settings.settings.remoteAgents||[]).map(item=>item.id==={js(self.target)}?{{...item,apiKey:""}}:item);
            await plugin.settings.saveSettings();
            plugin.settings.settings.remoteAgents=plugin.settings.settings.remoteAgents.filter(item=>item.id!=={js(self.target)});
            await plugin.settings.saveSettings();
            const saved=await plugin.loadData();
            if(saved.remoteAgents?.some(item=>item.id==={js(self.target)})||(await collect()).length)throw Error("Fixture cleanup incomplete");
            if(app.secretStorage?.getSecret({js('nexus-remote-agent-' + self.target + '-apikey')}))throw Error("Fixture key remains");
            return {{removedConversations:owned.length,connectionRemoved:true,keyRemoved:true}};
          }}finally{{await jobs.start();}}
        ''')
        print('Cleanup verified:', json.dumps(result), flush=True)
        identity_key = self.target + ':' + self.base_url
        self.operation(f'''
          return await new Promise((resolve,reject)=>{{
            const request=indexedDB.open("nexus-openclaw-devices",1);
            let missing=false;
            request.onupgradeneeded=()=>{{missing=true;request.transaction.abort();}};
            request.onerror=()=>missing?resolve({{identityAbsent:true}}):reject(Error("Cannot verify fixture identity cleanup"));
            request.onsuccess=()=>{{
              const db=request.result;
              const tx=db.transaction("identities","readwrite");
              const store=tx.objectStore("identities");
              store.delete({js(identity_key)});
              const check=store.get({js(identity_key)});
              let absent=false;
              check.onsuccess=()=>{{absent=check.result===undefined;}};
              tx.oncomplete=()=>{{db.close();absent?resolve({{identityRemoved:true}}):reject(Error("Fixture identity remains"));}};
              tx.onerror=()=>{{db.close();reject(Error("Fixture identity cleanup failed"));}};
            }};
          }});
        ''')
        if self.own_gateway and self.approve_device and self.device_id:
            try:
                self.devices('remove', self.device_id)
            except RuntimeError:
                pass  # Never repeat a removal after a lost acknowledgement.
            remaining = self.devices('list')
            if any(item.get('deviceId') == self.device_id for item in remaining.get('paired', [])):
                raise RuntimeError('Exact test-device pairing removal was not confirmed')

    def run(self):
        proof = {'status': 'pending', 'gatewayRestart': {'status': 'pending' if self.own_gateway else 'not requested'}}
        phase = 'gateway startup and Nexus readiness'
        started = phase_started = time.monotonic()
        phase_log = []
        proof['phases'] = phase_log

        def progress(value):
            nonlocal phase, phase_started
            now = time.monotonic()
            if phase_log:
                phase_log[-1]['durationSeconds'] = round(now - phase_started, 1)
            phase = value
            phase_started = now
            stamp = time.strftime('%Y-%m-%dT%H:%M:%S%z')
            phase_log.append({'phase': phase, 'startedAt': stamp, 'elapsedSeconds': round(now - started, 1)})
            print(f'{stamp} +{now - started:.1f}s Phase: {phase}', flush=True)

        try:
            progress('gateway startup and Nexus readiness')
            self.start_gateway()
            self.ready()
            progress('connection probe and optional exact-device pairing')
            proof['probe'] = self.setup()
            task = 'Call session_status once. After the tool succeeds, reply with exactly ' + self.marker + '. Do not change files or contact anyone.'
            progress('submit first synthetic task')
            first = self.submit('reload', task)
            before = self.wait_job(first, lambda value: bool(value['job'].get('runId')))
            identity = (before['job']['runId'], before['job'].get('remoteSessionId'))
            assert all(identity), 'Native run/session identity was not persisted'
            progress('reload Nexus and verify the same native run')
            self.reload()
            completed = self.wait_job(first, lambda value: bool(value['job'].get('deliveredAt')))
            assert (completed['job']['runId'], completed['job'].get('remoteSessionId')) == identity
            proof['pluginReload'] = self.prove_reply(completed)
            progress('replay tagged fixture cache rows from JSONL')
            proof['fixtureJsonlReplay'] = self.replay_fixture(first, proof['pluginReload'])
            assert len(self.job(first)['replies']) == 1

            if self.own_gateway:
                progress('submit history-recovery task and pause Nexus polling')
                proof['gatewayRestart']['status'] = 'running'
                second = self.submit('gateway-recovery', task, pause=True)
                paused = self.wait_job(second, lambda value: bool(value['job'].get('runId')), reconcile=False)
                assert not paused['job'].get('deliveredAt'), 'Recovery fixture was already delivered before pause'
                self.wait_history(paused['job'])
                progress('restart owned gateway and recover through native history')
                self.stop_gateway()
                self.start_gateway()
                wait_result = self.rpc('agent.wait', {'runId': paused['job']['runId'], 'timeoutMs': 1000})
                assert wait_result.get('status') == 'timeout', 'Native wait unexpectedly retained the completed run'
                self.reload()
                recovered = self.wait_job(second, lambda value: bool(value['job'].get('deliveredAt')))
                assert recovered['job']['runId'] == paused['job']['runId']
                proof['gatewayRestart'] = {'status': 'passed', 'nativeWaitTimedOut': True, **self.prove_reply(recovered)}

            progress('submit and stop cancellation task')
            third = self.submit('cancel', 'Call session_status repeatedly at least 50 times before replying. Do not change files or contact anyone.')
            running = self.wait_job(third, lambda value: bool(value['job'].get('runId')))
            assert running['job']['state'] not in ('completed', 'cancelled'), 'Cancellation task ended before stop'
            self.operation(f'''
              const jobs=await plugin.getService("remoteAgentJobs");
              if(!await jobs.cancelSubagent({js(third['subagentId'])}))throw Error("Stop intent rejected");
              return true;
            ''')
            cancelled = self.wait_job(third, lambda value: value['job']['state'] == 'cancelled' and bool(value['job'].get('deliveredAt')))
            assert len(cancelled['replies']) == 1
            proof['cancellation'] = {'status': 'passed', 'runId': cancelled['job']['runId'], 'replyCount': 1}
            proof['status'] = 'passed'
        except Exception as error:
            self.errors.append(self.safe(error))
            proof['status'] = 'failed'
            proof['failedPhase'] = phase
            if proof['gatewayRestart']['status'] == 'running':
                proof['gatewayRestart']['status'] = 'failed'
            print(f'{time.strftime("%H:%M:%S")} Failed phase: {phase} (+{time.monotonic() - phase_started:.1f}s) - {self.safe(error)}', flush=True)
        finally:
            progress('fixture cleanup and owned gateway shutdown')
            try:
                self.cleanup()
            except Exception as error:
                self.errors.append('Cleanup unconfirmed: ' + self.safe(error))
            finally:
                self.stop_gateway()
            phase_log[-1]['durationSeconds'] = round(time.monotonic() - phase_started, 1)
            if self.errors:
                proof['status'] = 'failed'
                proof['errors'] = self.errors
            self.proof_path.write_text(self.safe(json.dumps(proof, indent=2)))
        print(self.safe(json.dumps(proof, indent=2)), flush=True)
        if self.errors:
            raise SystemExit('\n'.join(self.errors))


def js(value):
    return json.dumps(value)


if __name__ == '__main__':
    if os.environ.get('RUN_NEXUS_OPENCLAW_LIVE') != '1':
        raise SystemExit('Skipped: set RUN_NEXUS_OPENCLAW_LIVE=1 explicitly')
    Verification().run()
