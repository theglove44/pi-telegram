/**
 * Long-polling loop with exponential backoff, abort signal, and offset tracking.
 *
 * The loop calls getUpdates in long-poll mode (Telegram holds the connection
 * open for up to N seconds). On any non-auth error we back off and reconnect.
 * The offset is persisted in config so a restart picks up where we left off.
 *
 * The handler is the only callback. It receives one Update at a time.
 * Errors thrown by the handler are caught and logged; the loop continues.
 */

import { setLastUpdateId } from "./config.js";
import type { TelegramClient } from "./transport.js";
import type { TgUpdate } from "./types.js";

const POLL_TIMEOUT_SEC = 25;     // Long-poll window
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface PollingOptions {
	client: TelegramClient;
	chatId: number;
	initialOffset: number;
	signal: AbortSignal;
	/** Called for each update after the allowlist check. Throwing logs and continues. */
	handler: (update: TgUpdate) => Promise<void>;
	/** Optional log sink. */
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

const log = (opts: PollingOptions, level: "info" | "warn" | "error", msg: string) => {
	if (opts.log) opts.log(level, msg);
	else if (level === "error") console.error(`[pi-telegram] ${msg}`);
	else if (level === "warn") console.warn(`[pi-telegram] ${msg}`);
	else console.log(`[pi-telegram] ${msg}`);
};

export async function runPollingLoop(opts: PollingOptions): Promise<void> {
	let offset = opts.initialOffset;
	let backoff = BASE_BACKOFF_MS;
	log(opts, "info", `Polling started (chat ${opts.chatId})`);

	while (!opts.signal.aborted) {
		try {
			const updates = await opts.client.getUpdates(offset, POLL_TIMEOUT_SEC, opts.signal);
			backoff = BASE_BACKOFF_MS;          // successful round-trip → reset backoff
			if (updates.length === 0) {
				// Yield the event loop so a pending AbortSignal macrotask can fire.
				// Without this, a fake client that resolves instantly will tight-loop
				// on microtasks forever and the abort setTimeout never runs.
				await sleep(0, opts.signal);
				continue;
			}
			for (const u of updates) {
				if (opts.signal.aborted) break;
				// Always advance offset past this update, even if we reject it.
				if (u.update_id >= offset) offset = u.update_id + 1;
				setLastUpdateId(u.update_id);

				// Allowlist gate. We accept only the configured chat id.
				const fromChat = u.message?.chat.id ?? u.edited_message?.chat.id ?? u.callback_query?.message?.chat.id;
				if (fromChat === undefined || fromChat !== opts.chatId) {
					log(opts, "warn", `Dropped update ${u.update_id} from non-allowlisted chat ${fromChat ?? "?"}`);
					continue;
				}
				try {
					await opts.handler(u);
				} catch (err) {
					log(opts, "error", `Handler threw on update ${u.update_id}: ${(err as Error).message ?? err}`);
				}
			}
		} catch (err) {
			if (opts.signal.aborted) break;
			const msg = (err as Error).message ?? String(err);
			log(opts, "error", `Polling error: ${msg} — backing off ${backoff}ms`);
			await sleep(backoff, opts.signal);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	}

	log(opts, "info", "Polling stopped");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const t = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
