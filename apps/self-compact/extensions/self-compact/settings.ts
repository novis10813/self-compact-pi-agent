/**
 * Pure settings resolver for the self-compact extension.
 *
 * Takes the raw `selfCompact` settings value (whatever the settings file
 * contained — this module does no JSON IO) plus the CLI flag overrides, and
 * returns the effective ThresholdSpecs, per-field sources, and the
 * fromDefaults flag consumed by resolveThresholds(). Throws a descriptive
 * Error on invalid config.
 *
 * Precedence per field: CLI flag > selfCompact config > built-in default.
 * - No config (undefined): original defaults plus flags — legacy additive
 *   buffer mode, exactly the pre-settings behavior. This path does not
 *   validate (the runtime validates its flags, as before).
 * - Config present: must be a plain object (not null, not an array).
 *   noticeAt/warningAt/hardAt accept a percentage string ("30%") or a safe
 *   non-negative whole token count (270000; 0 allowed). No k/m suffixes
 *   or string token counts. Missing notice/warning default to 10%/20%.
 * - Hard mode selection (only when a config is present):
 *   - --compact-buffer always wins: additive mode, hardAt dropped.
 *   - else a config hardAt: direct mode.
 *   - else an explicit --compact-at: legacy additive mode with the default buffer.
 *   - else: direct mode with the default 30% hard cutoff (DEFAULT_HARD_AT).
 * - Only effective values are validated: an invalid config field that a CLI
 *   flag overrides (or that the buffer flag drops, for hardAt) is accepted.
 *   The effective specs are validated with validateSpecs() before returning.
 *
 * No Pi imports, erasable TypeScript only (runs under Pi's jiti loader and
 * under Node's native type stripping for `node --test`).
 */

import { DEFAULT_HARD_AT, DEFAULT_SPECS, type ThresholdSpecs } from "./defaults.ts";
import { validateSpecs, type ThresholdSpecSources } from "./thresholds.ts";

export interface FlagOverrides {
	/** --compact-soft-at */
	softAt?: string;
	/** --compact-at */
	at?: string;
	/** --compact-buffer */
	buffer?: string;
}

export interface ResolvedSettings {
	specs: ThresholdSpecs;
	sources: ThresholdSpecSources;
	/** True only when a config is absent and no flag is set: pure shipped defaults. */
	fromDefaults: boolean;
}

const PERCENT_RE = /^\d+(?:\.\d+)?\s*%$/i;

function cleanFlag(value: string | undefined): string | undefined {
	const text = (value ?? "").trim();
	return text === "" ? undefined : text;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

/** Accept a percentage string ("30%") or a safe whole token count (270000); throws otherwise. */
function configValue(field: string, value: unknown): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	if (typeof value === "string" && PERCENT_RE.test(value.trim())) return value.trim();
	throw new Error(`Invalid selfCompact.${field}: expected a percentage string ("30%") or a non-negative whole token number (270000), got ${describe(value)}.`);
}

export function resolveSelfCompactSettings(raw: unknown, flags: FlagOverrides = {}): ResolvedSettings {
	const softFlag = cleanFlag(flags.softAt);
	const atFlag = cleanFlag(flags.at);
	const bufferFlag = cleanFlag(flags.buffer);

	if (raw === undefined) {
		// No config: original defaults plus flags, legacy additive buffer mode.
		return {
			specs: {
				softAt: softFlag ?? DEFAULT_SPECS.softAt,
				at: atFlag ?? DEFAULT_SPECS.at,
				buffer: bufferFlag ?? DEFAULT_SPECS.buffer,
			},
			sources: {
				softAt: softFlag ? "flag" : "default",
				at: atFlag ? "flag" : "default",
				buffer: bufferFlag ? "flag" : "default",
			},
			fromDefaults: !softFlag && !atFlag && !bufferFlag,
		};
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`Invalid selfCompact settings: expected an object (noticeAt/warningAt/hardAt), got ${describe(raw)}.`);
	}
	const cfg = raw as Record<string, unknown>;
	// Only effective values are validated: a CLI flag override silences its
	// config field entirely, and the buffer flag drops hardAt (additive mode).
	const notice = !softFlag && cfg.noticeAt !== undefined ? configValue("noticeAt", cfg.noticeAt) : undefined;
	const warning = !atFlag && cfg.warningAt !== undefined ? configValue("warningAt", cfg.warningAt) : undefined;
	const hard = !bufferFlag && cfg.hardAt !== undefined ? configValue("hardAt", cfg.hardAt) : undefined;

	const specs: ThresholdSpecs = {
		softAt: softFlag ?? notice ?? DEFAULT_SPECS.softAt,
		at: atFlag ?? warning ?? DEFAULT_SPECS.at,
		buffer: bufferFlag ?? DEFAULT_SPECS.buffer,
	};
	const sources: ThresholdSpecSources = {
		softAt: softFlag ? "flag" : notice !== undefined ? "settings" : "default",
		at: atFlag ? "flag" : warning !== undefined ? "settings" : "default",
		buffer: bufferFlag ? "flag" : "default",
	};
	// Direct mode: an explicit buffer flag always wins and restores additive
	// mode; otherwise a config hardAt (or the default when the config is
	// present but silent) pins the hard cutoff. In direct mode specs.buffer
	// keeps its legacy value but is ignored by resolveThresholds, which
	// derives the buffer as the gap between the warning line and the cutoff.
	if (!bufferFlag) {
		const hardAt = hard ?? (atFlag ? undefined : DEFAULT_HARD_AT);
		if (hardAt !== undefined) {
			specs.hardAt = hardAt;
			sources.hardAt = hard !== undefined ? "settings" : "default";
		}
	}

	validateSpecs(specs);
	return { specs, sources, fromDefaults: false };
}
