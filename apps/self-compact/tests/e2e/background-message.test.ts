import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, eventsOfType } from "../harness/rpc-client.ts";
import { DEFAULT_FAKE_ENV, HARNESS_DIR, latestSessionFile, makeTestDir, scriptedArgs } from "../harness/env.ts";

for (const abort of [false, true]) test(
	`background message during compaction: ${abort ? "cancel and retry" : "stale response after compaction"}`,
	async () => {
		const t = makeTestDir(abort ? "background-abort" : "background-stale");
		const client = new RpcClient({
			args: ["-e", join(HARNESS_DIR, "background-message.ts"), ...scriptedArgs(t, ["--compact-soft-at", "20%", "--compact-at", "50%", "--compact-buffer", "10%"])],
			cwd: t.dir, logFile: t.logFile,
			env: { ...DEFAULT_FAKE_ENV, SC_FAKE_TRACE: t.traceFile, SC_FAKE_SUMMARY_DELAY: "300", SC_FAKE_PARALLEL_DELAY: "1200" },
		});
		try {
			await client.request({ type: "prompt", message: "Start the scripted work." });
			const task = await client.waitFor(e => e.type === "message_end" && (e.message as { customType?: string })?.customType === "task-event", 15000);
			assert.equal(eventsOfType(client.events.slice(0, client.events.indexOf(task)), "compaction_end").length, 0, "message arrived before compaction finished");
			if (abort) await client.request({ type: "abort" });
			const handoff = await client.waitFor(e => e.type === "message_end" && (e.message as { customType?: string })?.customType === "self-compact-handoff", 15000);
			await client.waitFor(e => e.type === "tool_execution_end" && e.toolName === "write" && e.isError === false, 10000, { since: client.events.indexOf(handoff) });
			await client.waitFor(e => e.type === "agent_settled", 10000, { since: client.events.indexOf(handoff) });
			assert.equal(readFileSync(join(t.dir, "result.txt"), "utf8"), "done");
			const compactions = eventsOfType(client.events, "compaction_end");
			assert.equal(compactions.filter(e => e.aborted === false && !e.errorMessage).length, 1);
			assert.equal(compactions.length, abort ? 2 : 1, "no extra compaction beyond the cancelled attempt and recovery");
			assert.equal(eventsOfType(client.events, "message_end").filter(e => (e.message as { customType?: string })?.customType === "self-compact-handoff").length, 1);
			const trace = readFileSync(t.traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; parallel?: boolean });
			assert.ok(trace.some(item => item.kind === "request" && item.parallel), "a real parallel model request started during compaction");
			if (!abort) {
				const summaryRequests = trace.filter(item => item.kind === "summary").length;
				assert.ok(summaryRequests === 1 || summaryRequests === 2, "one Pi compaction may also summarize a split-turn prefix");
				const lateResponse = client.events.findIndex(e => e.type === "message_end" && (e.message as { role?: string; content?: Array<{ text?: string }> })?.role === "assistant" && (e.message as { content: Array<{ text?: string }> }).content.some(block => block.text === "Waiting for compaction."));
				assert.ok(lateResponse > client.events.indexOf(compactions[0]!), "the old-context response landed after compaction");
			}
			const session = readFileSync(latestSessionFile(t)!, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; customType?: string; content?: string });
			assert.ok(session.some(entry => entry.type === "custom_message" && entry.customType === "task-event" && entry.content === "Background task finished."), "background completion remains in the session journal");
			const since = client.mark();
			await client.request({ type: "prompt", message: "/self-compact-info" });
			const info = await client.waitFor(e => e.type === "extension_ui_request" && e.method === "notify" && /^self-compact info/.test(String(e.message)), 5000, { since });
			assert.match(String(info.message), /tools unlocked, handoff done/);
		} finally {
			await client.close();
		}
	},
);
