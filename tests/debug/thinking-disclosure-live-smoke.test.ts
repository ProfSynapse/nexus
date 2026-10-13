/**
 * Real Obsidian rendering + persistence, with synthetic provider events (no API calls).
 * Only use a disposable vault containing a `.nexus-thinking-test` marker.
 * Install this build first. RUN_THINKING_SMOKE=1 THINKING_SMOKE_VAULT=<name>
 * THINKING_SMOKE_OBSIDIAN=<cli> pnpm exec jest <this-file> --runInBand --no-coverage
 * Every eval verifies vault identity. Provider methods are restored in finally.
 */
import { execFileSync } from 'node:child_process';
const RUN = process.env.RUN_THINKING_SMOKE === '1';
const VAULT = process.env.THINKING_SMOKE_VAULT;
const CLI = process.env.THINKING_SMOKE_OBSIDIAN || 'obsidian';
const live = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

function evaluate(code: string): unknown {
  if (!VAULT) throw new Error('THINKING_SMOKE_VAULT must explicitly name a disposable vault');
  const guarded = `if(app.vault.getName()!==${JSON.stringify(VAULT)})throw Error('Wrong vault');${code}`;
  const output = execFileSync(CLI, ['eval', `vault=${VAULT}`, `code=${guarded}`], { encoding: 'utf8', timeout: 20_000 });
  if (/^Error:/m.test(output)) throw new Error(output);
  const result = output.match(/=> (.*)/s)?.[1]?.trim();
  return result ? JSON.parse(result) : undefined;
}
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(expression: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const error = evaluate('JSON.stringify(window.__thinkingSmoke?.error ?? null)');
    if (error) throw new Error(String(error));
    if (evaluate(`JSON.stringify(!!(${expression}))`)) return;
    await delay();
  }
  throw new Error(`Timed out: ${expression}`);
}
const state = () => evaluate(`const p=window.__thinkingSmoke; const d=p.view.containerEl.querySelector('.message-reasoning');const b=d.querySelector('.message-reasoning-content');JSON.stringify({open:d.open,label:d.querySelector('.thinking-loader-text').textContent,brain:!!d.querySelector('.lucide-brain'),distance:b.scrollHeight-b.scrollTop-b.clientHeight,top:b.scrollTop,arrow:d.querySelector('.reasoning-catch-up').hidden,animation:getComputedStyle(d.querySelector('.thinking-loader-text')).animationName,hold:p.view.messageDisplay.reasoningReadHolds.size,panels:p.view.containerEl.querySelectorAll('.message-reasoning').length})`) as Record<string, unknown>;

live('thinking disclosure in Obsidian', () => {
  it('follows while caught up, preserves a paused reading position and settles without collapsing', async () => {
    try {
      evaluate(`window.__thinkingSmoke={phase:'starting'};(async()=>{
        if(!await app.vault.adapter.exists('.nexus-thinking-test'))throw Error('Disposable test vault marker missing');
        const p=window.__thinkingSmoke;
        p.service=app.plugins.plugins.nexus.getServiceIfReady('chatService');
        p.conversation=await p.service.getConversationService().createConversation({title:'Thinking smoke fixture',messages:[]});
        p.leaf=app.workspace.getLeavesOfType('nexus-chat')[0] ?? app.workspace.getLeaf('tab');
        if(p.leaf.view.getViewType()!=='nexus-chat')await p.leaf.setViewState({type:'nexus-chat',active:true});
        app.workspace.setActiveLeaf(p.leaf,{focus:true});
        await p.leaf.loadIfDeferred();
        for(let i=0;i<100&&!p.leaf.view.conversationManager;i++)await new Promise(r=>setTimeout(r,50));
        p.view=p.leaf.view;
        await p.view.conversationManager.selectConversation(p.conversation);
        p.conversation=p.view.conversationManager.getCurrentConversation();
        if(p.conversation.messages.length)throw Error('Fixture conversation was not empty');
        p.llm=p.service.getLLMService();p.originalStream=p.llm.generateResponseStream;p.originalDefault=p.llm.getDefaultModel;
        p.llm.getDefaultModel=()=>({provider:'test',model:'test'});
        p.queue=[];p.wake=null;p.push=e=>{p.queue.push(e);p.wake?.();p.wake=null};
        p.llm.generateResponseStream=async function*(){while(true){if(!p.queue.length)await new Promise(r=>p.wake=r);const event=p.queue.shift();yield event;if(event.type==='turn.completed')return;}};
        p.push({type:'reasoning.delta',text:('A step in the reasoning.\\n').repeat(80)});
        p.running=p.view.messageManager.sendMessage(p.conversation,'Synthetic smoke test',{provider:'test',model:'test'}).then(()=>p.phase='finished').catch(e=>p.error=e.stack);
        p.phase='streaming';
      })().catch(e=>window.__thinkingSmoke.error=e.stack);JSON.stringify({scheduled:true})`);
      await waitFor(`window.__thinkingSmoke.view?.containerEl.querySelector('.message-reasoning-content')?.textContent.includes('A step')`);
      expect(state()).toMatchObject({ open: false, animation: 'nexus-reasoning-sweep', panels: 1 });
      evaluate(`window.__thinkingSmoke.view.containerEl.querySelector('.message-reasoning summary').focus()`);
      for (const type of ['keyDown', 'keyUp']) execFileSync(CLI, ['dev:cdp', `vault=${VAULT}`, 'method=Input.dispatchKeyEvent', `params=${JSON.stringify({ type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })}`], { timeout: 20_000 });
      await waitFor(`window.__thinkingSmoke.view.containerEl.querySelector('.message-reasoning-content').scrollTop>0`);
      expect(Number(state().distance)).toBeLessThanOrEqual(8);
      evaluate(`const p=window.__thinkingSmoke;const b=p.view.containerEl.querySelector('.message-reasoning-content');b.scrollTop=100;b.dispatchEvent(new Event('scroll'));p.push({type:'reasoning.delta',text:('More reasoning.\\n').repeat(30)})`);
      await delay();
      expect(state()).toMatchObject({ top: 100, arrow: false, hold: 1 });
      // Reconciliation must preserve local expansion/scroll while hydrating
      // reasoning from the authoritative runtime, even if the message is stale.
      evaluate(`const p=window.__thinkingSmoke;p.view.messageDisplay.setConversation(p.conversation)`);
      await delay();
      expect(state()).toMatchObject({ open: true, top: 100, arrow: false });
      evaluate(`window.__thinkingSmoke.view.containerEl.querySelector('.reasoning-catch-up').click()`);
      await delay();
      expect(Number(state().distance)).toBeLessThanOrEqual(8);
      evaluate(`const p=window.__thinkingSmoke;p.push({type:'assistant.delta',text:'Verified answer.'});p.push({type:'turn.completed'})`);
      await waitFor(`window.__thinkingSmoke.phase==='finished'`);
      await delay();
      expect(state()).toMatchObject({ open: true, label: 'Reasoning', brain: true, animation: 'none', panels: 1, hold: 0 });
      expect(Number(state().distance)).toBeLessThanOrEqual(8);
      evaluate(`(async()=>{const p=window.__thinkingSmoke;const c=await p.service.getConversation(p.conversation.id);p.saved=c.messages.at(-1)})().catch(e=>window.__thinkingSmoke.error=e.stack);JSON.stringify({scheduled:true})`);
      await waitFor(`!!window.__thinkingSmoke.saved`);
      expect(evaluate(`const m=window.__thinkingSmoke.saved;JSON.stringify({state:m.state,content:m.content,reasoning:!!m.reasoning,segments:m.reasoningSegments.length})`)).toMatchObject({ state: 'complete', content: 'Verified answer.', reasoning: true, segments: 1 });
    } finally {
      evaluate(`const p=window.__thinkingSmoke;if(p?.llm){p.llm.generateResponseStream=p.originalStream;p.llm.getDefaultModel=p.originalDefault;p.push({type:'turn.completed'});p.view.messageManager.cancelCurrentGeneration();}p?.leaf?.detach()`);
    }
  });
});
