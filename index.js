// BioSwarm connector for Pi agents (OpenBot hosts Pi through RPC): bio-inspired coordination rules held in code,
// inside the agent loop. Open source (Apache-2.0). It does nothing unless the agent's folder holds a `.bioswarm`
// file, so one agent can be switched on without touching the others. The `.bioswarm` file may hold JSON settings.
//
// Which rules run, and their parameters, come from the BioSwarm Control API when BIOSWARM_API_KEY is set
// (policy.js, protocol bioswarm.v1); otherwise the community policy runs. The rules come from what Unfold Research
// measured: a rule binds only when code applies it to the state of the work; agent-to-agent messages were where
// coordination money went; a per-turn spending ceiling cannot be set from outside the loop.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {assignment, checkAt, currentWave, matchesTrace, traceRequired, validDestination} from './coordination.js';
import { Type } from 'typebox';
import { loadPolicy, mergeConfig, readCache, sendEvents } from './policy.js';

// messagesPerSession (off by default) caps messages to other agents over the whole session, that is, until the host
// starts a new chat. messagesPerRun alone resets at every turn, so a back-and-forth across turns escapes it.
export const DEFAULTS = { runBudgetUsd: 3, messagesPerRun: 1, messageChars: 600, messagesPerSession: null, gate: null };
// gate (off by default): an acceptance gate before the agent finishes (case study lever L6). Shape:
//   { dir, command, checks: 'checks', packages: ['a-kit', ...], rounds: 2, timeoutMs: 120000 }
// When the agent is about to settle, every package must have its own test file in <dir>/<checks>/ (named
// <package>*.test.mjs) and <command> must pass in <dir>. Otherwise the agent is told what is missing and continues,
// at most `rounds` times per turn.
const continueInField = 'Continue working without stopping or asking the user. Use leave_mark for findings and requirement traces, and read_marks to follow them.';
const MARKS = ['finding', 'claim', 'question', 'taken', 'released', 'requirement'];

// The host's messaging tool may reach Pi under a bridge name (OpenBot prefixes MCP tools) or through a generic
// `tool_call` tool that names it, so both shapes count.
export function messageCall(toolName, input) {
  const name = String(toolName || '');
  if (/(^|[._])send_message$/.test(name)) return input || {};
  if (/(^|[._])tool_call$/.test(name) && /(^|[._])send_message$/.test(String(input?.name || input?.tool || ''))) return input?.arguments || input?.args || input?.input || {};
  return null;
}
const messageText = args => String(args?.message ?? args?.text ?? args?.content ?? args?.body ?? '');

export function createBioSwarm({ cwd = process.cwd(), now = () => Date.now(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const marker = join(cwd, '.bioswarm');
  return pi => {
    if (!existsSync(marker)) return;
    let settings = {};
    try { const text = readFileSync(marker, 'utf8').trim();settings = text ? JSON.parse(text) : {}; } catch { settings = {}; }
    const remote = { apiUrl: env.BIOSWARM_API_URL || settings.apiUrl, apiKey: env.BIOSWARM_API_KEY, cacheFile: join(cwd, '.bioswarm-policy.json'), agent: basename(cwd), fetchImpl };
    const cachedPolicy = readCache(remote.cacheFile);
    let policyId = cachedPolicy?.id || 'community-0';
    const { apiUrl: _apiUrl, ...localSettings } = settings;
    let config = { ...DEFAULTS, ...mergeConfig(cachedPolicy?.rules, localSettings) };
    // Refresh the remote policy at the start of each run; never longer than the policy client's timeout.
    const refreshPolicy = async () => {
      const { policy, source } = await loadPolicy(remote);
      config = { ...DEFAULTS, ...mergeConfig(policy.rules, localSettings) };
      if (policy.id !== policyId || source === 'remote') log({ type: 'policy', kind: source });
      policyId = policy.id;
    };
    const pending = [];
    // The shared field lives beside the agents, in the host's shared folder when there is one (OpenBot keeps
    // agents in <root>/Agents/<id> and shares <root>/Shared), so every agent in BioSwarm reads the same marks.
    const hostShared = resolve(cwd, '..', '..', 'Shared');
    const fieldDir = config.field ? resolve(cwd, config.field) : existsSync(hostShared) ? join(hostShared, 'bioswarm') : join(cwd, '.bioswarm-field');
    const fieldFile = join(fieldDir, 'field.jsonl'), logFile = join(cwd, '.bioswarm-events.jsonl'), self = basename(cwd);
    mkdirSync(fieldDir, { recursive: true });
    // The log holds kinds, tool names, counts and costs, never text, paths of the host or message content.
    const log = event => {
      const entry = { at: now(), ...event };
      if (event.type !== 'decision') {
        pending.push(entry);
        if (pending.length > 500) pending.shift();
      }
      try { appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch {}
    };
    const marks = () => { try { return readFileSync(fieldFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
    // A file is taken while its latest taken/released mark is a taken one left by another agent.
    const waveDir = settings.waveDir ? resolve(cwd,settings.waveDir) : join(fieldDir,'waves');
    const coordinated = () => config.waitForTrace===true || config.tieBreak==='hash';
    const appendMark = mark => {
      appendFileSync(fieldFile,JSON.stringify({...mark,by:self,at:now()})+'\n');
      log({type:'mark',kind:mark.kind, ...(mark.class ? {wave:mark.wave,check:mark.check,class:mark.class} : {})});
    };
    const deny=(rule,reason)=>{log({type:'rule',rule});return {block:true,reason};};
    const takenByOthers = () => { const last = new Map();for (const mark of marks()) if (mark.kind === 'taken' || mark.kind === 'released') last.set(mark.place, mark);return [...last.values()].filter(mark => mark.kind === 'taken' && mark.by !== self).map(mark => mark.place); };
    // gateRounds lives outside `run`: a continuation the gate requests starts a new low-level run (agent_start), and a
    // counter kept in `run` would reset there and loop forever. It resets only when the agent really settles.
    let run = null, sessionMessages = 0, gateRounds = 0;
    const startRun = () => { run = { cost: 0, messages: 0, held: null, over: false };return run; };

    pi.registerTool({
      name: 'leave_mark', label: 'Leave a mark',
      description: 'Leave a typed mark on a place of the work (a file or a topic) in the field that every agent in BioSwarm reads. Use it instead of a message to another agent: a finding, a claim, a question, an addressed requirement (absolute file path in place and agent id in to), or taken/released to hold a file while you change it.',
      promptSnippet: 'Leave a mark (finding, claim, question, taken, released) in the shared field instead of messaging another agent',
      parameters: Type.Object({ kind: Type.Union(MARKS.map(kind => Type.Literal(kind))), place: Type.String(), text: Type.String(), to: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const place = isAbsolute(params.place) || /[/\\.]/.test(params.place) ? resolve(cwd, params.place.replace(/^@/, '')) : params.place;
        let address={};
        if(params.kind==='requirement'){
          const wave=currentWave(waveDir), check=checkAt(wave,cwd,params.place);
          if(!check || !wave.team.includes(self) || !wave.team.includes(params.to) || self===params.to || !params.text.trim())
            throw Error('A requirement needs an active check, a team sender, a different team recipient and a nonempty requirement.');
          address={to:params.to,run:wave.run,wave:wave.wave,generation:check.generation,
            ...(wave.coordination === 'scoped-v1' ? {check:check.id,class:check.class} : {})};
        }
        appendMark({kind:params.kind,place,text:params.text.slice(0,2000),...address});
        return { content: [{ type: 'text', text: `Mark (${params.kind}) left on ${params.place}.` }], details: {} };
      },
    });
    pi.registerTool({
      name: 'read_marks', label: 'Read marks',
      description: 'Read the marks other agents left in the shared field, optionally only those on one place.',
      promptSnippet: 'Read the shared field before asking another agent',
      parameters: Type.Object({ place: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const wanted = params.place ? resolve(cwd, params.place) : null;
        const found = marks().filter(mark => !wanted || mark.place === wanted || mark.place === params.place).slice(-40);
        log({ type: 'read_marks', count: found.length });
        return { content: [{ type: 'text', text: found.length ? found.map(mark => `[${mark.kind}] ${mark.place} (${mark.by}${mark.to ? " → "+mark.to : ""}): ${mark.text}`).join('\n') : 'No marks yet.' }], details: {} };
      },
    });

    pi.registerTool({
      name:'coordination_status', label:'Check work assignment', description:'Read the current check, assigned writer and trace status for each managed file. Send an addressed requirement to the assigned writer through leave_mark.',
      parameters:Type.Object({}),
      async execute(){
        if(!coordinated())return {content:[{type:'text',text:'Wave coordination is off.'}],details:{}};
        const wave=currentWave(waveDir), field=marks();
        const checks=wave.checks.map(c=>{
          const {agent,fallback}=assignment(wave,c,config);
          const requirementReceived = field.some(m => matchesTrace(m, wave, c, agent));
          const status = {place:join(wave.root,c.place),check:c.id,assigned:agent,fallback,requirementReceived};
          if (wave.coordination === 'scoped-v1') {
            status.class = c.class;
            status.traceRequired = traceRequired(wave, c, config);
            status.priority = requirementReceived;
          }
          return status;
        });
        return {content:[{type:'text',text:JSON.stringify({wave:wave.wave,checks})}],details:{}};
      }
    });
    pi.on('agent_start', async () => { startRun();log({ type: 'run_start' });await refreshPolicy(); });
    pi.on('agent_before_settle', async event => {
      const g = config.gate;if (!g?.dir) return undefined;
      if (gateRounds >= (g.rounds ?? 2)) { log({ type: 'rule', rule: 'gate_gave_up' });return undefined; }
      const checksDir = join(g.dir, g.checks || 'checks'), files = existsSync(checksDir) ? readdirSync(checksDir).filter(f => f.endsWith('.test.mjs')) : [];
      const missing = (g.packages || []).filter(pkg => !files.some(f => f.startsWith(pkg)));
      const r = spawnSync('sh', ['-c', g.command || 'node --test'], { cwd: g.dir, encoding: 'utf8', timeout: g.timeoutMs || 120000 });
      const passed = r.status === 0 && !missing.length;
      log({ type: passed ? 'gate_pass' : 'rule', ...(passed ? {} : { rule: 'accept_gate' }), missing: missing.length, exit: r.status });
      if (passed) return undefined;
      gateRounds += 1;
      const tail = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /not ok|fail|Error|expected|actual/i.test(l)).slice(0, 30).join('\n');
      const content = `BioSwarm acceptance gate: o trabalho ainda não pode ser dado como pronto.${missing.length ? `\nFaltam testes próprios em ${g.checks || 'checks'}/ para: ${missing.join(', ')}. Para cada pacote, escreva ${g.checks || 'checks'}/<pacote>.test.mjs cobrindo TODO o contrato do TASK.md (não só os defeitos relatados).` : ''}${r.status !== 0 ? `\n\`${g.command}\` falhou:\n${tail || '(sem detalhe)'}` : ''}\nCorrija e rode de novo antes de responder.`;
      return { entries: [...event.entries, { type: 'custom_message', customType: 'bioswarm-accept-gate', content, display: false }], continue: true };
    });
    pi.on('agent_settled', async () => { gateRounds = 0; if (run) log({ type: 'run_end', costUsd: Number(run.cost.toFixed(6)), messages: run.messages, over: run.over });run = null;
      const batch = pending.splice(0);void sendEvents({ apiUrl: remote.apiUrl, apiKey: remote.apiKey, agent: remote.agent, policyId, events: batch, fetchImpl }); });
    pi.on('message_end', async event => {
      if (event.message?.role !== 'assistant') return;
      const current = run || startRun();current.cost += event.message.usage?.cost?.total || 0;
      if (!current.over && current.cost > config.runBudgetUsd) { current.over = true;log({ type: 'rule', rule: 'run_budget', costUsd: Number(current.cost.toFixed(6)) }); }
    });

    pi.on('tool_call', async event => {
      const current = run || startRun();
      log({ type: 'tool', tool: event.toolName });
      // The spending ceiling: once a run has spent its budget, no further tool runs; the agent has to answer.
      if (current.over) return { block: true, terminate: true, reason: `This request has used its budget of US$ ${config.runBudgetUsd}. Stop here and answer with what you have, saying what is left.` };
      const message = messageCall(event.toolName, event.input);
      if (message) {
        if (config.messagesPerSession != null && sessionMessages >= config.messagesPerSession) { log({ type: 'rule', rule: 'session_ceiling' });return { block: true, reason: `This task already used its ${config.messagesPerSession} message(s) to other agents in BioSwarm. ${continueInField}` }; }
        if (current.messages >= config.messagesPerRun) { log({ type: 'rule', rule: 'message_ceiling' });return { block: true, reason: `Only ${config.messagesPerRun} message to other agents per request in BioSwarm. ${continueInField}` }; }
        if (messageText(message).length > config.messageChars) { log({ type: 'rule', rule: 'message_pointer' });return { block: true, reason: `Messages to other agents carry a pointer, not the context: at most ${config.messageChars} characters. Put the detail in a mark (leave_mark) and send a short message that names it.` }; }
        current.messages += 1;sessionMessages += 1;log({ type: 'message_sent' });
      }
      if(coordinated()){
        if (message || ['leave_mark','read_marks','coordination_status','read','ls','find','grep'].includes(event.toolName)) return undefined;
        if (!['edit','write'].includes(event.toolName)) return deny('unscoped_tool','Use a scoped Pi write or edit for managed files. Continue using the field.');
        try {
          const wave=currentWave(waveDir), check=checkAt(wave,cwd,event.input?.path);
          const scoped = wave.coordination === 'scoped-v1';
          const recordDecision = (outcome, rule) => {
            if (scoped) log({type:'decision',tool:event.toolName,wave:wave.wave,check:check?.id ?? null,
              class:check?.class ?? null,outcome,rule});
          };
          const refuse = (rule, reason, outcome = 'refused') => {
            recordDecision(outcome, rule);
            return deny(rule, reason);
          };
          if (!check || !validDestination(wave,check))
            return refuse('unassigned_place','The runner has no active check for this writable file. Read coordination_status and continue in the field.');
          if (takenByOthers().includes(join(wave.root,check.place)))
            return refuse('taken_place','This file is currently taken. Continue working through the field.');
          const {agent,fallback}=assignment(wave,check,config);
          const sharedWriter = scoped && agent === null && check.owners.includes(self);
          if(agent!==self && !sharedWriter){
            const contender = check.class === 'dispute' && config.tieBreak === 'hash' && check.owners.includes(self) && !fallback;
            // The scoped trace experiment restricts yield marks to contenders. Hash alone
            // uses the 0.2 contract: every non-writing teammate yields once to the writer.
            if (scoped && config.waitForTrace === true && !contender)
              return refuse('unassigned_place','This file has another writer. Continue with your assigned work.');
            if(wave.team.includes(self) && !marks().some(m=>m.kind==='yielded' && m.by===self && m.run===wave.run && m.wave===wave.wave && m.generation===check.generation))
              appendMark({kind:'yielded',place:join(wave.root,check.place),run:wave.run,wave:wave.wave,generation:check.generation,to:agent,text:'Yielded this check.',
                ...(scoped ? {check:check.id,class:check.class} : {})});
            return refuse('yielded_place','Another actor owns this check. Continue through the field; publish an addressed requirement if you hold one.','yielded');
          }
          if(traceRequired(wave,check,config) && !marks().some(m=>matchesTrace(m,wave,check,self)))
            return refuse('wait_for_trace','An addressed requirement from another team member is needed. Read the field and continue with other work.');
          recordDecision('allowed', null);
          if(fallback)log({type:'rule',rule:'stalled_check_reassigned'});
          return undefined;
        } catch {return deny('wave_unavailable','The local wave or managed file is unavailable. Continue in the field until the runner publishes a valid wave.');}
      }
      // Before the first tool of a run, remember what the files taken by other agents hold.
      if (!current.held) { current.held = new Map();for (const file of takenByOthers()) if (isAbsolute(file)) current.held.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null); }
      return undefined;
    });
    // The rule on the outcome: a taken file that changed, by any tool including the shell, is put back.
    pi.on('tool_result', async event => {
      if (!run?.held?.size) return undefined;
      const undone = [];
      for (const [file, text] of run.held) {
        const nowText = existsSync(file) ? readFileSync(file, 'utf8') : null;
        if (nowText !== text) { if (text === null) rmSync(file, { force: true });else { mkdirSync(dirname(file), { recursive: true });writeFileSync(file, text); }undone.push(basename(file)); }
      }
      if (!undone.length) return undefined;
      log({ type: 'rule', rule: 'taken_undone', files: undone.length });
      return { content: [...(event.content || []), { type: 'text', text: `${undone.join(', ')} is taken by another agent, so the change was undone. Work elsewhere or leave a mark.` }], isError: true };
    });
    log({ type: 'session', config: { runBudgetUsd: config.runBudgetUsd, messagesPerRun: config.messagesPerRun, messageChars: config.messageChars, messagesPerSession: config.messagesPerSession, gate: Boolean(config.gate) } });
  };
}

export default createBioSwarm();
