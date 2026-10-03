import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	compact,
	convertToLlm,
	getPackageDir,
	serializeConversation,
	SettingsManager,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { LoadedPrompt } from "./prompts.ts";

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

function historyInput(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"], previous?: string): string {
	const conversation = serializeConversation(convertToLlm(messages));
	return `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}`;
}

/**
 * Pi's turn-prefix prompt (generateTurnPrefixSummary in compaction.js) uses `# Conversation` /
 * `# Instructions` headers instead of the `<conversation>` tags, so the prefix call must be
 * matched in that format for the instruction replacement to recognize it.
 */
function turnPrefixInput(messages: SessionBeforeCompactEvent["preparation"]["turnPrefixMessages"]): string {
	const conversation = serializeConversation(convertToLlm(messages));
	return `# Conversation\n${conversation}\n\n# Instructions\n`;
}

function summaryInstructions(event: SessionBeforeCompactEvent, prompt: LoadedPrompt): string {
	return [
		"Summarize the supplied historical data. Do not continue the task, simulate tools, or claim actions without tool-result evidence. Keep pending actions pending.",
		prompt.text,
		event.preparation.isSplitTurn ? "This is a split turn. Summarize only the supplied history or turn prefix; the recent suffix remains available." : "",
		event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : "",
	].filter(Boolean).join("\n\n");
}

/** Match complete known inputs, so tag-like text inside history cannot cut the conversation short. */
function replaceInstructions(context: Context, inputs: string[], instructions: string, budgetChars: number) {
	let truncated = false;
	const messages = context.messages.map(message => {
		if (message.role !== "user") return message;
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return {
			...message,
			content: content.map(block => {
				if (block.type !== "text") return block;
				let input = inputs.find(candidate => block.text.startsWith(candidate));
				if (input === undefined) throw new Error("Unrecognized Pi summary input; cannot replace instructions safely.");
				if (input.length > budgetChars) {
					input = `[earlier conversation truncated to fit summary budget]\n${input.slice(-budgetChars)}`;
					truncated = true;
				}
				return { ...block, text: `${input}${instructions}` };
			}),
		};
	});
	return { messages, truncated };
}

/** Pi owns split turns, summary updates, file tracking and configured transport retries. */
export async function generateSummary(event: SessionBeforeCompactEvent, ctx: ExtensionContext, system: LoadedPrompt, instructions: LoadedPrompt) {
	if (!ctx.model) throw new Error("No model available for compaction.");
	const inputs = [historyInput(event.preparation.messagesToSummarize, event.preparation.previousSummary), turnPrefixInput(event.preparation.turnPrefixMessages)].sort((a, b) => b.length - a.length);
	const userInstructions = summaryInstructions(event, instructions);
	let truncatedInput = false;
	const result = await compact(
		event.preparation, ctx.model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel,
		async (model, context, options) => {
			// Pi computes the summary budget from reserveTokens (0.8x history, 0.5x turn prefix,
			// already clamped by the model's output cap). Trust it — re-clamping here would
			// silently defeat compaction.reserveTokens.
			const maxTokens = options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : 8192);
			const budgetChars = Math.max(8000, (model.contextWindow - maxTokens - 2000) * 4 - system.text.length - userInstructions.length);
			const { messages, truncated } = replaceInstructions(context, inputs, userInstructions, budgetChars);
			truncatedInput ||= truncated;
			const response = await ctx.modelRegistry.complete(model, { ...context, systemPrompt: system.text, messages }, {
				...options, maxTokens, signal: event.signal, cacheRetention: "none", sessionId: randomUUID(),
				...(model.api === "openai-completions" && model.reasoning ? { reasoningEffort: "low" as const } : {}),
			});
			if (event.signal.aborted || response.stopReason === "aborted") throw new Error("Compaction summary cancelled.");
			if (response.stopReason !== "error" && !response.content.some(block => block.type === "text" && block.text.trim())) throw new Error("Summary response was empty.");
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		},
		undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
	);
	if (event.signal.aborted) throw new Error("Compaction summary cancelled.");
	return { result, truncatedInput };
}
