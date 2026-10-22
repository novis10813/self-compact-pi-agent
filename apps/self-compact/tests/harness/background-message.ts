/** Inject a task completion while manual compaction is in flight. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function backgroundMessage(pi: ExtensionAPI) {
	let injected = false;
	pi.on("session_before_compact", () => {
		if (injected) return;
		injected = true;
		setTimeout(() => pi.sendMessage(
			{ customType: "task-event", content: "Background task finished.", display: true },
			{ deliverAs: "steer", triggerTurn: true },
		), 20);
	});
}
