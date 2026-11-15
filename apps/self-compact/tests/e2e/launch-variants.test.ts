/**
 * The three launch commands from the Definition of Done, /self-compact-info without an LLM turn,
 * the --compact-prompt literal, invalid settings, and the untouched built-in /compact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RpcClient, eventsOfType, messageText, type RpcEvent } from "../harness/rpc-client.ts";
import { DEFAULT_FAKE_ENV, makeTestDir, scriptedArgs } from "../harness/env.ts";

const LITERAL_PROMPT = "Summarize the current goal, completed work, exact paths, test results, and next action. Do not invent completed work.";

async function info(client: RpcClient): Promise<{ text: string; events: RpcEvent[] }> {
	const since = client.mark();
	const response = await client.request({ type: "prompt", message: "/self-compact-info" });
	assert.equal(response.success, true, JSON.stringify(response));
	const notify = await client.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /^self-compact info/.test(String(e.message)), 20_000, { since });
	return { text: String(notify.message), events: client.events.slice(since) };
}

test("launch 1: defaults on a 1M model resolve to 100k / 200k / 300k (10% / 20% / 30%); info starts no LLM turn", async () => {
	const t = makeTestDir("launch-defaults");
	const client = new RpcClient({
		args: scriptedArgs(t),
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_WINDOW: "1000000" },
		logFile: t.logFile,
	});
	try {
		const { text, events } = await info(client);
		assert.match(text, /noticeAt 10% \(default\), warningAt 20% \(default\), --compact-buffer 10% \(default, warning \+ buffer\), --compact-prompt unset/);
		assert.match(text, /window 1,000,000 tokens, cap 900,000/);
		assert.match(text, /resolved: soft 100,000 \(10\.0%\), warning 200,000 \(20\.0%\), buffer 100,000, forced 300,000 \(30\.0%\)/);
		assert.match(text, /prompts: soft .*USER_PROMPT_SOFT_SELF_COMPACT\.md \(\d+ chars\), warning .*USER_PROMPT_WARNING_SELF_COMPACT\.md \(\d+ chars\), compaction additional instructions .*USER_PROMPT_COMPACTION_MESSAGE\.md \(\d+ chars\)/);
		assert.match(text, /state: level (idle|unknown), tools unlocked, handoff none, attempts 0/);
		assert.match(text, /cycles completed: 0/);
		assert.equal(eventsOfType(events, "agent_start").length, 0, "no LLM turn for /self-compact-info");
		assert.doesNotMatch(text, /REJECTED/);
	} finally {
		await client.close();
	}
});

test("launch 2: 100k / 200k / 50k on a 1M model -> 10% / 20% / 25% markers", async () => {
	const t = makeTestDir("launch-tokens");
	const client = new RpcClient({
		args: scriptedArgs(t, ["--compact-soft-at", "100k", "--compact-at", "200k", "--compact-buffer", "50k"]),
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_WINDOW: "1000000" },
		logFile: t.logFile,
	});
	try {
		const { text, events } = await info(client);
		assert.match(text, /noticeAt 100k \(flag\), warningAt 200k \(flag\), --compact-buffer 50k \(flag, warning \+ buffer\)/);
		assert.match(text, /resolved: soft 100,000 \(10\.0%\), warning 200,000 \(20\.0%\), buffer 50,000, forced 250,000 \(25\.0%\)/);
		assert.ok(text.includes("[-~-!|---------------]"), `bar markers moved to 10/20/25: ${text}`);
		assert.equal(eventsOfType(events, "agent_start").length, 0);
	} finally {
		await client.close();
	}
});

test("launch 3: 20% / 50% / 0 with --compact-prompt: zero buffer, literal additional instructions, native /compact", async () => {
	const t = makeTestDir("launch-percent-prompt");
	const client = new RpcClient({
		args: scriptedArgs(t, ["--compact-soft-at", "20%", "--compact-at", "50%", "--compact-buffer", "0", "--compact-prompt", LITERAL_PROMPT]),
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_TRACE: t.traceFile },
		logFile: t.logFile,
	});
	try {
		const first = await info(client);
		assert.match(first.text, /--compact-prompt set \(\d+ chars\)/);
		assert.match(first.text, /resolved: soft 40,000 \(20\.0%\), warning 100,000 \(50\.0%\), buffer 0, forced 100,000 \(50\.0%\)/);
		assert.ok(first.text.includes("[---~-----|----------]"), `zero buffer shows a single | : ${first.text}`);
		assert.match(first.text, /compaction additional instructions flag \(\d+ chars\)/);

		await client.request({ type: "prompt", message: "Start the scripted work." });
		const handoff = await client.waitFor((e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "self-compact-handoff", 60_000);
		await client.waitFor((e) => e.type === "agent_settled", 60_000, { since: client.events.indexOf(handoff) });
		const summaries = () => readFileSync(t.traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; systemPrompt?: string; userPrompt?: string }).filter(item => item.kind === "summary");
		const selfSummaries = summaries();
		// Durable user-role guidance can split Pi's retained turn, which uses a second
		// summarizer request for the turn prefix. It is still one compaction.
		assert.equal(client.events.filter(e => e.type === "compaction_end").length, 1);
		assert.ok(selfSummaries.length === 1 || selfSummaries.length === 2);
		assert.match(selfSummaries[0]!.systemPrompt!, /^You are a context summarization assistant/);
		assert.ok(selfSummaries[0]!.userPrompt!.includes(`Additional focus: ${LITERAL_PROMPT}`));

		// Add enough fresh material for another native compaction.
		const since = client.mark();
		await client.request({ type: "prompt", message: "New history. ".repeat(1000) });
		await client.waitFor(e => e.type === "agent_settled", 10000, { since });
		// Built-in /compact keeps Pi's native prompt and ignores --compact-prompt.
		const compact = await client.request({ type: "compact" }, 60_000);
		assert.equal(compact.success, true, JSON.stringify(compact));
		const data = compact.data as { summary?: string; details?: Record<string, unknown> };
		assert.match(data.summary ?? "", /FAKE-SUMMARY\[You are a context summarization assistant/);
		assert.equal(data.details?.selfCompact, undefined);
		const nativeSummaries = summaries().slice(selfSummaries.length);
		assert.ok(nativeSummaries.length > 0);
		for (const summary of nativeSummaries) {
			assert.match(summary.systemPrompt!, /^You are a context summarization assistant/);
			assert.doesNotMatch(summary.userPrompt!, /Additional focus:/);
		}
		assert.equal(eventsOfType(client.events, "message_end").filter((e) => (e.message as { customType?: string })?.customType === "self-compact-handoff").length, 1, "native /compact does not return the old note again");
		const after = await info(client);
		assert.match(after.text, /handoff done/);
	} finally {
		await client.close();
	}
});

test("invalid settings are rejected: info reports it and every tool is blocked", async () => {
	const cases: Array<{ name: string; flags: string[]; pattern: RegExp }> = [
		{ name: "reject-cap", flags: ["--compact-at", "95%"], pattern: /REJECTED: Invalid --compact-at: "95%" is above the 90% hard cap/ },
		{ name: "reject-order", flags: ["--compact-soft-at", "60%", "--compact-at", "50%"], pattern: /REJECTED: Invalid thresholds: --compact-soft-at \(60%\) must not exceed --compact-at \(50%\)/ },
		{ name: "reject-syntax", flags: ["--compact-buffer", "lots"], pattern: /REJECTED: Invalid --compact-buffer: "lots"/ },
		{ name: "reject-mixed", flags: ["--compact-soft-at", "60%", "--compact-at", "500k"], pattern: /REJECTED: Invalid --compact-at: 500k \(500000 tokens\) exceeds the 90% cap/ },
	];
	for (const c of cases) {
		const t = makeTestDir(c.name);
		// Bounded fake: with every tool blocked the scripted agent would otherwise retry forever.
		const client = new RpcClient({ args: scriptedArgs(t, c.flags), cwd: t.dir, env: { ...DEFAULT_FAKE_ENV, SC_FAKE_MAX_STEPS: "2", SC_FAKE_TRACE: t.traceFile }, logFile: t.logFile });
		try {
			const { text } = await info(client);
			assert.match(text, c.pattern, `${c.name}: ${text}`);
			const since = client.mark();
			await client.request({ type: "prompt", message: "Start the scripted work." });
			const blocked = await client.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000, { since });
			assert.equal(blocked.isError, true, `${c.name}: tool blocked`);
			assert.match(messageText(blocked.result), /rejected its settings/, `${c.name}: reason names the rejection (got: ${messageText(blocked.result).slice(0, 120)})`);
			await client.waitFor((e) => e.type === "agent_settled", 30_000, { since });
		} finally {
			await client.close();
		}
	}
});

test("commands: self-compact-info and self-compact-now are registered; built-in /compact is untouched", async () => {
	const t = makeTestDir("commands");
	const client = new RpcClient({ args: scriptedArgs(t), cwd: t.dir, env: DEFAULT_FAKE_ENV, logFile: t.logFile });
	try {
		const response = await client.request({ type: "get_commands" });
		const names = ((response.data as { commands?: Array<{ name: string; source: string }> })?.commands ?? []).filter((c) => c.source === "extension").map((c) => c.name);
		assert.ok(names.includes("self-compact-info"), names.join(","));
		assert.ok(names.includes("self-compact-now"), names.join(","));
		assert.ok(!names.includes("compact"), "no extension command shadows the built-in /compact");
	} finally {
		await client.close();
	}
});
