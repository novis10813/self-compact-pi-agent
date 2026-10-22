import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * The fully resolved compaction settings Pi passes to prepareCompaction (model override > ordinary
 * setting > built-in default). The root export named CompactionSettings is the *file* settings
 * shape (optional fields + modelOverrides), not this resolved shape, so it is mirrored here with
 * prepareCompaction's own parameter type name.
 */
interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/**
 * Pi's own compaction preparation — the exact function agent-session.js calls
 * (`prepareCompaction(getBranch(), getCompactionSettings(model))`) before every compaction run.
 * Pi 1.0.0 does not re-export it from the package root. Resolve the internal module from Pi's
 * public getPackageDir() instead of relying on extension-loader alias path tricks. This adapter
 * requires a disk-based Pi installation and must be checked when upgrading Pi.
 * Unsupported installations fail explicitly rather than silently disabling the precheck.
 */
const prepareModuleUrl = pathToFileURL(join(getPackageDir(), "dist/core/compaction/compaction.js")).href;
type NativePrepareCompaction = (entries: SessionEntry[], settings: CompactionSettings) => unknown;
let nativeModule: { prepareCompaction?: NativePrepareCompaction };
try {
	nativeModule = await import(prepareModuleUrl) as { prepareCompaction?: NativePrepareCompaction };
} catch (error) {
	throw new Error("self-compact requires Pi's native prepareCompaction API; this Pi installation is unsupported.", { cause: error });
}
if (typeof nativeModule.prepareCompaction !== "function") {
	throw new Error("self-compact requires Pi's native prepareCompaction API; this Pi installation is unsupported.");
}
const nativePrepare = nativeModule.prepareCompaction;

/**
 * True when a compaction of this branch would have at least one message to summarize, false when
 * Pi would fail with "Nothing to compact" or "Already compacted" (everything fits inside
 * keepRecentTokens, or the leaf is a compaction entry). This is Pi's own prepareCompaction run on
 * the raw branch with the fully resolved compaction settings — the same projection, cut point and
 * token arithmetic the real compaction will use, including retained older compactions, context
 * edits and recovery omissions.
 */
export function hasCompactionMaterial(entries: SessionEntry[], settings: CompactionSettings): boolean {
	return nativePrepare(entries, settings) !== undefined;
}

/** Pi's full compaction settings for this working directory and active model (override > ordinary > built-in). */
export function compactionSettings(cwd: string, model?: { provider: string; id: string }): CompactionSettings {
	return SettingsManager.create(cwd).getCompactionSettings(model);
}

/**
 * Pi's retained recent history for this working directory (global settings merged with the
 * project's), resolved through the active model's overrides.
 */
export function keepRecentTokens(cwd: string, model?: { provider: string; id: string }): number {
	return compactionSettings(cwd, model).keepRecentTokens;
}
