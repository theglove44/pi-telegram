/**
 * Transport: thin fetch wrapper for api.telegram.org.
 *
 * Only one outbound host. No retries on auth failure (token invalid = fail fast).
 * 429/5xx retries with exponential backoff honouring `Retry-After` if present.
 *
 * Token is held in this module as a closure. It is never written to disk by
 * the transport; that lives in config.ts.
 */

const API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

export class TelegramApiError extends Error {
	constructor(public readonly method: string, public readonly code: number, public readonly description: string) {
		super(`Telegram ${method} failed (${code}): ${description}`);
		this.name = "TelegramApiError";
	}
}

export class TelegramAuthError extends Error {
	constructor(public readonly method: string, public readonly code: number, description: string) {
		super(`Telegram ${method} auth failure (${code}): ${description}`);
		this.name = "TelegramAuthError";
	}
}

export interface TgApiOk<T> {
	ok: true;
	result: T;
}

export interface TgApiErr {
	ok: false;
	error_code: number;
	description: string;
}

export type TgApiResponse<T> = TgApiOk<T> | TgApiErr;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface TelegramClientOptions {
	token: string;
	/** Optional fetch override (for tests). */
	fetchImpl?: typeof fetch;
	/** Default timeout per request. */
	timeoutMs?: number;
}

export class TelegramClient {
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(opts: TelegramClientOptions) {
		this.token = opts.token;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private url(method: string): string {
		return `${API_BASE}/bot${this.token}/${method}`;
	}

	/**
	 * Call a Telegram Bot API method. JSON body. Handles 429/5xx with
	 * bounded retries and `Retry-After` parsing.
	 */
	async call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const url = this.url(method);
		let attempt = 0;
		while (true) {
			attempt += 1;
			const ctl = new AbortController();
			const timeout = setTimeout(() => ctl.abort("timeout"), this.timeoutMs);
			const onParentAbort = () => ctl.abort("parent-abort");
			signal?.addEventListener("abort", onParentAbort, { once: true });
			try {
				const res = await this.fetchImpl(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: body ? JSON.stringify(body) : undefined,
					signal: ctl.signal,
				});
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onParentAbort);

				if (res.status === 401 || res.status === 404) {
					// Auth: token is bad. No retries.
					const txt = await res.text();
					throw new TelegramAuthError(method, res.status, txt.slice(0, 200));
				}

				if (res.status === 429 || res.status >= 500) {
					if (attempt > MAX_RETRIES) {
						const txt = await res.text();
						throw new TelegramApiError(method, res.status, txt.slice(0, 200));
					}
					const retryAfter = Number(res.headers.get("retry-after"));
					const delay = Number.isFinite(retryAfter) && retryAfter > 0
						? retryAfter * 1000
						: Math.min(1000 * 2 ** (attempt - 1), 15_000);
					await sleep(delay, signal);
					continue;
				}

				const data = (await res.json()) as TgApiResponse<T>;
				if (!data.ok) {
					throw new TelegramApiError(method, data.error_code, data.description);
				}
				return data.result;
			} catch (err) {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onParentAbort);
				if (err instanceof TelegramAuthError || err instanceof TelegramApiError) throw err;
				// Network error → retry unless aborted
				if (signal?.aborted) throw new Error("aborted");
				if (attempt > MAX_RETRIES) throw err;
				await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000), signal);
			}
		}
	}

	// --- High-level methods (typed wrappers) ---

	async getMe(): Promise<{ id: number; username?: string; first_name: string }> {
		return this.call("getMe");
	}

	async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<import("./types.js").TgUpdate[]> {
		return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "edited_message", "callback_query"] }, signal);
	}

	async sendMessage(chatId: number, text: string, opts?: { parseMode?: "HTML" | "MarkdownV2"; replyToMessageId?: number; replyMarkup?: unknown }): Promise<import("./types.js").TgMessage> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
			...(opts?.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
			...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
		});
	}

	async sendRichMessage(chatId: number, richMessage: import("./types.js").InputRichMessage, opts?: { replyMarkup?: unknown }): Promise<import("./types.js").TgMessage> {
		return this.call("sendRichMessage", {
			chat_id: chatId,
			rich_message: richMessage,
			...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
		});
	}

	async sendRichMessageDraft(chatId: number, richMessage: import("./types.js").InputRichMessage): Promise<import("./types.js").TgMessage> {
		return this.call("sendRichMessageDraft", {
			chat_id: chatId,
			rich_message: richMessage,
		});
	}

	async editMessageText(chatId: number, messageId: number | undefined, text: string, opts?: { parseMode?: "HTML"; replyMarkup?: unknown; richMessage?: import("./types.js").InputRichMessage }): Promise<import("./types.js").TgMessage> {
		return this.call("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text,
			...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
			...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
			...(opts?.richMessage ? { rich_message: opts.richMessage } : {}),
		});
	}

	async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: unknown): Promise<import("./types.js").TgMessage> {
		return this.call("editMessageReplyMarkup", {
			chat_id: chatId,
			message_id: messageId,
			reply_markup: replyMarkup,
		});
	}

	async sendChatAction(chatId: number, action: "typing" | "record_voice"): Promise<boolean> {
		return this.call("sendChatAction", { chat_id: chatId, action });
	}

	async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
		return this.call("getFile", { file_id: fileId });
	}

	/**
	 * Download a file from Telegram to a local path.
	 * Returns the absolute local path. Caller is responsible for cleanup.
	 */
	async downloadFile(filePath: string, destAbsPath: string): Promise<{ size: number }> {
		const url = `${API_BASE}/file/bot${this.token}/${filePath}`;
		const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
		if (!res.ok) {
			throw new TelegramApiError("downloadFile", res.status, `HTTP ${res.status}`);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(destAbsPath), { recursive: true, mode: 0o700 });
		writeFileSync(destAbsPath, buf, { mode: 0o600 });
		return { size: buf.byteLength };
	}

	async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string; showAlert?: boolean }): Promise<boolean> {
		return this.call("answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			...(opts?.text ? { text: opts.text } : {}),
			...(opts?.showAlert ? { show_alert: true } : {}),
		});
	}
}
