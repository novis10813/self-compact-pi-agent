/**
 * R1: one tool batch pushes the context from below the hard cutoff past the whole window, so the
 * provider rejects the next request as a context overflow before the agent can write a note.
 * Expected: the session recovers through a compaction instead of staying locked with every
 * request overflowing. Marked todo until the overflow path is fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcClient, eventsOfType } from "../harness/rpc-client.ts";
import { DEFAULT_FAKE_ENV, makeTestDir, scriptedArgs } from "../harness/env.ts";

// Hard cutoff at 90%; each assistant turn adds 25% of the window, so usage goes 77.5% -> 102.5%.
const FLAGS = ["--compact-soft-at", "20%", "--compact-at", "80%", "--compact-buffer", "10%"];

test("R1: a context overflow below the hard cutoff recovers through compaction", { todo: "R1: overflow compaction is cancelled and the session stays locked" }, async () => {
	const t = makeTestDir("overflow");
	const client = new RpcClient({
		args: scriptedArgs(t, FLAGS),
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_STEP: "50000", SC_FAKE_OVERFLOW: "1", SC_FAKE_TRACE: t.traceFile },
		logFile: t.logFile,
	});
	try {
		await client.request({ type: "prompt", message: "Start the scripted work." });
		const overflow = await client.waitFor((e) => e.type === "compaction_start" && e.reason === "overflow", 60_000);
		const recovered = await client.waitFor((e) => e.type === "compaction_end" && e.aborted === false && !e.errorMessage, 30_000, { since: client.events.indexOf(overflow) });
		assert.ok(recovered.result, "a compaction landed after the overflow");
		await client.waitFor((e) => e.type === "agent_settled", 30_000, { since: client.events.indexOf(recovered) });
		const failedAfter = eventsOfType(client.events.slice(client.events.indexOf(recovered)), "message_end").filter((e) => (e.message as { stopReason?: string }).stopReason === "error");
		assert.equal(failedAfter.length, 0, "no request overflows after the recovery compaction");
	} finally {
		await client.close();
	}
});
