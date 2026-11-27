// The BioSwarm connector on a real Pi session with Pi's fake provider: no network, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createBioSwarm, messageCall } from './index.js';

// A host layout like OpenBot's: <root>/Agents/<agent> and <root>/Shared.
function layout({ marker = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bioswarm-ext-')), cwd = join(root, 'Agents', 'agent-a');
  mkdirSync(cwd, { recursive: true });mkdirSync(join(root, 'Shared'));
  if (marker !== null) writeFileSync(join(cwd, '.bioswarm'), marker);
  return { root, cwd, field: join(root, 'Shared', 'bioswarm', 'field.jsonl'), log: join(cwd, '.bioswarm-events.jsonl') };
}
const events = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

// A stand-in for the host's messaging tool, under the name OpenBot gives it.
const hostTools = sent => pi => pi.registerTool({ name: 'send_message', label: 'Send message', description: 'Message another agent.',
  parameters: Type.Object({ to: Type.String(), message: Type.String() }),
  async execute(_id, params) { sent.push(params);return { content: [{ type: 'text', text: 'Sent.' }], details: {} }; } });

async function session(t, cwd, responses, { extra = [], connectorOptions = {} } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'bioswarm-agent-')), faux = registerFauxProvider(), model = faux.getModel();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
  await modelRuntime.setRuntimeApiKey(model.provider, 'faux-key');
  modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl }] });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [...extra, createBioSwarm({ cwd, ...connectorOptions })], noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader, sessionManager: SessionManager.inMemory() });
  t.after(() => session.dispose());
  faux.setResponses(responses);
  return session;
}

test('without a .bioswarm file the extension registers nothing', () => {
  const { cwd } = layout({ marker: null }), calls = [];
  createBioSwarm({ cwd })({ registerTool: tool => calls.push(tool.name), on: name => calls.push(name) });
  assert.deepEqual(calls, []);
});

test('the host messaging tool is recognized under its own name, a bridge prefix or a generic tool_call', () => {
  assert.ok(messageCall('send_message', { to: 'b', message: 'x' }));
  assert.ok(messageCall('openbot_1a2b3c4d_send_message', { to: 'b', message: 'x' }));
  assert.equal(messageCall('tool_call', { name: 'send_message', arguments: { to: 'b', message: 'oi' } }).message, 'oi');
  assert.equal(messageCall('tool_call', { name: 'list_agents' }), null);
  assert.equal(messageCall('read', { path: 'a' }), null);
  assert.ok(messageCall('openbot.tool_call',{name:'openbot.send_message',arguments:{text:'ok'}}));
});

test('one short message per request; a second one or a long one is refused and the agent is pointed to the field', async t => {
  const { cwd, log } = layout(), sent = [];
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('send_message', { to: 'ops', message: 'Ver a marca em Shared/bioswarm sobre a Orion.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('send_message', { to: 'ops', message: 'Mais uma coisa.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Pronto.'),
  ], { extra: [hostTools(sent)] });
  await s.prompt('Descubra onde está a Orion.');
  assert.equal(sent.length, 1);
  assert.ok(events(log).some(e => e.type === 'rule' && e.rule === 'message_ceiling'));

  const second = layout({ marker: JSON.stringify({ messageChars: 20 }) }), sent2 = [];
  const s2 = await session(t, second.cwd, [fauxAssistantMessage([fauxToolCall('send_message', { to: 'ops', message: 'x'.repeat(200) })], { stopReason: 'toolUse' }), fauxAssistantMessage('Ok.')], { extra: [hostTools(sent2)] });
  await s2.prompt('Peça ajuda.');
  assert.equal(sent2.length, 0);
  assert.ok(events(second.log).some(e => e.rule === 'message_pointer'));
});

test('a file taken by another agent is put back after a shell command changes it, and the agent is told', async t => {
  const { cwd, field, log } = layout(), file = join(cwd, 'notes.md');
  writeFileSync(file, 'original\n');mkdirSync(join(field, '..'), { recursive: true });
  writeFileSync(field, JSON.stringify({ kind: 'taken', place: file, text: 'editing', by: 'agent-b', at: 1 }) + '\n');
  let toldUndone = false;
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('bash', { command: `echo changed > ${file}` })], { stopReason: 'toolUse' }),
    context => { toldUndone = JSON.stringify(context.messages.at(-1)).includes('taken by another agent');return fauxAssistantMessage('Deixei uma marca.'); },
  ]);
  await s.prompt('Atualize as notas.');
  assert.equal(readFileSync(file, 'utf8'), 'original\n');
  assert.ok(toldUndone);
  assert.ok(events(log).some(e => e.rule === 'taken_undone'));
});

test('a released file is free again', async t => {
  const { cwd, field } = layout(), file = join(cwd, 'notes.md');
  writeFileSync(file, 'original\n');mkdirSync(join(field, '..'), { recursive: true });
  writeFileSync(field, [{ kind: 'taken', place: file, by: 'agent-b' }, { kind: 'released', place: file, by: 'agent-b' }].map(m => JSON.stringify({ text: '', at: 1, ...m })).join('\n') + '\n');
  const s = await session(t, cwd, [fauxAssistantMessage([fauxToolCall('bash', { command: `echo changed > ${file}` })], { stopReason: 'toolUse' }), fauxAssistantMessage('Feito.')]);
  await s.prompt('Atualize as notas.');
  assert.equal(readFileSync(file, 'utf8'), 'changed\n');
});

test('leave_mark writes to the host shared folder, and read_marks returns it', async t => {
  const { cwd, field } = layout();let read = '';
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('leave_mark', { kind: 'finding', place: 'orion', text: 'Fonte: schema orion no Supabase.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read_marks', { place: 'orion' })], { stopReason: 'toolUse' }),
    context => { read = JSON.stringify(context.messages.at(-1));return fauxAssistantMessage('Ok.'); },
  ]);
  await s.prompt('Registre o achado.');
  const marks = events(field);
  assert.equal(marks.length, 1);assert.equal(marks[0].kind, 'finding');assert.equal(marks[0].by, 'agent-a');
  assert.ok(read.includes('schema orion'));
});

test('after the request spends its budget, the next tool is refused and the run ends', async t => {
  const { cwd, log } = layout({ marker: JSON.stringify({ runBudgetUsd: 1 }) }), file = join(cwd, 'out.txt');
  // Stands in for a provider's price: every assistant message costs US$ 0.75.
  const price = pi => pi.on('message_end', async event => (event.message?.role === 'assistant' ? { message: { ...event.message, usage: { ...event.message.usage, cost: { ...(event.message.usage?.cost || {}), total: 0.75 } } } } : undefined));
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('bash', { command: 'true' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('write', { path: 'out.txt', content: 'x' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Parei no orçamento.'),
  ], { extra: [price] });
  await s.prompt('Faça tudo.');
  assert.equal(existsSync(file), false);
  const log2 = events(log);
  assert.ok(log2.some(e => e.rule === 'run_budget'));
  assert.ok(log2.some(e => e.type === 'run_end' && e.over === true));
});

test('a session ceiling holds across turns of the same session', async t => {
  const { cwd, log } = layout({ marker: JSON.stringify({ messagesPerSession: 1, messagesPerRun: 5 }) }), sent = [];
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('send_message', { to: 'b', message: 'Veja a marca orion.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Primeiro turno feito.'),
    fauxAssistantMessage([fauxToolCall('send_message', { to: 'b', message: 'Mais uma.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Segundo turno feito.'),
  ], { extra: [hostTools(sent)] });
  await s.prompt('Primeiro pedido.');
  await s.prompt('Segundo pedido.');
  assert.equal(sent.length, 1);
  assert.ok(events(log).some(e => e.rule === 'session_ceiling'));
});

test('the acceptance gate keeps the agent working until each package has its own tests and the command passes', async t => {
  const task = mkdtempSync(join(tmpdir(), 'bioswarm-gate-'));
  const { cwd, log } = layout({ marker: JSON.stringify({ gate: { dir: task, command: 'test -f checks/a-kit.test.mjs', packages: ['a-kit'], rounds: 2 } }) });
  let toldGate = false;
  const s = await session(t, cwd, [
    fauxAssistantMessage('Pronto.'),
    context => { toldGate = JSON.stringify(context.messages).includes('BioSwarm acceptance gate');return fauxAssistantMessage([fauxToolCall('write', { path: join(task, 'checks/a-kit.test.mjs'), content: '// tests' })], { stopReason: 'toolUse' }); },
    fauxAssistantMessage('Agora sim, pronto.'),
  ]);
  await s.prompt('Corrija o repositório.');
  assert.ok(toldGate);
  assert.ok(existsSync(join(task, 'checks/a-kit.test.mjs')));
  const ev = events(log);
  assert.ok(ev.some(e => e.rule === 'accept_gate'));
  assert.ok(ev.some(e => e.type === 'gate_pass'));
});

test('the acceptance gate gives up after its rounds, so a run always ends', async t => {
  const task = mkdtempSync(join(tmpdir(), 'bioswarm-gate-'));
  const { cwd, log } = layout({ marker: JSON.stringify({ gate: { dir: task, command: 'exit 1', packages: [], rounds: 1 } }) });
  const s = await session(t, cwd, [fauxAssistantMessage('Pronto.'), fauxAssistantMessage('Ainda pronto.'), fauxAssistantMessage('Fim.')]);
  await s.prompt('Corrija.');
  const ev = events(log);
  assert.equal(ev.filter(e => e.rule === 'accept_gate').length, 1);
  assert.ok(ev.some(e => e.rule === 'gate_gave_up'));
});

for (const [limit, rule] of [['messagesPerRun', 'message_ceiling'], ['messagesPerSession', 'session_ceiling']]) {
  test(limit + ' allows marks and addressed requirement traces before and after refusal', async t => {
    const { cwd, field, log } = layout({ marker: JSON.stringify({ [limit]: 1 }) });
    const sent = [];
    const call = (tool, input) => fauxAssistantMessage([fauxToolCall(tool, input)], { stopReason: 'toolUse' });
    const trace = text => call('leave_mark', {kind:'finding', place:'invoice-check', text});
    const pointer = () => call('send_message', {to:'ops', message:'See invoice-check'});
    const s = await session(t, cwd, [
      trace('Requirement received'), pointer(), pointer(),
      context => {
        assert.match(JSON.stringify(context.messages.at(-1)), /continue working without stopping or asking the user/i);
        return trace('Requirement reconciled');
      },
      call('read_marks', {place:'invoice-check'}),
      call('write', {path:join(cwd,'completed.txt'),content:'reconciled'}),
      fauxAssistantMessage('Done.'),
    ], {extra:[hostTools(sent)]});
    await s.prompt('Coordinate through the field and finish the reconciliation.');
    assert.equal(sent.length, 1);
    assert.equal(events(log).filter(e=>e.rule===rule).length,1);
    assert.deepEqual(events(field).map(m=>m.text), ['Requirement received','Requirement reconciled']);
    assert.equal(readFileSync(join(cwd,'completed.txt'),'utf8'),'reconciled');
  });
}

test('Pi enforces addressed traces, a single hash winner, and outsider recovery after consecutive stalled waves', async t => {
  const { publishWave, assignment } = await import('./coordination.js');
  const { realpathSync, symlinkSync } = await import('node:fs');
  const root = realpathSync(mkdtempSync(join(tmpdir(),'bioswarm-waves-')));
  const task = join(root,'task'), waves=join(root,'waves'), field=join(root,'field');
  mkdirSync(task); const file=join(task,'invoice.txt');writeFileSync(file,'original');
  const team=['lead','ops','audit'];
  for(const agent of team){mkdirSync(join(root,agent));writeFileSync(join(root,agent,'.bioswarm'),JSON.stringify({waveDir:waves,field}));}
  const check={id:'invoice-check',place:'invoice.txt',owners:['lead','ops'],revision:'v1'};
  const spec={root:task,run:'close',wave:1,team,checks:[check],fallbackAfter:8};
  const remoteRules = { waitForTrace:true, tieBreak:'hash', fallbackAfter:3 };
  const connectorOptions = {
    env:{ BIOSWARM_API_KEY:'fixture', BIOSWARM_API_URL:'https://control.example' },
    fetchImpl:async () => ({ ok:true, json:async () => ({protocol:'bioswarm.v1',id:'fixture',rules:remoteRules}) })
  };
  const wave1=publishWave(waves,spec);
  assert.throws(()=>publishWave(waves,spec));
  const pick = w=>assignment(w,w.checks[0],remoteRules).agent;
  const call=(tool,input)=>fauxAssistantMessage([fauxToolCall(tool,input)],{stopReason:'toolUse'});
  const act=async (agent,...actions)=>{
    const s=await session(t,join(root,agent),[...actions,fauxAssistantMessage('Done.')], {connectorOptions});
    await s.prompt('Perform the coordination check.');
  };
  const write=text=>call('write',{path:file,content:text});
  const trace=(to,text)=>call('leave_mark',{kind:'requirement',place:file,to,text});
  const a=pick(wave1), b=check.owners.find(x=>x!==a);
  assert.equal(assignment(wave1,{...wave1.checks[0],owners:[...check.owners].reverse()},{tieBreak:'hash'}).agent,a);
  await act(a,write('too early'),call('bash',{command:'true'}),trace(a,'self trace'),write('also early'));
  assert.equal(readFileSync(file,'utf8'),'original');
  await act('audit',trace(b,'addressed elsewhere'));
  await act(a,write('wrong recipient'));await act(b,write('loser'),write('loser again'));
  assert.equal(readFileSync(file,'utf8'),'original');
  await act('audit',trace(a,'reconcile invoice'));
  await act(a,write('reconciled'));assert.equal(readFileSync(file,'utf8'),'reconciled');
  const fieldPath=join(field,'field.jsonl');
  assert.equal(events(fieldPath).filter(m=>m.by===b&&m.kind==='yielded').length,1);
  assert.ok(events(join(root,a,'.bioswarm-events.jsonl')).some(e=>e.rule==='unscoped_tool'));
  const other={id:'tax-check',place:'tax.txt',owners:['ops'],revision:'x'};
  publishWave(waves,{...spec,wave:2,checks:[check,other]});
  for(const n of [3,4,5]){
    const w=publishWave(waves,{...spec,wave:n});assert.equal(w.checks[0].loneWaves,n-2);
    assert.equal(assignment(w,w.checks[0],remoteRules).fallback,n===5);
  }
  await act('audit',write('missing rescue trace'));assert.equal(readFileSync(file,'utf8'),'reconciled');
  await act(a,trace('audit','review remaining discrepancy'));await act('audit',write('recovered'));
  assert.equal(readFileSync(file,'utf8'),'recovered');
  const w6=publishWave(waves,{...spec,wave:6,checks:[{...check,revision:'v2'}]});
  assert.equal(w6.checks[0].loneWaves,1);
  await act(pick(w6),write('stale trace'));assert.equal(readFileSync(file,'utf8'),'recovered');
  const alias=join(task,'alias.txt');symlinkSync(file,alias);
  publishWave(waves,{...spec,wave:7,checks:[{...check,place:'alias.txt',owners:['ops']}]});
  await act('lead',call('leave_mark',{kind:'requirement',place:alias,to:'ops',text:'linked'}));
  await act('ops',call('write',{path:alias,content:'wrong target'}));assert.equal(readFileSync(file,'utf8'),'recovered');
});

test('scoped waves permit independent work in the same turn and reserve yield for actual contenders', async t => {
  const { realpathSync } = await import('node:fs');
  const { publishWave, assignment } = await import('./coordination.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bioswarm-scoped-')));
  const field = join(root,'field'), task = join(root,'task'), waves = join(root,'waves');
  mkdirSync(task);
  const team = ['lia','rui','teo'];
  const rules = {waitForTrace:true, tieBreak:'hash', fallbackAfter:3};
  const delivered = [];
  const connectorOptions = {
    env:{BIOSWARM_API_KEY:'fixture', BIOSWARM_API_URL:'https://control.example'},
    fetchImpl: async (_url, init) => {
      if (init?.method === 'POST') delivered.push(...JSON.parse(init.body).events);
      return {ok:true,json:async () => ({protocol:'bioswarm.v1', id:'scoped',rules})};
    },
  };
  for (const agent of team) {
    mkdirSync(join(root,agent));
    writeFileSync(join(root,agent,'.bioswarm'), JSON.stringify({waveDir:waves,field}));
  }
  const own = {id:'notes',place:'notes.txt',class:'own',owners:['lia'],revision:'r1'};
  const directed = {...own,id:'invoice',place:'invoice.txt',class:'directed'};
  const dispute = {...own,id:'balance',place:'balance.txt',class:'dispute',owners:['lia','rui']};
  const spec = {coordination:'scoped-v1',run:'scoped',wave:1,root:task,team,checks:[own,directed,dispute],fallbackAfter:3};
  const wave = publishWave(waves,spec);
  const winner = assignment(wave,wave.checks[2],rules).agent;
  const loser = dispute.owners.find(a => a !== winner);
  const call = (name,input) => fauxAssistantMessage([fauxToolCall(name,input)],{stopReason:'toolUse'});
  const write = (c,value) => call('write',{path:join(task,c.place),content:value});
  const trace = (c,to) => call('leave_mark',{kind:'requirement',place:join(task,c.place),to,text:'fixture'});
  const act = async (agent,...actions) => {
    const s = await session(t,join(root,agent),[...actions,fauxAssistantMessage('Done.')],{connectorOptions});
    await s.prompt('Check the current assignments.');
    return s;
  };
  await act('lia',write(directed,'early'),write(own,'independent'));
  assert.equal(existsSync(join(task,directed.place)),false);
  assert.equal(readFileSync(join(task,own.place),'utf8'),'independent');
  await act('teo',write(dispute,'outsider'),trace(directed,'rui'),trace(own,'lia'));
  const report = await act('lia',call('coordination_status',{}),write(directed,'wrong recipient'));
  const result = report.messages.find(m => m.role === 'toolResult' && m.toolName === 'coordination_status');
  const status = JSON.parse(result.content[0].text).checks;
  assert.equal(status.find(c => c.class==='own').priority,true);
  assert.equal(status.find(c => c.class==='own').traceRequired,false);
  assert.equal(status.find(c => c.class==='directed').traceRequired,true);
  await act(loser,write(dispute,'loser'),write(dispute,'loser again'));
  assert.equal(existsSync(join(task,dispute.place)),false);
  await act(winner,write(dispute,'winner'));
  assert.equal(readFileSync(join(task,dispute.place),'utf8'),'winner');
  await act('teo',trace(directed,'lia'));
  await act('lia',write(directed,'ready'));
  assert.equal(readFileSync(join(task,directed.place),'utf8'),'ready');
  const marks = events(join(field,'field.jsonl')).filter(m => m.kind==='yielded');
  assert.deepEqual(marks.map(m => [m.by,m.check,m.to]),[[loser,dispute.id,winner]]);
  const decisions = team.flatMap(a => events(join(root,a,'.bioswarm-events.jsonl'))).filter(e => e.type==='decision');
  assert.equal(decisions.filter(e => e.rule==='wait_for_trace' && e.class==='directed').length,2);
  assert.ok(decisions.some(e => e.outcome==='allowed' && e.check==='notes' && e.wave===1));
  assert.equal(decisions.filter(e => e.outcome==='yielded').length,2);
  assert.ok(delivered.length);
  assert.ok(delivered.every(e => e.type!=='decision' && !Object.hasOwn(e,'check')));
  for (const checks of [[{...own,class:'other'}],[{...dispute,owners:['lia']}],[{...own,owners:team}]])
    assert.throws(() => publishWave(waves,{...spec,wave:2,checks}),/class/);
  assert.throws(()=>publishWave(waves,{...spec,coordination:undefined,wave:2}),/new wave directory/);
  const solo = publishWave(waves,{...spec,wave:2,checks:[own]});
  assert.equal(assignment(solo,{...solo.checks[0],loneWaves:3},rules).fallback,false);
  const changed = publishWave(waves,{...spec,wave:3,checks:[{...own,class:'directed'}]});
  assert.notEqual(changed.checks[0].generation,solo.checks[0].generation);
  for (const n of [4,5]) publishWave(waves,{...spec,wave:n,checks:[{...own,class:'directed'}]});
  const {currentWave} = await import('./coordination.js');
  const last=currentWave(waves);
  assert.equal(assignment(last,last.checks[0],rules).fallback,true);
});

test('the recommended hash-only policy reproduces 0.2 writer and yields on both wave formats', async t => {
  const { realpathSync, rmSync } = await import('node:fs');
  const { publishWave } = await import('./coordination.js');
  const team = ['lia', 'rui', 'teo'];
  // Fixed vector from 0.2 at 75c5bc4, independent of the current assignment implementation.
  for (const scoped of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bioswarm-hash-only-')));
    t.after(() => rmSync(root, {recursive:true, force:true}));
    const task = join(root,'task'), field = join(root,'field'), waves = join(root,'waves');
    mkdirSync(task);
    const file = join(task,'balance.txt');
    const check = {id:'balance', place:'balance.txt', owners:['rui','lia'], revision:'r1'};
    publishWave(waves, {run:'hash-only',wave:1,root:task,team,fallbackAfter:3,
      ...(scoped ? {coordination:'scoped-v1'} : {}), checks:[scoped ? {...check,class:'dispute'} : check]});
    const options = {env:{BIOSWARM_API_KEY:'fixture', BIOSWARM_API_URL:'https://control.example'},
      fetchImpl: async () => ({ok:true,json:async () => ({protocol:'bioswarm.v1',id:'field-tiebreak@1',rules:{waitForTrace:false,tieBreak:'hash'}})})};
    for (const agent of team) {
      const cwd = join(root,agent);
      mkdirSync(cwd);
      writeFileSync(join(cwd,'.bioswarm'),JSON.stringify({field,waveDir:waves}));
    }
    const winner = 'lia', loser = team.find(a => a !== winner && a !== 'teo');
    for (const agent of [loser,'teo',winner]) {
      const write = () => fauxAssistantMessage([fauxToolCall('write',{path:file,content:agent})],{stopReason:'toolUse'});
      const s = await session(t,join(root,agent),[write(),write(),fauxAssistantMessage('Done.')],{connectorOptions:options});
      await s.prompt('Write the assigned balance.');
      if (agent !== winner) assert.equal(existsSync(file),false);
    }
    assert.equal(readFileSync(file,'utf8'),winner);
    const marks = events(join(field,'field.jsonl')).filter(m => m.kind === 'yielded');
    assert.deepEqual(marks.map(m => [m.by,m.to]),[[loser,winner],['teo',winner]]);
  }
});

test('0.4 community policy with no wave keeps normal tools: hash is on but nothing is gated', async t => {
  const { cwd } = layout();
  const target = join(cwd, 'notes.txt');
  const s = await session(t, cwd, [
    fauxAssistantMessage([fauxToolCall('write', { path: target, content: 'free' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ], { connectorOptions: { env: {} } });
  await s.prompt('Write the notes.');
  assert.equal(readFileSync(target, 'utf8'), 'free');
  assert.ok(!events(join(cwd, '.bioswarm-events.jsonl')).some(e => e.type === 'rule'));
});

test('0.4 community policy with a published wave: hash picks one writer, and a lone stalled check goes to an outsider without a trace', async t => {
  const { realpathSync, rmSync } = await import('node:fs');
  const { publishWave, assignment, currentWave } = await import('./coordination.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bioswarm-community-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = join(root, 'task'), field = join(root, 'field'), waves = join(root, 'waves');
  mkdirSync(task);
  const team = ['lia', 'rui', 'teo'];
  for (const agent of team) { mkdirSync(join(root, agent)); writeFileSync(join(root, agent, '.bioswarm'), JSON.stringify({ field, waveDir: waves })); }
  const file = join(task, 'balance.txt');
  const check = { id: 'balance', place: 'balance.txt', owners: ['lia', 'rui'], revision: 'r1' };
  // No fallbackAfter in the wave: the default of three applies.
  const spec = { run: 'community', root: task, team, checks: [check] };
  const w1 = publishWave(waves, { ...spec, wave: 1 });
  assert.equal(w1.fallbackAfter, 3);
  const rules = { tieBreak: 'hash', waitForTrace: false };
  const writer = assignment(w1, w1.checks[0], rules).agent, other = check.owners.find(a => a !== writer);
  const write = agent => fauxAssistantMessage([fauxToolCall('write', { path: file, content: agent })], { stopReason: 'toolUse' });
  const act = async agent => {
    const s = await session(t, join(root, agent), [write(agent), fauxAssistantMessage('Done.')], { connectorOptions: { env: {} } });
    await s.prompt('Write the balance.');
  };
  await act(other);
  assert.equal(existsSync(file), false);
  await act(writer);
  assert.equal(readFileSync(file, 'utf8'), writer);
  // The check stays failing, alone and unchanged through wave 4 (lone since wave 1), past the threshold of three.
  for (const n of [2, 3, 4]) publishWave(waves, { ...spec, wave: n });
  const stalled = currentWave(waves);
  assert.equal(stalled.checks[0].loneWaves, 4);
  const rescue = assignment(stalled, stalled.checks[0], rules);
  assert.deepEqual(rescue, { agent: 'teo', fallback: true });
  await act(writer);
  assert.equal(readFileSync(file, 'utf8'), writer, 'the stalled owner no longer writes');
  await act('teo');
  assert.equal(readFileSync(file, 'utf8'), 'teo', 'the outsider writes without an addressed trace');
  assert.ok(events(join(root, 'teo', '.bioswarm-events.jsonl')).some(e => e.rule === 'stalled_check_reassigned'));
  assert.ok(events(join(field, 'field.jsonl')).some(m => m.kind === 'yielded' && m.by === writer && m.to === 'teo'));
});
