"""Opt-in real Nexus -> Hermes integration test; requires this plugin build installed.

RUN_NEXUS_HERMES_LIVE=1 NEXUS_HERMES_TEST_VAULT='<test vault basename>' \
NEXUS_HERMES_BASE_URL='http://127.0.0.1:18642/v1' \
NEXUS_HERMES_KEY_FILE='<private key file>' python3 scripts/verify-hermes-in-obsidian.py

Use an isolated Hermes profile with only the todo toolset enabled and a configured
inference model. No server/model is mocked. Requires the Obsidian CLI. Creates
synthetic conversations and one temporary connection, reloads Nexus, proves a
real todo tool event and exactly one reply, then removes its own fixtures.
Credential values are read from a file and omitted from the proof and log output.
Optional NEXUS_HERMES_PROOF_PATH controls the JSON report location.
"""
from pathlib import Path
import json,os,subprocess,time,secrets,urllib.request
if os.environ.get('RUN_NEXUS_HERMES_LIVE') != '1':
    raise SystemExit('Skipped: set RUN_NEXUS_HERMES_LIVE=1 explicitly')
vault=os.environ['NEXUS_HERMES_TEST_VAULT']
base_url=os.environ['NEXUS_HERMES_BASE_URL'].rstrip('/')
proof_path=Path(os.environ.get('NEXUS_HERMES_PROOF_PATH','/tmp/nexus-hermes-live-proof.json'))
key=Path(os.environ['NEXUS_HERMES_KEY_FILE']).read_text().strip(); token=secrets.token_hex(8); target='hermes-live-'+token
slot='__nexusHermesLive_'+token; marker='NEXUS-HERMES-'+token
q=json.dumps; guard=f'if(app.vault.getName()!=={q(vault)})throw Error("Wrong vault");'
parent=None; branch=None; mutated=False; errors=[]
def cli(*args):
    try: result=subprocess.run(['obsidian',args[0],'vault='+vault,*args[1:]],capture_output=True,text=True,timeout=20)
    except Exception as e: raise RuntimeError(str(e).replace(key,'[redacted]')) from None
    if result.returncode: raise RuntimeError((result.stderr or result.stdout).replace(key,'[redacted]'))
    return result.stdout

def ev(code):
    out=cli('eval','code=(()=>{'+guard+code+'})()')
    for line in reversed(out.splitlines()):
        if line.startswith('=> '):
            value=line[3:]
            try: return json.loads(value)
            except ValueError: return value
    raise RuntimeError('No synchronous eval acknowledgement')

def op(body):
    operation_slot=slot+'_'+secrets.token_hex(5)
    code=f'const s=window[{q(operation_slot)}]={{state:"running"}};(async()=>{{const plugin=app.plugins.plugins.nexus;{body}}})().then(v=>{{s.value=v;s.state="passed"}}).catch(e=>{{s.error=String(e);s.state="failed"}});return "started";'
    try: ev(code)
    except RuntimeError: pass # Never repeat a mutation; recover only its unique status.
    for _ in range(100):
        try: value=ev(f'return JSON.stringify(window[{q(operation_slot)}]||{{state:"missing"}});')
        except RuntimeError:
            time.sleep(.3); continue
        if value['state']=='passed': return value.get('value')
        if value['state']=='failed': raise RuntimeError(value['error'].replace(key,'[redacted]'))
        time.sleep(.3)
    raise TimeoutError('App operation did not settle; no mutation was retried')

def ready():
    for _ in range(40):
        try:
            if ev('return !!app.plugins.plugins.nexus?.getServiceIfReady("remoteAgentJobs");'): return
        except RuntimeError: pass
        time.sleep(.5)
    raise RuntimeError('Nexus remote job service is not ready')

def job():
    return op(f'const jobs=await plugin.getService("remoteAgentJobs");await jobs.reconcile();const storage=await plugin.getService("hybridStorageAdapter");const b=await storage.getConversation({q(branch)});const j=b?.metadata?.remoteAgentJob;if(!j)throw Error("Missing fixture job");const messages=await storage.getMessages(j.parentConversationId,{{page:0,pageSize:200}});return {{job:j,replies:messages.items.filter(m=>m.id===j.parentResultMessageId)}};')

def hermes(route,body=None,idem=None):
    headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}
    if idem: headers['Idempotency-Key']=idem
    req=urllib.request.Request(base_url+'/'+route,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req,timeout=30) as r:
        text=r.read().decode(); return text if route.endswith('/events') else json.loads(text)

try:
    ready(); enabled=[t['name'] for t in hermes('toolsets')['data'] if t.get('enabled')];assert enabled==['todo'],enabled
    mutated=True
    setup=op(f'const connection={{id:{q(target)},connector:"hermes",displayName:"Hermes local live test",baseUrl:{q(base_url)},apiKey:{q(key)},enabled:true}};plugin.settings.settings.remoteAgents=[...(plugin.settings.settings.remoteAgents||[]),connection];await plugin.settings.saveSettings();const registry=await plugin.getService("remoteAgentRegistry");await registry.refresh(connection.id);if(!registry.getAvailable().some(c=>c.id===connection.id))throw Error("Real Hermes unavailable");const storage=await plugin.getService("hybridStorageAdapter");const parent=await storage.createConversation({{title:{q(marker)},vaultName:app.vault.getName(),created:Date.now(),updated:Date.now(),metadata:{{hermesLiveFixture:{q(token)}}}}});const origin=await storage.addMessage(parent,{{role:"user",content:"Synthetic live Hermes task",timestamp:Date.now(),state:"complete"}});return {{parent,origin}};')
    parent=setup['parent']; task=f'Call todo_list with empty arguments exactly once to read the task list. After it returns, reply with exactly {marker}. An empty list is a successful result. Do not repeat the read and do not create any tasks.'
    started=op(f'const agents=await plugin.getService("agentManager");const result=await agents.getAgent("promptManager").getSubagentTool().execute({{target:{q(target)},task:{q(task)}}},{{conversationId:{q(parent)},messageId:{q(setup["origin"])},source:"internal",isSubagentBranch:false}});if(!result.success)throw Error(result.error);return result.data;')
    branch=started['branchId']; print('Nexus accepted background job',started['subagentId'],flush=True)
    for _ in range(30):
        before=job()
        if before['job'].get('runId'): break
        time.sleep(1)
    runid=before['job']['runId']; print('Real Hermes run',runid,flush=True)
    cli('plugin:reload','id=nexus');ready(); after=job();assert after['job']['runId']==runid
    print('Same run recovered after Nexus reload.',flush=True)
    for _ in range(150):
        result=job()
        if result['job'].get('deliveredAt'): break
        time.sleep(2)
    assert result['job']['state']=='completed',result['job'].get('error')
    server_result=hermes('runs/'+runid)
    assert server_result['status']=='completed' and server_result.get('output'),server_result
    expected_reply='[Remote agent \"Hermes local live test\" completed]\n\n'+server_result['output']
    assert len(result['replies'])==1 and result['replies'][0]['content']==expected_reply,result['replies']
    assert result['replies'][0]['metadata']['runId']==runid
    replay=hermes('runs',result['job']['request'],result['job']['idempotencyKey']);assert replay['run_id']==runid
    again=job();assert len(again['replies'])==1
    events=[json.loads(line[6:]) for line in hermes('runs/'+runid+'/events').splitlines() if line.startswith('data: ')]
    tools=[e for e in events if e.get('event')=='tool.completed' and e.get('tool')=='todo_list' and not e.get('error')]
    assert tools,'No real successful todo_list execution in Hermes event stream'
    proof={'runtime':server_result.get('runtime'),'runId':runid,'jobId':started['subagentId'],'state':result['job']['state'],'reply':result['replies'][0]['content'],'realTodoToolCalls':len(tools),'recoveredAfterReload':True,'idempotentReplay':True,'replyCount':len(again['replies'])}
    proof_path.write_text(json.dumps(proof,indent=2));print(json.dumps(proof),flush=True)
except Exception as e:
    errors.append(str(e).replace(key,'[redacted]'))
finally:
    if mutated:
        try:
            cleanup=op(f'const jobs=await plugin.getService("remoteAgentJobs");await jobs.cleanup();try{{const storage=await plugin.getService("hybridStorageAdapter");const owned=[];for(let page=0;;page++){{const r=await storage.getConversations({{includeBranches:true,page,pageSize:200,sortBy:"id",sortOrder:"asc"}});owned.push(...r.items.filter(c=>c.metadata?.hermesLiveFixture==={q(token)}||c.metadata?.remoteAgentJob?.targetId==={q(target)}));if(!r.hasNextPage)break;}}for(const c of owned)await storage.deleteConversation(c.id);plugin.settings.settings.remoteAgents=(plugin.settings.settings.remoteAgents||[]).map(c=>c.id==={q(target)}?{{...c,apiKey:""}}:c);await plugin.settings.saveSettings();plugin.settings.settings.remoteAgents=plugin.settings.settings.remoteAgents.filter(c=>c.id!=={q(target)});await plugin.settings.saveSettings();const saved=await plugin.loadData();if(saved.remoteAgents?.some(c=>c.id==={q(target)}))throw Error("Fixture connection remains");for(const c of owned)if(await storage.getConversation(c.id))throw Error("Fixture conversation remains");return {{removedConversations:owned.length,connectionRemoved:true}};}}finally{{await jobs.start();}}')
            print('Cleanup verified',json.dumps(cleanup),flush=True)
        except Exception as e: errors.append('Cleanup unconfirmed: '+str(e).replace(key,'[redacted]'))
if errors: raise SystemExit('\n'.join(errors))
