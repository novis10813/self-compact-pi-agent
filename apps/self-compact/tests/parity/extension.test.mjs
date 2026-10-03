import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Hermetic agent dir: SettingsManager merges the agent-dir (global) settings under the project's
// .pi settings, so pin the global half to an empty config to keep compaction resolution
// (keepRecentTokens, modelOverrides, retry) fully project-controlled regardless of the machine.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'self-compact-agent-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');

const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { loadExtensions } = await import(pathToFileURL(join(globalModules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
// Pi's own compaction machinery: the harness precheck must track what prepareCompaction actually does.
const { prepareCompaction } = await import(pathToFileURL(join(globalModules, '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js')));
const entry = resolve('extensions/self-compact/self-compact.ts');

function seedEntries(chars = 2000) {
  // A minimal real-shaped branch: one finished turn plus the current user prompt, so Pi's cut-point
  // arithmetic (the same one prepareCompaction uses) finds material to summarize.
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return [
    { type: 'message', id: 'seed-1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'seed prompt '.repeat(chars / 12), timestamp: 1 } },
    { type: 'message', id: 'seed-2', parentId: 'seed-1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'seed answer '.repeat(chars / 12) }], api: 'openai-completions', provider: 'fake', model: 'parity-model', usage, stopReason: 'stop', timestamp: 2 } },
    { type: 'message', id: 'seed-3', parentId: 'seed-2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'current prompt', timestamp: 3 } },
  ];
}

async function host(t, flags = {}, settings = { compaction: { keepRecentTokens: 100 } }, model) {
  const cwd = mkdtempSync(join(tmpdir(), 'self-compact-parity-'));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(settings));
  const loaded = await loadExtensions([entry], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const entries = seedEntries(), messages = [], notices = [], compactions = [], requests = [];
  const footerCalls = [], statusCalls = [];
  let tokens = 0;
  let lastEntryId = entries[entries.length - 1].id;
  for (const [key, value] of Object.entries({ 'compact-soft-at': '20%', 'compact-at': '50%', 'compact-buffer': '10%', ...flags })) loaded.runtime.flagValues.set(key, value);
  // Appended entries join the session tree (real Pi chains every entry off the leaf), so the raw
  // branch returned by getBranch() walks through them.
  loaded.runtime.appendEntry = (customType, data) => {
    const entry = { type: 'custom', customType, data, id: `custom-${entries.length}`, parentId: lastEntryId };
    entries.push(entry);
    lastEntryId = entry.id;
  };
  loaded.runtime.sendMessage = (message, options) => messages.push({ ...message, options });
  const ctx = {
    cwd, mode: 'tui', hasUI: true, thinkingLevel: 'off',
    model: model ?? { id: 'parity-model', provider: 'fake', contextWindow: 200000, maxTokens: 8192, api: 'openai-completions', reasoning: true },
    sessionManager: { getBranch: () => entries },
    getContextUsage: () => ({ tokens, contextWindow: ctx.model.contextWindow, percent: tokens === null ? null : tokens / ctx.model.contextWindow * 100 }),
    isIdle: () => true,
    compact: options => compactions.push(options),
    ui: { notify: (message, type) => notices.push({ message, type }), setFooter: (...args) => footerCalls.push(args), setStatus: (...args) => statusCalls.push(args) },
    modelRegistry: { complete: async (_model, request, options) => {
      requests.push({ request, options });
      return { role: 'assistant', api: 'openai-completions', provider: 'fake', model: 'parity-model', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'Verified summary.' }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  t.after(async () => { await emit('session_shutdown'); rmSync(cwd, { recursive: true, force: true }); });
  await emit('session_start', { reason: 'start' });
  return {
    ctx, entries, messages, notices, compactions, requests, emit,
    setBranch: next => {
      entries.length = 0;
      for (const entry of next) entries.push(entry);
      lastEntryId = next.length ? next[next.length - 1].id : null;
    },
    usage: value => { tokens = value; },
    prompt: (kind, text) => {
      const dir = join(cwd, '.pi/self-compact');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `USER_PROMPT_${kind}.md`), text);
    },
    execute: (note = 'NEXT ACTION: continue', signal) => extension.tools.get('self_compact').definition.execute('call', { note_to_self: note }, signal, undefined, ctx),
    view: () => extension.tools.get('view_context').definition.execute('view', {}, undefined, undefined, ctx),
    info: () => extension.commands.get('self-compact-info').handler('', ctx),
    footerCalls, statusCalls,
  };
}

function summaryEvent(overrides = {}) {
  return {
    reason: 'manual', signal: new AbortController().signal,
    preparation: {
      messagesToSummarize: [{ role: 'user', content: 'Implement parser. Tests remain pending.', timestamp: 1 }],
      turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: 'keep', tokensBefore: 80000,
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1500 },
      fileOps: { read: new Set(['README.md']), written: new Set(['parser.ts']), edited: new Set() },
      ...overrides,
    },
  };
}

// Pi's normalizeContext lifts the summarization system prompt into a leading system message,
// so the rewritten summary input lives in the user message of the request.
const summaryUserText = request => request.messages.find(message => message.role === 'user').content[0].text;

test('P1: automatic compaction cannot bypass the note, including before settlement', async t => {
  const h = await host(t);
  for (const reason of ['threshold', 'overflow']) assert.deepEqual(await h.emit('session_before_compact', { reason }), { cancel: true });
  assert.equal((await h.emit('tool_call', { toolName: 'read' })).block, true);
  await h.execute();
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'threshold' }), { cancel: true });
  await h.emit('session_compact_failed', { reason: 'threshold', aborted: true });
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data.handoff.status, 'pending');
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 1);
  const result = await h.emit('session_before_compact', summaryEvent());
  assert.ok(result.compaction);
  assert.equal(h.requests[0].options.reasoningEffort, 'low');
});

test('P1: final-answer crossing requests one follow-up, soft advice does not', async t => {
  const h = await host(t);
  h.usage(45000);
  await h.emit('agent_end');
  assert.equal(h.messages.length, 0);
  h.usage(110000);
  await h.emit('agent_end');
  await h.emit('agent_end');
  assert.equal(h.messages.filter(message => message.options?.triggerTurn).length, 1);
  await h.execute();
  await h.emit('agent_end');
  assert.equal(h.messages.length, 1);
});

test('P3: context refreshes one live guidance message and supports harness templates', async t => {
  const h = await host(t);
  h.prompt('SOFT_SELF_COMPACT', '{{context_tokens}} / {{context_window}} ({{context_percent}}%). {{remaining_tokens}} remain, warn {{warning_percent}}%.');
  h.usage(40000);
  const first = await h.emit('context', { messages: [] });
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content, /40,000 \/ 200,000 \(20.0%\).*160,000 remain, warn 50.0%/);
  h.usage(44000);
  const second = await h.emit('context', first);
  assert.equal(second.messages.length, 1);
  assert.match(second.messages[0].content, /44,000.*22.0%/);
  h.prompt('SOFT_SELF_COMPACT', 'UPDATED {{context_tokens}}');
  assert.match((await h.emit('context', second)).messages[0].content, /UPDATED 44,000/);
});

test('P3: tool preflight, turn boundary, and model change enforce newly crossed hard cutoff', async t => {
  for (const boundary of ['tool_call', 'turn_end', 'model_select']) {
    const h = await host(t);
    h.usage(120000);
    await h.emit(boundary, { toolName: 'external_tool' });
    assert.equal((await h.emit('tool_call', { toolName: 'external_tool' })).block, true);
  }
});

test('P2: invalid prompt files report errors without replacing the operator input silently', async t => {
  const h = await host(t);
  h.prompt('SOFT_SELF_COMPACT', '  ');
  h.usage(45000);
  assert.equal((await h.emit('context', { messages: [] })).messages.length, 0);
  await h.emit('context', { messages: [] });
  assert.equal(h.notices.filter(notice => /Prompt file is empty/.test(notice.message)).length, 1);
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined);
  h.prompt('COMPACTION_MESSAGE', '  ');
  assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true });
  assert.equal(h.requests.length, 0);
  await h.info();
  assert.match(h.entries.at(-1).data.lines.join('\n'), /ERROR: Prompt file is empty/);
});

test('P1: aborted self_compact never saves a note', async t => {
  const h = await host(t);
  await assert.rejects(h.execute('NEXT ACTION: continue', AbortSignal.abort()), /cancelled before saving/);
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0);
});

test('extension installs no custom footer and never sets a status line', async t => {
  const h = await host(t);
  assert.equal(h.footerCalls.length, 0, 'no setFooter at initialization');
  assert.equal(h.statusCalls.length, 0, 'no setStatus at initialization');
  // TUI usage transitions: notice, warning, forced cutoff, and a model switch.
  for (const tokens of [45000, 110000, 130000]) {
    h.usage(tokens);
    await h.emit('turn_end');
  }
  await h.emit('model_select');
  assert.equal(h.footerCalls.length, 0, 'no setFooter across TUI usage transitions');
  assert.equal(h.statusCalls.length, 0, 'no setStatus across TUI usage transitions');
  // Non-TUI hosts must not receive the old status-line fallback either.
  h.ctx.mode = 'rpc';
  await h.emit('model_select');
  await h.emit('session_switch', { reason: 'switch' });
  assert.equal(h.footerCalls.length, 0, 'no setFooter in RPC mode');
  assert.equal(h.statusCalls.length, 0, 'no setStatus in RPC mode');
});

test('P2: native engine preserves split turns, previous summaries, budgets and file metadata', async t => {
  const h = await host(t, { 'compact-prompt': 'EXACT SYSTEM OVERRIDE' });
  h.prompt('SUMMARY_INSTRUCTIONS', 'USER INSTRUCTIONS: preserve evidence.');
  const event = summaryEvent({ previousSummary: 'Previous checkpoint.', isSplitTurn: true, turnPrefixMessages: [{ role: 'user', content: 'Continue parser tests.', timestamp: 2 }], settings: { reserveTokens: 1000, keepRecentTokens: 100 } });
  event.customInstructions = 'Keep the failing test name.';
  const result = await h.emit('session_before_compact', event);
  assert.ok(result.compaction);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map(({ options }) => options.maxTokens), [800, 500]);
  for (const { request, options } of h.requests) {
    assert.equal(request.systemPrompt, 'EXACT SYSTEM OVERRIDE');
    assert.equal(options.reasoningEffort, 'low');
    assert.match(summaryUserText(request), /USER INSTRUCTIONS.*preserve evidence/);
    assert.match(summaryUserText(request), /Keep the failing test name/);
    assert.doesNotMatch(summaryUserText(request), /Use this EXACT format/);
  }
  assert.match(summaryUserText(h.requests[0].request), /<previous-summary>\nPrevious checkpoint/);
  assert.match(summaryUserText(h.requests[1].request), /Continue parser tests/);
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  assert.deepEqual(result.compaction.details.readFiles, ['README.md']);
  assert.deepEqual(result.compaction.details.modifiedFiles, ['parser.ts']);
  assert.equal(result.compaction.firstKeptEntryId, 'keep');
});

test('P2: configured transport retry applies inside each summary attempt', async t => {
  const h = await host(t);
  mkdirSync(join(h.ctx.cwd, '.pi'), { recursive: true });
  writeFileSync(join(h.ctx.cwd, '.pi/settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  const complete = h.ctx.modelRegistry.complete;
  let calls = 0;
  h.ctx.modelRegistry.complete = async (...args) => {
    const response = await complete(...args);
    if (++calls === 1) return { ...response, stopReason: 'error', errorMessage: '503 Service unavailable' };
    return response;
  };
  const result = await h.emit('session_before_compact', summaryEvent());
  assert.equal(calls, 2);
  assert.equal(result.compaction.details.selfCompact.attempt, 1, 'transport retry succeeds within the first logical summary attempt');
});

test('P2: empty, truncated and tool-calling summaries never become checkpoints', async t => {
  for (const response of [
    { content: [], stopReason: 'stop' },
    { content: [{ type: 'text', text: 'Partial summary' }], stopReason: 'length' },
    { content: [{ type: 'toolCall', id: 'bad', name: 'write', arguments: {} }], stopReason: 'toolUse' },
  ]) {
    const h = await host(t);
    h.ctx.modelRegistry.complete = async () => response;
    assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true });
  }
});

test('P4: view_context returns usage, percent, and thresholds as JSON and stays allowed under the lock', async t => {
  const h = await host(t);
  h.usage(45000);
  const view = JSON.parse((await h.view()).content[0].text);
  assert.equal(view.used_tokens, 45000);
  assert.equal(view.used_percent, 22.5);
  assert.equal(view.context_window, 200000);
  assert.equal(view.level, 'notice');
  assert.deepEqual(view.thresholds, { notice: { tokens: 40000, percent: 20 }, warning: { tokens: 100000, percent: 50 }, hard_cutoff: { tokens: 120000, percent: 60 } });
  assert.equal(view.tokens_until_warning, 55000);
  assert.equal(view.tokens_until_hard_cutoff, 75000);
  assert.equal(view.tools_locked, false);
  assert.equal(view.compaction_cycles, 0);
  h.usage(125000);
  await h.emit('turn_end');
  assert.equal((await h.emit('tool_call', { toolName: 'read' })).block, true);
  assert.equal(await h.emit('tool_call', { toolName: 'view_context' }), undefined);
  const locked = JSON.parse((await h.view()).content[0].text);
  assert.equal(locked.level, 'forced');
  assert.equal(locked.tools_locked, true);
  assert.equal(locked.tokens_until_hard_cutoff, 0);
});

test('P5: nothing to compact -> self_compact refuses, no lock, no guidance', async t => {
  const h = await host(t, {}, { compaction: { keepRecentTokens: 10000000 } });
  h.usage(125000);
  await h.emit('turn_end');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'forced level does not lock when compaction is impossible');
  assert.equal((await h.emit('context', { messages: [] })).messages.length, 0, 'no guidance when there is nothing to cut');
  await assert.rejects(h.execute('NEXT ACTION: continue'), /Nothing to compact yet: Pi keeps the newest 10,000,000 tokens/);
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0, 'no note was saved');
  const view = JSON.parse((await h.view()).content[0].text);
  assert.equal(view.tools_locked, false);
});

// ------------------------------------------------------------------ phase 1: core summary fixes
// Ground truth in these tests is Pi's own prepareCompaction on the RAW branch — the same input
// agent-session.js passes (getBranch()), before any context-entry projection: the extension
// precheck and the summary call must track what the native engine actually does.

function sessionBranch(defs, prefix = 'br') {
  const entries = [];
  let prev = null;
  for (const def of defs) {
    const id = `${prefix}-${entries.length}`;
    if (def.type === 'compaction') entries.push({ type: 'compaction', id, parentId: prev, summary: def.summary, firstKeptEntryId: def.firstKept, tokensBefore: def.tokensBefore ?? 1000 });
    else if (def.type === 'context_edit') entries.push({ type: 'context_edit', id, parentId: prev, targetId: def.target, replacement: def.replacement ?? null });
    else entries.push({ type: 'message', id, parentId: prev, message: { role: def.role, content: def.content } });
    prev = id;
  }
  return entries;
}

// The oracle settings are exactly what the extension resolves from the harness .pi/settings.json
// (getCompactionSettings(model)): same keepRecentTokens (prepareCompaction's only decision input)
// and same reserveTokens. enabled is always true, as the harness never sets it.
const oracleFor = settings => ({ enabled: true, reserveTokens: settings.compaction?.reserveTokens ?? 16384, keepRecentTokens: settings.compaction?.keepRecentTokens ?? 20000 });

// Run the extension precheck (via self_compact) and assert it matches the native oracle for the
// same raw branch and resolved settings, whichever way the oracle decides.
async function assertPrecheckMatchesOracle(t, branch, settings, model) {
  const oracle = prepareCompaction(branch, oracleFor(settings));
  const h = await host(t, {}, settings, model);
  h.setBranch(branch);
  if (oracle) {
    const saved = await h.execute();
    assert.equal(saved.terminate, true, `keep ${oracleFor(settings).keepRecentTokens}: precheck finds material, as the oracle does`);
  } else {
    await assert.rejects(h.execute(), /Nothing to compact yet/);
    assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0, 'refusal saves no note');
  }
  return { oracle, host: h };
}

const compactEvent = preparation => ({ reason: 'manual', signal: new AbortController().signal, preparation });

test('P6: real split-turn preparation is recognized and summary budgets follow Pi, not a fixed 8192 cap', async t => {
  // Output cap 65536 > 8192 so Pi's 0.8x/0.5x reserveTokens budgets (26214/16384) exceed the old hard cap.
  const model = { id: 'parity-model', provider: 'fake', contextWindow: 200000, maxTokens: 65536, api: 'openai-completions', reasoning: true };
  const branch = sessionBranch([
    { role: 'user', content: 'H'.repeat(800) },
    { role: 'assistant', content: [{ type: 'text', text: 'I'.repeat(800) }] },
    { role: 'user', content: 'turn two' },
    { role: 'assistant', content: [{ type: 'text', text: 'J'.repeat(1200) }] },
    { role: 'user', content: 'end' },
  ]);
  const preparation = prepareCompaction(branch, { enabled: true, reserveTokens: 32768, keepRecentTokens: 300 });
  assert.ok(preparation, 'ground truth: Pi prepares a split-turn compaction');
  assert.equal(preparation.isSplitTurn, true);
  assert.equal(preparation.messagesToSummarize.length, 2);
  assert.equal(preparation.turnPrefixMessages.length, 1);

  const h = await host(t, {}, { compaction: { keepRecentTokens: 100 } }, model);
  h.setBranch(branch);
  const result = await h.emit('session_before_compact', compactEvent(preparation));
  assert.ok(result.compaction, 'both the <conversation> and the # Conversation turn-prefix call are recognized');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map(({ options }) => options.maxTokens), [26214, 16384], 'Pi-computed budgets are honored, not re-capped at 8192');
  assert.match(summaryUserText(h.requests[0].request), /^<conversation>/);
  assert.match(summaryUserText(h.requests[1].request), /^# Conversation/);
  assert.match(summaryUserText(h.requests[1].request), /turn two/);
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);

  // The model output cap still clamps Pi's budget; the extension must pass the clamped value through.
  const h2 = await host(t, {}, { compaction: { keepRecentTokens: 100 } }, { ...model, maxTokens: 20000 });
  h2.setBranch(branch);
  const result2 = await h2.emit('session_before_compact', compactEvent(preparation));
  assert.ok(result2.compaction);
  assert.deepEqual(h2.requests.map(({ options }) => options.maxTokens), [20000, 16384], 'model output cap clamps the budget, 8192 never re-enters');
});

test('P6: keepRecentTokens resolves through the active model like Pi getCompactionSettings', async t => {
  const settings = { compaction: { keepRecentTokens: 10000000, modelOverrides: { 'fake/parity-model': { keepRecentTokens: 50000 } } } };
  // 3 x 25k tokens: just past the 50000 override, far below the ordinary 10000000.
  const branch = sessionBranch([
    { role: 'user', content: 'a'.repeat(100000) },
    { role: 'user', content: 'b'.repeat(100000) },
    { role: 'user', content: 'c'.repeat(100000) },
  ]);
  // Matching model: the override governs the precheck, and the matching real preparation compacts end to end.
  {
    const h = await host(t, {}, settings);
    const preparation = prepareCompaction(branch, { enabled: true, reserveTokens: 32768, keepRecentTokens: 50000 });
    assert.ok(preparation, 'ground truth: material past the 50000 override');
    h.setBranch(branch);
    const saved = await h.execute();
    assert.equal(saved.terminate, true, 'matching model: precheck sees material past the override');
    assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data.handoff.status, 'pending');
    const result = await h.emit('session_before_compact', compactEvent(preparation));
    assert.ok(result.compaction);
  }
  // Non-matching model: the same branch and settings fall back to the ordinary 10000000 -> nothing to compact.
  {
    const h = await host(t, {}, settings, { id: 'other-model', provider: 'fake', contextWindow: 200000, maxTokens: 8192, api: 'openai-completions', reasoning: true });
    assert.equal(prepareCompaction(branch, { enabled: true, reserveTokens: 32768, keepRecentTokens: 10000000 }), undefined, 'ground truth: branch fits the ordinary setting');
    h.setBranch(branch);
    await assert.rejects(h.execute(), /Nothing to compact yet: Pi keeps the newest 10,000,000 tokens/);
  }
  // Ordinary fallback: no overrides at all -> the ordinary setting applies; with no setting, the built-in default.
  {
    const h = await host(t, {}, { compaction: { keepRecentTokens: 10000000 } });
    await assert.rejects(h.execute(), /keeps the newest 10,000,000 tokens/);
  }
  {
    const h = await host(t, {}, {});
    await assert.rejects(h.execute(), /keeps the newest 20,000 tokens/);
  }
});

test('P6: repeat-compaction boundary: precheck tracks the real prepareCompaction', async t => {
  const settings = { compaction: { keepRecentTokens: 20000, reserveTokens: 32768 } };
  const keep = { enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 };
  // Material past the boundary: old history is summarized away, but the new turn is far beyond keepRecent.
  {
    const branch = sessionBranch([
      { role: 'user', content: 'a'.repeat(100000) },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(100000) }] },
      { type: 'compaction', summary: 'old work summarized', firstKept: 'br-1', tokensBefore: 50000 },
      { role: 'user', content: 'c'.repeat(100000) },
      { role: 'assistant', content: [{ type: 'text', text: 'd'.repeat(100000) }] },
    ]);
    const preparation = prepareCompaction(branch, keep);
    assert.ok(preparation, 'ground truth: material past the compaction boundary');
    assert.equal(preparation.isSplitTurn, true);
    assert.equal(preparation.previousSummary, 'old work summarized');
    const h = await host(t, {}, settings);
    h.setBranch(branch);
    const saved = await h.execute();
    assert.equal(saved.terminate, true, 'precheck agrees with the real preparation');
    const result = await h.emit('session_before_compact', compactEvent(preparation));
    assert.ok(result.compaction);
    assert.match(summaryUserText(h.requests[0].request), /<previous-summary>\nold work summarized/);
    assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  }
  // Nothing past the boundary: the branch fits keepRecent after the compaction entry.
  {
    const branch = sessionBranch([
      { role: 'user', content: 'a'.repeat(100000) },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(100000) }] },
      { type: 'compaction', summary: 'old work summarized', firstKept: 'br-1', tokensBefore: 50000 },
      { role: 'user', content: 'done' },
    ]);
    assert.equal(prepareCompaction(branch, keep), undefined, 'ground truth: nothing to compact');
    const h = await host(t, {}, settings);
    h.setBranch(branch);
    await assert.rejects(h.execute(), /Nothing to compact yet: Pi keeps the newest 20,000 tokens/);
    assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0, 'refusal saves no note');
  }
});

test('P7: leaf is a compaction entry with retained messages -> refuses (Already compacted / no material)', async t => {
  // The compaction is the leaf and its retained tail (firstKept -> leaf) still holds a real
  // message. Native /compact would answer "Already compacted"; the precheck must refuse too.
  const branch = sessionBranch([
    { role: 'user', content: 'a'.repeat(100000) },
    { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(100000) }] },
    { type: 'compaction', summary: 'old work summarized', firstKept: 'br-1', tokensBefore: 50000 },
  ]);
  for (const keepRecentTokens of [1000, 200000]) {
    assert.equal(prepareCompaction(branch, { enabled: true, reserveTokens: 32768, keepRecentTokens }), undefined,
      `ground truth: a leaf compaction is never prepared, whatever the retained tail (keep ${keepRecentTokens})`);
  }
  const settings = { compaction: { keepRecentTokens: 20000, reserveTokens: 32768 } };
  const h = await host(t, {}, settings);
  h.setBranch(branch);
  await assert.rejects(h.execute(), /Nothing to compact yet: Pi keeps the newest 20,000 tokens/);
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0, 'refusal saves no note');
});

test('P7: two consecutive compactions, older inside the retained range: precheck tracks the oracle across the boundary', async t => {
  // The newer compaction (br-5) retains a range that starts BEFORE the older compaction (br-2):
  // firstKeptEntryId br-1 is before it, and br-3/br-4 after it are retained too. The native
  // projection keeps the older compaction entry inside the raw retained range but projects its
  // messages as empty, so it must contribute nothing to the summarization range.
  const branch = sessionBranch([
    { role: 'user', content: 'a'.repeat(100000) }, // br-0
    { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(100000) }] }, // br-1 (retained id before the older compaction)
    { type: 'compaction', summary: 'first pass', firstKept: 'br-1', tokensBefore: 50000 }, // br-2 (older compaction)
    { role: 'user', content: 'c'.repeat(100000) }, // br-3 (retained id after the older compaction)
    { role: 'assistant', content: [{ type: 'text', text: 'd'.repeat(100000) }] }, // br-4
    { type: 'compaction', summary: 'second pass', firstKept: 'br-1', tokensBefore: 100000 }, // br-5 (newer compaction)
    { role: 'user', content: 'e'.repeat(100000) }, // br-6
    { role: 'assistant', content: [{ type: 'text', text: 'f'.repeat(100000) }] }, // br-7
  ]);

  // New material: summarized material lies on BOTH sides of the older compaction (br-1 before, br-3/br-4 after).
  const materialSettings = { compaction: { keepRecentTokens: 20000, reserveTokens: 32768 } };
  const material = prepareCompaction(branch, oracleFor(materialSettings));
  assert.ok(material, 'ground truth: material on both sides of the older compaction');
  assert.equal(material.isSplitTurn, true);
  assert.equal(material.previousSummary, 'second pass');
  assert.equal(material.messagesToSummarize.length, 3, 'the older compaction contributes no messages');
  assert.equal(material.turnPrefixMessages.length, 1);

  // No material: the whole retained range fits keepRecent.
  assert.equal(prepareCompaction(branch, oracleFor({ compaction: { keepRecentTokens: 150000, reserveTokens: 32768 } })), undefined,
    'ground truth: retained range fits keepRecent, nothing to compact');

  // Sweep keepRecentTokens across the boundary: the precheck must match the oracle in both directions.
  const verdicts = new Set();
  for (const keepRecentTokens of [20000, 40000, 75000, 100000, 120000, 150000]) {
    const { oracle } = await assertPrecheckMatchesOracle(t, branch, { compaction: { keepRecentTokens, reserveTokens: 32768 } });
    verdicts.add(!!oracle);
  }
  assert.deepEqual([...verdicts].sort(), [false, true], 'sweep crossed the boundary in both directions');

  // And the material preparation really compacts end to end.
  const { host: h } = await assertPrecheckMatchesOracle(t, branch, materialSettings);
  const result = await h.emit('session_before_compact', compactEvent(material));
  assert.ok(result.compaction);
  assert.match(summaryUserText(h.requests[0].request), /<previous-summary>\nsecond pass/);
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
});

test('P7: recovery omission (context_edit null) is invisible to the precheck, as to the oracle', async t => {
  // A failed assistant attempt (br-3) is omitted from model context by a recovery context_edit.
  // The native projection drops it from the token walk; keeps around the boundary must produce
  // the same precheck verdict as the oracle - including keeps (75000) where the omitted attempt
  // alone would push a naive token count across the boundary.
  const branch = sessionBranch([
    { role: 'user', content: 'a'.repeat(100000) },
    { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(100000) }] },
    { role: 'user', content: 'c'.repeat(100000) },
    { role: 'assistant', content: [{ type: 'text', text: 'd'.repeat(100000) }] },
    { type: 'context_edit', target: 'br-3' },
  ]);
  const verdicts = new Set();
  for (const keepRecentTokens of [20000, 40000, 50000, 75000, 100000]) {
    const { oracle } = await assertPrecheckMatchesOracle(t, branch, { compaction: { keepRecentTokens, reserveTokens: 32768 } });
    verdicts.add(!!oracle);
  }
  assert.deepEqual([...verdicts].sort(), [false, true], 'sweep crossed the boundary in both directions');
  assert.equal(prepareCompaction(branch, oracleFor({ compaction: { keepRecentTokens: 75000, reserveTokens: 32768 } })), undefined,
    'ground truth: with the attempt omitted nothing is left to summarize at keep 75000');
});

// ------------------------------------------------------------------ phase 2: core reliability fixes
// Two failure classes change the extension's response to a compaction failure:
//  - Deterministic errors (token cap, unrecognized summary input) repeat identically with the
//    same parameters: the in-loop summary attempts stop early, the actual attempt count is
//    reported, and the scheduled auto-retry is skipped — the operator must change model/settings.
//  - A manual, non-aborted "nothing to compact" failure self-heals ONLY when the native
//    precheck confirms there is no material AND the fresh usage percent is nonnull and below
//    warning: the note is then delivered as is without counting a compaction cycle.

const lastState = h => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// A branch with material at keep 100, and one that fits entirely inside keep 100 (oracle-verified below).
const materialBranch = () => sessionBranch([
  { role: 'user', content: 'H'.repeat(800) },
  { role: 'assistant', content: [{ type: 'text', text: 'I'.repeat(800) }] },
  { role: 'user', content: 'end' },
]);
const smallBranch = () => sessionBranch([{ role: 'user', content: 'done' }]);
const K100 = { compaction: { keepRecentTokens: 100 } };

test('P8: "Nothing to compact" is still a failure while material remains, usage is high, or usage is unknown', async t => {
  assert.ok(prepareCompaction(materialBranch(), oracleFor(K100)), 'ground truth: material remains');
  assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  const noCompactFailure = h => h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'Nothing to compact' });
  // Material remains (the oracle agrees) and usage is low: the precheck veto, no self-heal.
  {
    const h = await host(t, {}, K100);
    h.setBranch(materialBranch());
    await h.execute();
    await h.emit('agent_settled');
    await noCompactFailure(h);
    const state = lastState(h);
    assert.equal(state.handoff.status, 'failed');
    assert.equal(state.locked, true);
    assert.equal(state.cycle, 0);
    assert.equal(h.messages.length, 0, 'no note delivery while material remains');
  }
  // High usage though nothing to compact: the fresh percent is above the warning line.
  {
    const h = await host(t, {}, K100);
    h.setBranch(materialBranch());
    await h.execute();
    await h.emit('agent_settled');
    h.setBranch(smallBranch());
    h.usage(150000); // 75% of 200k, above the 50% warning
    await noCompactFailure(h);
    const state = lastState(h);
    assert.equal(state.handoff.status, 'failed');
    assert.equal(state.locked, true);
    assert.equal(state.cycle, 0);
    assert.equal(h.messages.length, 0, 'no note delivery at high usage');
  }
  // Unknown usage: the fresh percent is null, so below-warning cannot be confirmed.
  {
    const h = await host(t, {}, K100);
    h.setBranch(materialBranch());
    await h.execute();
    await h.emit('agent_settled');
    h.setBranch(smallBranch());
    h.usage(null);
    await noCompactFailure(h);
    const state = lastState(h);
    assert.equal(state.handoff.status, 'failed');
    assert.equal(state.locked, true);
    assert.equal(state.cycle, 0);
    assert.equal(h.messages.length, 0, 'no note delivery with unknown usage');
  }
});

test('P8: native-confirmed no-material below warning self-heals: byte-identical note, no cycle increment', async t => {
  const { host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled'); // compaction in flight for the saved note
  const branch = smallBranch();
  assert.equal(prepareCompaction(branch, oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  h.setBranch(branch);
  h.usage(10000); // 5.0% of 200k, below the 50% warning
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'Nothing to compact' });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'ready');
  assert.equal(state.handoff.error, undefined, 'error cleared');
  assert.equal(state.handoff.attempts, 0, 'no failed attempt is recorded');
  assert.equal(state.locked, false, 'tools restored');
  assert.equal(state.cycle, 0, 'self-heal is not a compaction cycle');
  assert.equal(h.messages.length, 1, 'note delivered exactly once');
  const delivered = h.messages[0];
  assert.equal(delivered.customType, 'self-compact-handoff');
  assert.equal(delivered.content, state.handoff.note, 'byte-identical note');
  assert.equal(delivered.details.note, state.handoff.note);
  assert.equal(delivered.details.cycle, 0);
  assert.equal(delivered.options.triggerTurn, true);
  // Pi journals the handoff: the transaction completes through the existing path.
  await h.emit('message_end', { message: { role: 'custom', customType: 'self-compact-handoff', details: { id: state.handoff.id } } });
  assert.equal(lastState(h).handoff.status, 'done');
  // Subsequent checks deliver no duplicate and tools stay restored.
  await h.emit('agent_settled');
  await h.emit('turn_end');
  assert.equal(h.messages.length, 1, 'no duplicate delivery after completion');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'tools restored');
});

test('P8: self-heal never fires on an arbitrary error or an abort', async t => {
  assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  // Arbitrary error: no "nothing to compact" wording -> the failed-handoff retry path, no self-heal.
  {
    const h = await host(t, {}, K100);
    h.setBranch(materialBranch());
    await h.execute();
    await h.emit('agent_settled');
    h.setBranch(smallBranch());
    h.usage(10000);
    await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'Provider returned 500' });
    const state = lastState(h);
    assert.equal(state.handoff.status, 'failed');
    assert.equal(state.handoff.error, 'Provider returned 500');
    assert.equal(state.locked, true);
    assert.equal(h.messages.length, 0, 'no self-heal on an arbitrary error');
    assert.equal(h.notices.filter(notice => /retrying automatically/.test(notice.message)).length, 1, 'transient retry path is retained');
  }
  // Aborted: even with the no-compact wording and a small context, cancellation stays a cancellation.
  {
    const h = await host(t, {}, K100);
    h.setBranch(materialBranch());
    await h.execute();
    await h.emit('agent_settled');
    h.setBranch(smallBranch());
    h.usage(10000);
    await h.emit('session_compact_failed', { reason: 'manual', aborted: true, errorMessage: 'Nothing to compact' });
    const state = lastState(h);
    assert.equal(state.handoff.status, 'failed');
    assert.equal(state.locked, true);
    assert.equal(h.messages.length, 0, 'aborts cannot self-heal');
    assert.equal(h.notices.filter(notice => /cancelled/.test(notice.message)).length, 1, 'reported as cancelled');
  }
});

test('P8: token cap is deterministic: exactly one summary attempt, no scheduled retry', async t => {
  const { oracle: preparation, host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled'); // compaction in flight for the saved note
  // Pi's token-cap answer (getSummarizationFailure on stopReason === "length").
  const base = h.ctx.modelRegistry.complete;
  h.ctx.modelRegistry.complete = async (...args) => ({ ...(await base(...args)), stopReason: 'length' });
  const result = await h.emit('session_before_compact', compactEvent(preparation));
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.requests.length, 1, 'exactly one summary attempt for the deterministic failure');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'failed');
  assert.equal(state.handoff.attempts, 1);
  assert.match(state.handoff.error, /after 1 attempt: .*generation hit the token cap/);
  assert.equal(state.locked, true, 'note kept, tools stay locked');
  assert.equal(h.compactions.length, 1, 'only the original note-saved compaction');
  assert.equal(h.notices.filter(notice => /change the model or compaction settings/.test(notice.message)).length, 1, 'operator told to change model/settings');
  assert.equal(state.handoff.retryable, false, 'deterministic failure is not eligible for any automatic retry');
  await h.emit('agent_settled');
  await h.emit('agent_settled');
  await wait(2500); // past the 2000ms retry delay for attempt 1
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 1, 'no scheduled auto-retry and no idle retry after a deterministic failure');
});

test('P8: unrecognized summary input is deterministic: exactly one summary attempt, no scheduled retry', async t => {
  const { oracle: preparation, host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled');
  // Pi's summary-input validation answer (replaceInstructions throws the same text here).
  h.ctx.modelRegistry.complete = async (...args) => {
    h.requests.push({ request: args[1], options: args[2] });
    throw new Error('Unrecognized Pi summary input; cannot replace instructions safely.');
  };
  const result = await h.emit('session_before_compact', compactEvent(preparation));
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.requests.length, 1, 'exactly one summary attempt for the deterministic failure');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'failed');
  assert.equal(state.handoff.attempts, 1);
  assert.match(state.handoff.error, /after 1 attempt: Unrecognized Pi summary input/i);
  assert.equal(h.notices.filter(notice => /deterministic/.test(notice.message)).length, 1, 'operator told auto-retry is skipped');
  await wait(2500);
  assert.equal(h.compactions.length, 1, 'no scheduled auto-retry after a deterministic failure');
});

test('P8: transient summary failure retains the original retry path', async t => {
  const { oracle: preparation, host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled');
  h.ctx.modelRegistry.complete = async (...args) => {
    h.requests.push({ request: args[1], options: args[2] });
    throw new Error('transient provider hiccup');
  };
  const result = await h.emit('session_before_compact', compactEvent(preparation));
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.requests.length, 2, 'both summary attempts run for a transient error');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'failed');
  assert.equal(state.handoff.attempts, 1);
  assert.match(state.handoff.error, /after 2 attempts: transient provider hiccup/);
  assert.equal(h.notices.filter(notice => /retrying automatically/.test(notice.message)).length, 1, 'auto-retry announced');
  await wait(2500); // retry delay for attempt 1
  assert.equal(h.compactions.length, 2, 'the scheduled auto-retry still fires');
});

test('P8: transient failure: agent_settled is still eligible for the retry, and the timer does not double-start', async t => {
  const { host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled');
  h.ctx.modelRegistry.complete = async (...args) => {
    h.requests.push({ request: args[1], options: args[2] });
    throw new Error('transient provider hiccup');
  };
  assert.deepEqual(await h.emit('session_before_compact', compactEvent(prepareCompaction(materialBranch(), oracleFor(K100)))), { cancel: true });
  assert.equal(h.requests.length, 2, 'both summary attempts run for a transient error');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'failed');
  assert.equal(state.handoff.attempts, 1);
  assert.equal(state.handoff.retryable, true, 'transient failures stay eligible for the idle retry');
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 2, 'the settled agent is still eligible to start the retry');
  await h.emit('agent_settled');
  await wait(2500); // the scheduled retry for attempt 1 fires on a handoff that is already compacting
  assert.equal(h.compactions.length, 2, 'no double-start between the idle retry and the scheduled retry');
});

test('P8: stale deterministic error does not override a fresh manual no-material failure; self-heal uses the new error', async t => {
  const { oracle: preparation, host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled'); // compaction in flight for the saved note
  // Pi's token-cap answer (getSummarizationFailure on stopReason === "length") leaves a deterministic
  // summary error behind. Without per-event consumption it would override the next failure's own error.
  const base = h.ctx.modelRegistry.complete;
  h.ctx.modelRegistry.complete = async (...args) => ({ ...(await base(...args)), stopReason: 'length' });
  assert.deepEqual(await h.emit('session_before_compact', compactEvent(preparation)), { cancel: true });
  assert.equal(h.requests.length, 1, 'deterministic failure: exactly one summary attempt');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const failed = lastState(h);
  assert.equal(failed.handoff.status, 'failed');
  assert.match(failed.handoff.error, /generation hit the token cap/);
  // The session has since shrunk below keepRecentTokens. A fresh manual /compact fails in Pi's
  // pre-prepare step — before session_before_compact runs, so the stale error would leak in without
  // consumption — with its own "Nothing to compact" answer.
  h.setBranch(smallBranch());
  h.usage(10000); // 5.0% of 200k, below the 50% warning
  assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' });
  const state = lastState(h);
  assert.equal(state.handoff.status, 'ready', 'self-heal fires on the fresh no-material error, not the stale token-cap error');
  assert.equal(state.handoff.error, undefined, 'the stale error is gone');
  assert.equal(state.handoff.attempts, 1, 'only the real failed attempt is recorded');
  assert.equal(state.locked, false, 'tools restored');
  assert.equal(state.cycle, 0, 'self-heal is not a compaction cycle');
  assert.equal(h.messages.length, 1, 'note delivered exactly once');
  assert.equal(h.messages[0].content, failed.handoff.note, 'byte-identical note');
  assert.equal(h.messages[0].options.triggerTurn, true);
});

test('P8: explicit tool retry with a saved failed note: no material below warning returns the original note exactly once', async t => {
  const { host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  await h.emit('agent_settled');
  h.ctx.modelRegistry.complete = async () => { throw new Error('transient provider hiccup'); };
  assert.deepEqual(await h.emit('session_before_compact', compactEvent(prepareCompaction(materialBranch(), oracleFor(K100)))), { cancel: true });
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  const failed = lastState(h);
  assert.equal(failed.handoff.status, 'failed');
  const original = failed.handoff.note;
  // The session has since shrunk below keepRecentTokens; /self-compact-now tells the agent to pass the
  // saved note verbatim, which is what this call models.
  h.setBranch(smallBranch());
  h.usage(10000);
  assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  const result = await h.execute(original);
  assert.equal(result.terminate, true);
  const state = lastState(h);
  assert.equal(state.handoff.status, 'ready');
  assert.equal(state.handoff.note, original, 'byte-identical original note');
  assert.equal(state.handoff.error, undefined);
  assert.equal(state.locked, false, 'tools restored');
  assert.equal(state.cycle, 0, 'no cycle increment without real compaction');
  assert.equal(h.messages.length, 1, 'note delivered once from the tool retry');
  assert.equal(h.messages[0].content, original);
  // Exactly once: settlements and turn ends do not re-deliver; the journal completes the transaction.
  await h.emit('agent_settled');
  await h.emit('turn_end');
  assert.equal(h.messages.length, 1, 'no duplicate delivery');
  await h.emit('message_end', { message: { role: 'custom', customType: 'self-compact-handoff', details: { id: failed.handoff.id } } });
  assert.equal(lastState(h).handoff.status, 'done');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'tools stay restored');
});

test('P8: tool retry guards: high or unknown usage stays locked with a truthful message; a mismatched note never replaces the original', async t => {
  const setup = async () => {
    const { host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
    await h.emit('agent_settled');
    h.ctx.modelRegistry.complete = async () => { throw new Error('transient provider hiccup'); };
    assert.deepEqual(await h.emit('session_before_compact', compactEvent(prepareCompaction(materialBranch(), oracleFor(K100)))), { cancel: true });
    await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
    const failed = lastState(h);
    assert.equal(failed.handoff.status, 'failed');
    h.setBranch(smallBranch());
    assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
    return { h, original: failed.handoff.note };
  };
  // High usage (>= warning): the fresh percent is not below the line -> stays failed + locked, truthful message.
  {
    const { h, original } = await setup();
    h.usage(150000); // 75% of 200k, above the 50% warning
    await assert.rejects(h.execute(original), /A note is already saved .* and every tool except self_compact is blocked.*nothing to compact/s);
    const view = JSON.parse((await h.view()).content[0].text);
    assert.equal(view.tools_locked, true, 'still locked');
    assert.equal(view.pending_note.status, 'failed', 'handoff untouched');
    assert.equal(view.pending_note.chars, original.length, 'note untouched');
    assert.equal(view.compaction_cycles, 0);
    assert.equal(h.messages.length, 0, 'no delivery');
  }
  // Unknown usage: the below-warning guard cannot be confirmed -> same truthful refusal.
  {
    const { h, original } = await setup();
    h.usage(null);
    await assert.rejects(h.execute(original), /A note is already saved.*nothing to compact/s);
    const view = JSON.parse((await h.view()).content[0].text);
    assert.equal(view.tools_locked, true, 'still locked');
    assert.equal(view.pending_note.status, 'failed');
    assert.equal(h.messages.length, 0, 'no delivery');
  }
  // Mismatched note below warning: the self-heal returns the original, never the replacement.
  {
    const { h, original } = await setup();
    h.usage(10000);
    const result = await h.execute('A different note, not the saved one');
    assert.equal(result.terminate, true);
    const state = lastState(h);
    assert.equal(state.handoff.status, 'ready');
    assert.equal(state.handoff.note, original, 'replacement note was not saved');
    assert.equal(state.locked, false);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].content, original, 'the original note is what is returned');
  }
});

test('P8: pending note with no material: explicit tool retry self-heals', async t => {
  const { host: h } = await assertPrecheckMatchesOracle(t, materialBranch(), K100);
  const saved = await h.execute();
  assert.equal(saved.terminate, true);
  assert.equal(lastState(h).handoff.status, 'pending', 'note saved, compaction not started yet');
  const original = lastState(h).handoff.note;
  h.setBranch(smallBranch());
  h.usage(10000);
  assert.equal(prepareCompaction(smallBranch(), oracleFor(K100)), undefined, 'ground truth: nothing to compact');
  await h.execute(original);
  const state = lastState(h);
  assert.equal(state.handoff.status, 'ready');
  assert.equal(state.handoff.note, original);
  assert.equal(state.locked, false, 'tools restored');
  assert.equal(state.cycle, 0, 'no cycle increment without real compaction');
  assert.equal(h.messages.length, 1, 'note delivered once');
  assert.equal(h.messages[0].content, original);
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1, 'no duplicate delivery');
});
