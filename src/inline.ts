/**
 * Inline keyboards and callback query handling.
 *
 * Telegram inline keyboards are arrays of button rows, where each row is
 * an array of buttons. Each button has `text` (display) and `callback_data`
 * (string we receive back when tapped).
 *
 * Callback data is size-limited (64 bytes). We pack an action + a token
 * with a delimiter.
 *
 * Three call-sites:
 *   - Approval gate on tool_call (Approve / Deny / Always-allow-this-tool)
 *   - Model picker (paginated, one model per button)
 *   - Queue browser (promote / drop / clear)
 *   - Slash-command selection (for ambiguous inputs)
 */

import type { TelegramClient } from "./transport.js";
import type { PendingTurn } from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Max bytes for callback_data per Telegram's limit. */
const MAX_CB = 64;

/** Build the inline_keyboard markup for Telegram. */
export function keyboardMarkup(rows: Array<Array<{ text: string; action: string }>>): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
	return {
		inline_keyboard: rows.map((row) =>
			row.map((b) => ({ text: b.text.slice(0, 64), callback_data: b.action.slice(0, MAX_CB) }))
		),
	};
}

export interface ApprovalDecision {
	approved: boolean;
	remember: boolean;
}

/**
 * Show an approval prompt for a tool call and wait for the user's tap.
 * Resolves on the first matching callback. Other callbacks get a toast.
 */
export async function askApproval(
	client: TelegramClient,
	chatId: number,
	toolName: string,
	commandSummary: string,
	callbackMatcher: AbortSignal,
): Promise<{ decision: ApprovalDecision; messageId: number }> {
	const nonce = randomNonce();
	const approve = `app:yes:${nonce}`;
	const deny = `app:no:${nonce}`;
	const always = `app:always:${nonce}`;

	const text =
		`🔐 <b>Permission request</b>\n\n` +
		`Tool: <code>${escapeHtml(toolName)}</code>\n` +
		`Command:\n<pre>${escapeHtml(commandSummary.slice(0, 1500))}</pre>`;
	const markup = keyboardMarkup([
		[{ text: "✅ Approve once", action: approve }, { text: "❌ Deny", action: deny }],
		[{ text: "✅ Always allow", action: always }],
	]);
	console.log(`[pi-telegram] asking approval for ${toolName}, nonce=${nonce}`);
	const sent = await client.sendMessage(chatId, text, { parseMode: "HTML", replyMarkup: markup });

	return new Promise((resolve) => {
		const onAbort = () => {
			console.log(`[pi-telegram] approval aborted (signal) for ${toolName}`);
			resolve({ decision: { approved: false, remember: false }, messageId: sent.message_id });
		};
		callbackMatcher.addEventListener("abort", onAbort, { once: true });

		// Register a one-shot listener bound to this nonce.
		registerOnceCallback(nonce, async (cbData) => {
			console.log(`[pi-telegram] approval callback fired: ${cbData}`);
			callbackMatcher.removeEventListener("abort", onAbort);
			const isApprove = cbData === approve;
			const isAlways = cbData === always;
			// Resolve BEFORE editing the prompt so a slow/partial edit
			// can't block the tool execution.
			resolve({
				decision: { approved: isApprove || isAlways, remember: isAlways },
				messageId: sent.message_id,
			});
			// Update the prompt message to reflect the decision.
			const newText = isApprove || isAlways
				? `✅ Approved: <code>${escapeHtml(toolName)}</code>`
				: `❌ Denied: <code>${escapeHtml(toolName)}</code>`;
			try {
				await client.editMessageText(chatId, sent.message_id, newText, { parseMode: "HTML" });
			} catch (editErr) {
				console.error(`[pi-telegram] approval edit failed: ${(editErr as Error).message}`);
			}
		});
	});
}

// --- Generic callback registry ---
// Telegram only delivers a callback query once. We need to route it to
// whichever pending handler matches its data. We use a Map<nonce, handler>
// plus a wildcard prefix-match for action types (app:yes:, model:, queue:).

const pendingByNonce = new Map<string, (data: string) => Promise<void>>();
const wildcardHandlers = new Map<string, (data: string) => Promise<void>>();

function randomNonce(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function registerOnceCallback(nonce: string, handler: (data: string) => Promise<void>): void {
	console.log(`[pi-telegram] registering once-callback for nonce=${nonce}`);
	pendingByNonce.set(nonce, handler);
	// Auto-expire after 5 minutes to avoid leaks.
	setTimeout(() => {
		if (pendingByNonce.delete(nonce)) {
			console.log(`[pi-telegram] approval handler expired, nonce=${nonce}`);
		}
	}, 5 * 60 * 1000);
}

export function registerWildcardCallback(prefix: string, handler: (data: string) => Promise<void>): void {
	wildcardHandlers.set(prefix, handler);
}

/** Dispatch a callback_query.data to the right handler. */
export async function dispatchCallback(data: string, client?: TelegramClient, chatId?: number): Promise<boolean> {
	console.log(`[pi-telegram] dispatchCallback: ${data}`);
	// Exact nonce match: app:yes:abc123 → strip prefix, look up abc123.
	const colonParts = data.split(":");
	if (colonParts.length >= 3) {
		const head = colonParts[0];
		const sub = colonParts[1];
		if (head === "app" && (sub === "yes" || sub === "no" || sub === "always")) {
			const nonce = colonParts.slice(2).join(":");
			const handler = pendingByNonce.get(nonce);
			if (handler) {
				pendingByNonce.delete(nonce);
				await handler(data);
				return true;
			}
			console.warn(`[pi-telegram] no pending handler for nonce=${nonce}`);
			if (client && chatId !== undefined) {
				try {
					await client.editMessageText(
						chatId,
						undefined,
						`⏰ <b>Approval prompt expired</b>\n\nRun the command again if you still want it.`,
						{ parseMode: "HTML" },
					);
				} catch { /* ignore */ }
			}
			return false;
		}
	}
	// Wildcard prefix: model:abc, queue:abc, turn:abc
	for (const [prefix, handler] of wildcardHandlers) {
		if (data.startsWith(`${prefix}:`)) {
			await handler(data);
			return true;
		}
	}
	return false;
}

// --- Approval: persistent "always allow this tool" list ---
// Stored in a JSON file alongside telegram.json so it survives restarts.
const APPROVAL_FILE = "telegram-approvals.json";

export function loadAlwaysAllow(): { tools: string[] } {
	try {
		const dir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const path = join(dir, APPROVAL_FILE);
		if (!existsSync(path)) return { tools: [] };
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { tools: [] };
	}
}

export function saveAlwaysAllow(tools: string[]): void {
	const dir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, APPROVAL_FILE);
	writeFileSync(path, JSON.stringify({ tools }, null, "\t"), { mode: 0o600 });
}

export function isAlwaysAllowed(toolName: string): boolean {
	return loadAlwaysAllow().tools.includes(toolName);
}

export function addAlwaysAllow(toolName: string): void {
	const cur = loadAlwaysAllow();
	if (!cur.tools.includes(toolName)) {
		cur.tools.push(toolName);
		saveAlwaysAllow(cur.tools);
	}
}

// --- Model picker keyboard ---

export function modelPickerMarkup(models: Array<{ id: string; provider: string }>, page: number, perPage: number, currentId?: string): unknown {
	const start = page * perPage;
	const slice = models.slice(start, start + perPage);
	const rows = slice.map((m) => {
		const label = m.id === currentId ? `★ ${m.provider}/${m.id}` : `${m.provider}/${m.id}`;
		return [{ text: label, action: `tgcmd:model:${m.provider}/${m.id}` }];
	});
	const nav: Array<{ text: string; action: string }> = [];
	if (page > 0) nav.push({ text: "◀ Prev", action: `tgcmd:modelpage:${page - 1}` });
	if (start + perPage < models.length) nav.push({ text: "Next ▶", action: `tgcmd:modelpage:${page + 1}` });
	if (nav.length > 0) rows.push(nav);
	return keyboardMarkup(rows);
}

// --- Queue browser keyboard ---

/** Queue browser keyboard. Each row shows status + first line of text. */
export function queueBrowserMarkup(turns: Array<{ id: string; lane: "control" | "prompt"; text: string; priority: number; status: string }>): unknown {
	const rows: Array<Array<{ text: string; action: string }>> = [];
	for (const t of turns.slice(0, 8)) {
		const statusEmoji = t.status === "running" ? "🏃" : t.status === "completed" ? "✓" : "⏳";
		const laneEmoji = t.lane === "control" ? "⚡" : "▸";
		const label = `${statusEmoji} ${laneEmoji} ${t.text.slice(0, 28).replace(/\n/g, " ")}${t.text.length > 28 ? "…" : ""}`;
		const buttons: Array<{ text: string; action: string }> = [];
		if (t.status === "pending") {
			buttons.push({ text: `👍 ${label}`, action: `tprior:${t.id}` });
			buttons.push({ text: "🗑", action: `tdrop:${t.id}` });
		} else {
			buttons.push({ text: label, action: `tqnoop:${t.id}` });
		}
		rows.push(buttons);
	}
	if (turns.some((t) => t.status === "pending")) {
		rows.push([{ text: "Clear all pending", action: "tclear" }]);
	}
	return keyboardMarkup(rows);
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
