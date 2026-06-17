/**
 * Lifecycle: wire pi's event stream to the Telegram adapter.
 *
 *   message_update  → throttled streaming preview (the message becomes
 *                       the final reply, not a separate draft)
 *   agent_start       → reset draft tracker, start typing indicator
 *   agent_end         → finalize the draft with rendered HTML + buttons,
 *                       or delete it and send chunked messages if too long
 *   tool_call         → permission gate (inline keyboard approve/deny)
 *
 * The polling loop itself is owned by `index.ts`. This module only reacts
 * to pi events and produces side-effects (Telegram messages).
 *
 * Shared state is the module-level `state` object. The TelegramClient and
 * chatId are pulled via the injected deps. Draft tracking is per-turn:
 * `agent_start` resets the draft id, and `agent_end` finalizes the same
 * message instead of deleting it and sending a new one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelegramClient } from "./transport.js";
import { renderMessage, chunkForTelegram } from "./render.js";
import {
	askApproval,
	isAlwaysAllowed,
	addAlwaysAllow,
} from "./inline.js";
import { keyboardMarkup } from "./inline.js";
import type { InlineButton } from "./types.js";

export interface LifecycleDeps {
	pi: ExtensionAPI;
	getClient: () => TelegramClient | null;
	getChatId: () => number | null;
	/** Called when the agent begins a new turn. */
	onAgentStart?: () => void | Promise<void>;
	/** Called when the agent finishes a turn. Use this to dispatch the next queued message. */
	onAgentEnd?: () => void | Promise<void>;
}

interface SessionState {
	/** Message id of the live streaming message for the current turn. */
	draftMessageId: number | null;
	/** Last text we edited into the draft (to avoid no-op edits). */
	draftText: string;
	/** Last edit timestamp (throttle). */
	draftLastSentAt: number;
	/** Interval handle for the typing indicator. */
	typingTimer: ReturnType<typeof setInterval> | null;
}

const DRAFT_THROTTLE_MS = 800;
const TYPING_REFRESH_MS = 4_500;

export function registerLifecycleHandlers(deps: LifecycleDeps): void {
	const state: SessionState = {
		draftMessageId: null,
		draftText: "",
		draftLastSentAt: 0,
		typingTimer: null,
	};

	// --- message_update: streaming preview ---
	deps.pi.on("message_update", async (event) => {
		const client = deps.getClient();
		const chatId = deps.getChatId();
		if (!client || chatId === null) return;
		if (event.message.role !== "assistant") return;
		const text = extractText(event.message);
		if (!text) return;

		const now = Date.now();

		// First update for this turn: create the live message.
		if (state.draftMessageId === null) {
			try {
				const { html } = renderMessage(text);
				const sent = await client.sendMessage(chatId, html || "…", { parseMode: "HTML" });
				state.draftMessageId = sent.message_id;
				state.draftText = text;
				state.draftLastSentAt = now;
				return;
			} catch { return; }
		}

		// Throttle: only edit if text changed meaningfully and throttle elapsed.
		if (text === state.draftText) return;
		if (now - state.draftLastSentAt < DRAFT_THROTTLE_MS) return;

		try {
			const { html } = renderMessage(text);
			await client.editMessageText(chatId, state.draftMessageId, html || "…", { parseMode: "HTML" });
			state.draftText = text;
			state.draftLastSentAt = now;
		} catch {
			// Ignore edit failures. The final onAgentEnd will render cleanly.
		}
	});

	// --- agent_start: reset per-turn draft tracker, start typing indicator ---
	deps.pi.on("agent_start", async () => {
		state.draftMessageId = null;
		state.draftText = "";
		const client = deps.getClient();
		const chatId = deps.getChatId();
		if (client && chatId !== null) {
			await safeTyping(client, chatId);
			if (state.typingTimer) clearInterval(state.typingTimer);
			state.typingTimer = setInterval(() => safeTyping(client, chatId), TYPING_REFRESH_MS);
		}
		await deps.onAgentStart?.();
	});

	// --- agent_end: finalize the live message, or chunk if too long ---
	deps.pi.on("agent_end", async (event) => {
		if (state.typingTimer) { clearInterval(state.typingTimer); state.typingTimer = null; }

		const client = deps.getClient();
		const chatId = deps.getChatId();
		if (!client || chatId === null) return;

		const last = lastAssistant(event.messages);
		if (!last) return;

		const text = extractText(last);
		if (!text) return;

		const { html, buttons, voice } = renderMessage(text);
		const chunks = chunkForTelegram(html);

		// If we have a live draft message and the final reply fits in a single
		// chunk, edit the draft in place. This is the common case and avoids
		// the "delete draft, send new" race that can wipe messages when turns
		// queue up.
		if (state.draftMessageId !== null && chunks.length === 1) {
			const chunk = chunks[0] ?? "";
			const opts: { parseMode: "HTML"; replyMarkup?: unknown } = { parseMode: "HTML" };
			if (buttons.length > 0) opts.replyMarkup = keyboardMarkup(rowsFromButtons(buttons));

			// If the draft already shows the final text, don't try to edit it
			// (Telegram would reject with "message is not modified"). Just attach
			// the button row if there is one.
			if (chunk === state.draftText && buttons.length > 0) {
				try {
					await client.editMessageReplyMarkup(chatId, state.draftMessageId, opts.replyMarkup);
				} catch (err) {
					console.error(`[pi-telegram] editMessageReplyMarkup failed: ${(err as Error).message}`);
				}
			} else if (chunk !== state.draftText) {
				try {
					await client.editMessageText(chatId, state.draftMessageId, chunk, opts);
				} catch (err) {
					const msg = (err as Error).message ?? String(err);
					// If Telegram says the message is not modified, the draft already
					// shows the final answer — no further action needed.
					if (!msg.toLowerCase().includes("not modified")) {
						console.error(`[pi-telegram] editMessageText failed: ${msg}`);
						try { await client.call("deleteMessage", { chat_id: chatId, message_id: state.draftMessageId }); } catch { /* ignore */ }
						try { await client.sendMessage(chatId, chunk, opts); } catch { /* ignore */ }
					}
				}
			}
			state.draftMessageId = null;
			state.draftText = "";
		} else {
			// Either no draft was created (e.g. no streaming text) or the reply
			// is long and needs chunking. Delete the draft if present and send
			// the final chunks.
			if (state.draftMessageId !== null) {
				try { await client.call("deleteMessage", { chat_id: chatId, message_id: state.draftMessageId }); } catch { /* ignore */ }
				state.draftMessageId = null;
				state.draftText = "";
			}

			for (let i = 0; i < chunks.length; i++) {
				const isLast = i === chunks.length - 1;
				const opts: { parseMode: "HTML"; replyMarkup?: unknown } = { parseMode: "HTML" };
				if (isLast && buttons.length > 0) {
					opts.replyMarkup = keyboardMarkup(rowsFromButtons(buttons));
				}
				try {
					await client.sendMessage(chatId, chunks[i] ?? "", opts);
				} catch (err) {
					console.error(`[pi-telegram] sendMessage failed: ${(err as Error).message}`);
				}
			}
		}

		// Voice markup: in v1 we don't ship a TTS provider, so we just notify.
		if (voice.length > 0) {
			try {
				await client.sendMessage(chatId, `🔊 voice reply requested (${voice.length} segment(s)) — TTS not configured in v1`, { parseMode: "HTML" });
			} catch { /* ignore */ }
		}

		// Notify the queue manager that this turn is done; it may dispatch the
		// next queued Telegram message.
		await deps.onAgentEnd?.();
	});

	// --- tool_call: permission gate with Telegram approval buttons ---
	deps.pi.on("tool_call", async (event, ctx) => {
		if (isAlwaysAllowed(event.toolName)) return undefined;
		if (!ctx.hasUI) return undefined;          // non-interactive (rpc/print) — skip gate

		const client = deps.getClient();
		const chatId = deps.getChatId();
		if (!client || chatId === null) return undefined;

		// Tools we don't need to ask about.
		const SAFE = new Set(["read", "glob", "grep", "ls", "list"]);
		if (SAFE.has(event.toolName)) return undefined;

		const summary = JSON.stringify(event.input ?? {}, null, 2).slice(0, 1500);

		const ctl = new AbortController();
		try {
			const { decision } = await askApproval(client, chatId, event.toolName, summary, ctl.signal);
			if (decision.remember) {
				console.log(`[pi-telegram] adding ${event.toolName} to always-allow list`);
				addAlwaysAllow(event.toolName);
			}
			if (!decision.approved) return { block: true, reason: "Denied by user in Telegram" };
			return undefined;
		} finally {
			ctl.abort();
		}
	});
}

// --- Helpers ---

function rowsFromButtons(buttons: InlineButton[]): Array<Array<{ text: string; action: string }>> {
	const out: Array<Array<{ text: string; action: string }>> = [];
	for (let i = 0; i < buttons.length; i += 2) {
		out.push(buttons.slice(i, i + 2).map((b) => ({ text: b.text, action: b.action })));
	}
	return out;
}

function extractText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { content?: unknown };
	if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const part of m.content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				parts.push(String((part as { text?: unknown }).text ?? ""));
			}
		}
		return parts.join("");
	}
	return "";
}

function lastAssistant(messages: unknown): unknown {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string };
		if (m?.role === "assistant") return messages[i];
	}
	return null;
}

async function safeTyping(client: TelegramClient, chatId: number): Promise<void> {
	try { await client.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
}
