import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HARD_AT, DEFAULT_SPECS } from "../../extensions/self-compact/defaults.ts";
import { resolveSelfCompactSettings } from "../../extensions/self-compact/settings.ts";

test("no config, no flags: pure shipped defaults, fromDefaults, no hardAt", () => {
	const r = resolveSelfCompactSettings(undefined);
	assert.deepEqual(r.specs, DEFAULT_SPECS);
	assert.deepEqual(r.sources, { softAt: "default", at: "default", buffer: "default" });
	assert.equal("hardAt" in r.sources, false);
	assert.equal(r.fromDefaults, true);
});

test("no config, flags: legacy additive mode with flag sources", () => {
	const r = resolveSelfCompactSettings(undefined, { softAt: "15%", at: "40%", buffer: "5%" });
	assert.deepEqual(r.specs, { softAt: "15%", at: "40%", buffer: "5%" });
	assert.deepEqual(r.sources, { softAt: "flag", at: "flag", buffer: "flag" });
	assert.equal("hardAt" in r.specs, false);
	assert.equal(r.fromDefaults, false);
});

test("no config, blank flag strings are treated as absent", () => {
	const r = resolveSelfCompactSettings(undefined, { softAt: "   " });
	assert.deepEqual(r.specs, DEFAULT_SPECS);
	assert.equal(r.fromDefaults, true);
});

test("config must be a plain object: null, arrays, and scalars are rejected", () => {
	for (const bad of [null, [], "10%", 42, true]) {
		assert.throws(() => resolveSelfCompactSettings(bad), /expected an object/, `expected rejection for ${JSON.stringify(bad)}`);
	}
	assert.throws(() => resolveSelfCompactSettings(null), /got null/);
	assert.throws(() => resolveSelfCompactSettings([]), /got an array/);
	assert.throws(() => resolveSelfCompactSettings(42), /got number/);
});

test("empty config: defaults plus the default 30% direct hard cutoff", () => {
	const r = resolveSelfCompactSettings({});
	assert.deepEqual(r.specs, { softAt: "10%", at: "20%", buffer: "10%", hardAt: "30%" });
	assert.deepEqual(r.sources, { softAt: "default", at: "default", buffer: "default", hardAt: "default" });
	assert.equal(r.fromDefaults, false);
});

test("config noticeAt/warningAt fill in around the default hard cutoff", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "15%", warningAt: "25%" });
	assert.deepEqual(r.specs, { softAt: "15%", at: "25%", buffer: "10%", hardAt: "30%" });
	assert.deepEqual(r.sources, { softAt: "settings", at: "settings", buffer: "default", hardAt: "default" });
});

test("config value types: percent strings and safe whole token counts (0 allowed)", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "0%", warningAt: "12.5%", hardAt: 270000 });
	assert.equal(r.specs.softAt, "0%");
	assert.equal(r.specs.at, "12.5%");
	assert.equal(r.specs.hardAt, "270000");
	assert.equal(r.sources.hardAt, "settings");
	// Numeric 0 is the smallest accepted token count.
	assert.equal(resolveSelfCompactSettings({ noticeAt: 0 }).specs.softAt, "0");
	// 2^53 - 1 is the largest safe integer token.
	assert.equal(resolveSelfCompactSettings({ noticeAt: 9007199254740991 }).specs.softAt, "9007199254740991");
});

test("config value type errors: string tokens, k/m suffixes, fractions, negatives, unsafe integers, NaN/Infinity, junk", () => {
	for (const [field, value] of [
		["noticeAt", "270000"],
		["noticeAt", "abc"],
		["noticeAt", "100k"],
		["noticeAt", "1.5"],
		["noticeAt", "-5"],
		["noticeAt", "9007199254740992"],
		["warningAt", "1.5m"],
		["warningAt", 1.5],
		["warningAt", -5],
		["warningAt", 9007199254740992],
		["hardAt", NaN],
		["hardAt", Infinity],
		["hardAt", -Infinity],
		["hardAt", "%"],
	] as const) {
		assert.throws(() => resolveSelfCompactSettings({ [field]: value }), new RegExp(`Invalid selfCompact\\.${field}`), `expected rejection for ${field}=${JSON.stringify(value)}`);
	}
});

test("flag overrides win over config values and their sources", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "15%" }, { softAt: "10%" });
	assert.deepEqual(r.specs, { softAt: "10%", at: "20%", buffer: "10%", hardAt: "30%" });
	assert.deepEqual(r.sources, { softAt: "flag", at: "default", buffer: "default", hardAt: "default" });
	// An explicit --compact-at switches to legacy additive mode (no hardAt).
	const additive = resolveSelfCompactSettings({ noticeAt: "15%" }, { softAt: "10%", at: "50%" });
	assert.deepEqual(additive.specs, { softAt: "10%", at: "50%", buffer: "10%" });
	assert.deepEqual(additive.sources, { softAt: "flag", at: "flag", buffer: "default" });
});

test("only effective values are validated: invalid config fields overridden by flags are accepted", () => {
	assert.equal(resolveSelfCompactSettings({ noticeAt: "abc" }, { softAt: "15%" }).specs.softAt, "15%");
	assert.equal(resolveSelfCompactSettings({ warningAt: "abc" }, { at: "40%" }).specs.at, "40%");
	// The buffer flag drops hardAt entirely, so an invalid hardAt is accepted too.
	const dropped = resolveSelfCompactSettings({ hardAt: "abc" }, { buffer: "5%" });
	assert.equal("hardAt" in dropped.specs, false);
	assert.equal(dropped.specs.buffer, "5%");
	// Without the buffer flag the invalid hardAt is effective and rejected.
	assert.throws(() => resolveSelfCompactSettings({ hardAt: "abc" }), /Invalid selfCompact\.hardAt/);
});

test("hard mode selection: buffer flag always wins over a configured hardAt (additive mode)", () => {
	const r = resolveSelfCompactSettings({ hardAt: "50%" }, { buffer: "5%" });
	assert.deepEqual(r.specs, { softAt: "10%", at: "20%", buffer: "5%" });
	assert.deepEqual(r.sources, { softAt: "default", at: "default", buffer: "flag" });
	assert.equal(r.fromDefaults, false);
});

test("hard mode selection: configured hardAt persists even with an explicit --compact-at", () => {
	const r = resolveSelfCompactSettings({ hardAt: "50%" }, { at: "40%" });
	assert.deepEqual(r.specs, { softAt: "10%", at: "40%", buffer: "10%", hardAt: "50%" });
	assert.deepEqual(r.sources, { softAt: "default", at: "flag", buffer: "default", hardAt: "settings" });
});

test("hard mode selection: missing hard with an explicit --compact-at falls back to warn + default buffer", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "15%" }, { at: "40%" });
	assert.deepEqual(r.specs, { softAt: "15%", at: "40%", buffer: "10%" });
	assert.deepEqual(r.sources, { softAt: "settings", at: "flag", buffer: "default" });
	assert.equal("hardAt" in r.sources, false);
});

test("hard mode selection: missing hard without --compact-at uses the default 30% direct cutoff (source default)", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "15%" });
	assert.equal(r.specs.hardAt, "30%");
	assert.equal(r.specs.hardAt, DEFAULT_HARD_AT);
	assert.equal(r.sources.hardAt, "default");
});

test("effective specs are validated: default 30% hard below a raised warning is rejected", () => {
	assert.throws(() => resolveSelfCompactSettings({ warningAt: "40%" }), /Invalid selfCompact\.hardAt.*must not be below/);
	assert.doesNotThrow(() => resolveSelfCompactSettings({ warningAt: "40%", hardAt: "50%" }));
});

test("effective specs are validated: existing guards apply to settings-derived values", () => {
	assert.throws(() => resolveSelfCompactSettings({ noticeAt: "30%", warningAt: "20%" }), /must not exceed/);
	assert.throws(() => resolveSelfCompactSettings({ warningAt: "95%" }), /above the 90% hard cap/);
	assert.throws(() => resolveSelfCompactSettings({ noticeAt: "150%" }), /above 100%/);
	// A hardAt above the 90% cap is accepted here; resolveThresholds caps it with a note.
	assert.doesNotThrow(() => resolveSelfCompactSettings({ hardAt: "95%" }));
});

test("unknown config fields are ignored", () => {
	const r = resolveSelfCompactSettings({ noticeAt: "15%", bogus: 1 });
	assert.equal(r.specs.softAt, "15%");
	assert.deepEqual(r.specs.hardAt, "30%");
});
