import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SPECS,
	levelFor,
	parseTokenSpec,
	resolveThresholds,
	validateSpecs,
	type ResolvedThresholds,
} from "../../extensions/self-compact/thresholds.ts";

const MILLION = 1_000_000;

function resolveOk(specs: { softAt: string; at: string; buffer: string; hardAt?: string }, window: number, fromDefaults = false): ResolvedThresholds {
	const result = resolveThresholds(specs, window, { fromDefaults });
	if (!result.ok) throw new Error(result.error);
	return result.thresholds;
}

test("parseTokenSpec accepts whole tokens, k/m suffixes, and percentages", () => {
	assert.deepEqual(parseTokenSpec("270000", "x"), { kind: "tokens", value: 270000, raw: "270000" });
	assert.deepEqual(parseTokenSpec("100k", "x"), { kind: "tokens", value: 100000, raw: "100k" });
	assert.deepEqual(parseTokenSpec("1.5m", "x"), { kind: "tokens", value: 1500000, raw: "1.5m" });
	assert.deepEqual(parseTokenSpec(" 20% ", "x"), { kind: "percent", value: 20, raw: "20%" });
	assert.deepEqual(parseTokenSpec("0", "x"), { kind: "tokens", value: 0, raw: "0" });
	assert.deepEqual(parseTokenSpec("250K", "x"), { kind: "tokens", value: 250000, raw: "250K" });
});

test("parseTokenSpec rejects invalid values", () => {
	for (const bad of ["", "   ", "-1", "abc", "1.5", "150%", "10kk", "k", "%"]) {
		assert.throws(() => parseTokenSpec(bad, "--compact-at"), /Invalid --compact-at/, `expected rejection for ${JSON.stringify(bad)}`);
	}
});

test("shipped defaults are 10% / 20% / 30%: on a 1,000,000-token window they resolve to 100k / 200k / 300k", () => {
	assert.deepEqual(DEFAULT_SPECS, { softAt: "10%", at: "20%", buffer: "10%" });
	const t = resolveOk(DEFAULT_SPECS, MILLION, true);
	assert.equal(t.softTokens, 100_000);
	assert.equal(t.warnTokens, 200_000);
	assert.equal(t.bufferTokens, 100_000);
	assert.equal(t.forcedTokens, 300_000);
	assert.equal(t.clamped, false);
	const small = resolveOk(DEFAULT_SPECS, 128_000, true);
	assert.equal(small.forcedTokens, 38_400);
	assert.equal(small.clamped, false);
});

test("token launch 100k / 200k / 50k on 1M resolves to 100k / 200k / 250k (10% / 20% / 25%)", () => {
	const t = resolveOk({ softAt: "100k", at: "200k", buffer: "50k" }, MILLION);
	assert.equal(t.softTokens, 100_000);
	assert.equal(t.warnTokens, 200_000);
	assert.equal(t.forcedTokens, 250_000);
	assert.equal(t.softPct, 10);
	assert.equal(t.warnPct, 20);
	assert.equal(t.forcedPct, 25);
});

test("percent launch 20% / 50% / 10% on 1M resolves to 200k / 500k / 600k", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, MILLION);
	assert.equal(t.softTokens, 200_000);
	assert.equal(t.warnTokens, 500_000);
	assert.equal(t.forcedTokens, 600_000);
});

test("zero buffer makes forced coincide with warning (immediate enforcement)", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "0" }, MILLION);
	assert.equal(t.forcedTokens, t.warnTokens);
	assert.equal(levelFor(500_000, t), "forced");
	assert.equal(levelFor(499_999, t), "notice");
});

test("hard limit is capped at 90% of the window", () => {
	const t = resolveOk({ softAt: "50%", at: "85%", buffer: "10%" }, MILLION);
	assert.equal(t.capTokens, 900_000);
	assert.equal(t.forcedTokens, 900_000);
	assert.ok(t.notes.some((n) => n.includes("capped")));
});

test("explicit warning above the cap is rejected", () => {
	assert.throws(() => validateSpecs({ softAt: "20%", at: "95%", buffer: "0" }), /above the 90% hard cap/);
	const r = resolveThresholds({ softAt: "100k", at: "950k", buffer: "0" }, MILLION);
	assert.equal(r.ok, false);
});

test("explicit soft above warning is rejected (same units at load, mixed units at resolve)", () => {
	assert.throws(() => validateSpecs({ softAt: "60%", at: "50%", buffer: "0" }), /must not exceed/);
	assert.throws(() => validateSpecs({ softAt: "300k", at: "200k", buffer: "0" }), /must not exceed/);
	const r = resolveThresholds({ softAt: "60%", at: "500k", buffer: "0" }, MILLION);
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /must not exceed/);
});

test("token defaults larger than a small window are clamped instead of rejected", () => {
	const t = resolveOk({ softAt: "225k", at: "250k", buffer: "20k" }, 200_000, true);
	assert.equal(t.capTokens, 180_000);
	assert.equal(t.warnTokens, 180_000);
	assert.equal(t.softTokens, 180_000);
	assert.equal(t.forcedTokens, 180_000);
	assert.equal(t.clamped, true);
	assert.ok(t.notes.length >= 1);
});

test("levelFor maps tokens to levels and unknown for null", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, 100_000);
	assert.equal(levelFor(null, t), "unknown");
	assert.equal(levelFor(0, t), "idle");
	assert.equal(levelFor(19_999, t), "idle");
	assert.equal(levelFor(20_000, t), "notice");
	assert.equal(levelFor(50_000, t), "warning");
	assert.equal(levelFor(59_999, t), "warning");
	assert.equal(levelFor(60_000, t), "forced");
	assert.equal(levelFor(100_000, t), "forced");
});

test("direct hardAt sets the cutoff and derives the buffer as the gap", () => {
	const t = resolveOk({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "30%" }, MILLION);
	assert.equal(t.forcedTokens, 300_000);
	assert.equal(t.bufferTokens, 100_000, "buffer is the derived gap, not the spec");
	assert.equal(t.clamped, false);
	assert.deepEqual(t.notes, []);
});

test("direct hardAt ignores the additive buffer string, even 0", () => {
	const t = resolveOk({ softAt: "10%", at: "20%", buffer: "50%", hardAt: "25%" }, MILLION);
	assert.equal(t.forcedTokens, 250_000);
	assert.equal(t.bufferTokens, 50_000);
	const zero = resolveOk({ softAt: "10%", at: "20%", buffer: "0", hardAt: "30%" }, MILLION);
	assert.equal(zero.forcedTokens, 300_000);
	assert.equal(zero.bufferTokens, 100_000);
});

test("direct hardAt above the 90% cap is capped with a note (percent and token units)", () => {
	const pct = resolveOk({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "95%" }, MILLION);
	assert.equal(pct.forcedTokens, 900_000);
	assert.equal(pct.bufferTokens, 700_000);
	assert.ok(pct.notes.some((n) => n.includes("capped")));
	const tokens = resolveOk({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "950k" }, MILLION);
	assert.equal(tokens.forcedTokens, 900_000);
	assert.ok(tokens.notes.some((n) => n.includes("capped")));
});

test("direct hardAt exactly at the cap is not capped", () => {
	const t = resolveOk({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "90%" }, MILLION);
	assert.equal(t.forcedTokens, 900_000);
	assert.deepEqual(t.notes, []);
});

test("direct hardAt below the warning is rejected (same units at load, mixed units at resolve)", () => {
	assert.throws(() => validateSpecs({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "15%" }), /must not be below/);
	assert.throws(() => validateSpecs({ softAt: "100k", at: "200k", buffer: "10k", hardAt: "150k" }), /must not be below/);
	// Mixed units pass load-time validation but fail at resolve: 15% of 1M = 150k < 200k.
	const mixed = resolveThresholds({ softAt: "100k", at: "200k", buffer: "10k", hardAt: "15%" }, MILLION);
	assert.equal(mixed.ok, false);
	if (!mixed.ok) assert.match(mixed.error, /must not be below/);
	// Mixed units, valid ordering: 20% of 1M = 200k >= 150k.
	const ok = resolveOk({ softAt: "100k", at: "150k", buffer: "10k", hardAt: "20%" }, MILLION);
	assert.equal(ok.forcedTokens, 200_000);
	assert.equal(ok.bufferTokens, 50_000);
});

test("direct hardAt clamped to the warning only when fromDefaults", () => {
	const clamped = resolveOk({ softAt: "10%", at: "20%", buffer: "10%", hardAt: "15%" }, MILLION, true);
	assert.equal(clamped.forcedTokens, 200_000);
	assert.equal(clamped.bufferTokens, 0);
	assert.equal(clamped.clamped, true);
	assert.ok(clamped.notes.some((n) => n.includes("clamped")));
});

test("legacy additive mode is unchanged when hardAt is absent", () => {
	const t = resolveOk({ softAt: "10%", at: "20%", buffer: "10%" }, MILLION);
	assert.equal(t.forcedTokens, 300_000);
	assert.equal(t.bufferTokens, 100_000);
	assert.equal(t.clamped, false);
});
