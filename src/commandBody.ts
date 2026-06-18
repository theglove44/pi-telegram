/**
 * Command bodies — pure logic that both the terminal command registry
 * (`commands.ts`) and the Telegram-side polling handler (`index.ts`) call.
 *
 * Why: when a user types `/tgmodel` in the Telegram DM, my polling handler
 * sees the text. If I just forward it as a `pi.sendUserMessage`, pi puts it
 * in the *input queue* — the LLM sees it as a user prompt and answers with
 * "I can't pop a Telegram inline keyboard from this chat context." The LLM
 * has no idea what `/tgmodel` is, and pi's command matcher doesn't re-run
 * for messages injected via `sendUserMessage`.
 *
 * The fix: when the polling handler sees a `/tg*` (or recognised pi core
 * command) from Telegram, it calls these bodies directly. The terminal
 * command registry in `commands.ts` also delegates here, so both paths
 * stay in sync.
 *
 * Each body takes the bits of `ctx` it actually needs and the shared
 * dependencies. It returns either a "send this to Telegram" descriptor or
 * (when invoked from the terminal) a side-effecting call on `ctx.ui`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { TelegramClient } from "./transport.js";
import type { TurnQueue } from "./queue.js";
import {
	keyboardMarkup,
	modelPickerMarkup,
	queueBrowserMarkup,
} from "./inline.js";
import { loadAlwaysAllow, saveAlwaysAllow } from "./inline.js";
import { readDefaultLocation, saveDefaultLocation } from "./config.js";
import { isForecastQuery, weatherReplyRich, weatherReplyForecastRich } from "./weather.js";
import { plainFromRichHtml } from "./richMessage.js";
import type { InputRichMessage } from "./types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

/** Cache of the auth provider set so we don't re-read auth.json on every command. */
let cachedAuthProviders: ReadonlySet<string> | null = null;
let cachedAuthAt = 0;
const AUTH_CACHE_MS = 5_000;

/** Read the set of providers that have a configured API key. */
export async function getAvailableProviders(): Promise<ReadonlySet<string>> {
	const now = Date.now();
	if (cachedAuthProviders && now - cachedAuthAt < AUTH_CACHE_MS) {
		return cachedAuthProviders;
	}
	try {
		const auth = await AuthStorage.create();
		cachedAuthProviders = new Set(auth.list());
	} catch {
		cachedAuthProviders = new Set();
	}
	cachedAuthAt = now;
	return cachedAuthProviders;
}

/** Clear the cache (e.g. on `/tgapprove` or any command that mutates auth). */
export function invalidateAuthCache(): void {
	cachedAuthProviders = null;
}

export interface ModelRegistryLike {
	getAll: () => Array<{ id: string; provider: string; name?: string; reasoning?: boolean }>;
	find: (provider: string, id: string) => Model<Api> | undefined;
}

export interface CommandCtx {
	pi: ExtensionAPI;
	registry: ModelRegistryLike;
	queue: TurnQueue;
	/** TelegramClient or null (null = terminal-only path). */
	client: TelegramClient | null;
	chatId: number | null;
	/** Current model id in `provider/id` form, or null. */
	currentModelId: string | null;
	/**
	 * List of providers that have a configured API key. The model picker
	 * uses this to filter out models the user can't actually call. Pi's
	 * full ModelRegistry has ~1000 entries (aggregators, model routers,
	 * providers you don't have keys for); the picker should be short and
	 * useful, not exhaustive.
	 *
	 * Pass an empty set to mean "no providers configured" (pick returns
	 * "no models"). Pass `null` to mean "no filter — show everything
	 * from the registry" (only use for diagnostic/debugging).
	 */
	availableProviders: ReadonlySet<string> | null;
	/** Notify back to the terminal (only used in terminal path). */
	notify: (text: string, level: "info" | "warning" | "error") => void;
	/** Interactive select (only used in terminal path). */
	select: (title: string, options: string[]) => Promise<string | null>;
	/** Confirm (only used in terminal path). */
	confirm: (title: string, body: string) => Promise<boolean>;
	/** Abort the current turn. */
	abort: () => void;
	/** Force a polling reconnect. */
	reconnectPolling: () => Promise<void>;
	/** Start a new session (only terminal path). */
	newSession: (() => Promise<void>) | null;
	/** Append a follow-up user message. */
	sendFollowUp: (text: string) => void;
}

/** Get the model list as a flat array. */
export function listModels(registry: ModelRegistryLike): Array<{ provider: string; id: string; name?: string; reasoning?: boolean }> {
	return registry.getAll().map((m) => {
		const out: { provider: string; id: string; name?: string; reasoning?: boolean } = {
			provider: m.provider,
			id: m.id,
		};
		if (m.name !== undefined) out.name = m.name;
		if (m.reasoning !== undefined) out.reasoning = m.reasoning;
		return out;
	});
}

/** Filter the model list to only providers with configured API keys. */
export function listAvailableModels(ctx: CommandCtx): Array<{ provider: string; id: string; name?: string; reasoning?: boolean }> {
	const all = listModels(ctx.registry);
	if (ctx.availableProviders === null) return all;     // no filter
	return all.filter((m) => ctx.availableProviders!.has(m.provider));
}

/**
 * Build a model picker keyboard + message text.
 *
 * The picker shows ONLY models for providers with a configured API key
 * (via `ctx.availableProviders`). The header lists the available providers
 * so the user knows what's in scope, and includes a hint for dynamic-
 * catalog providers (like ollama-cloud) where the registry doesn't know
 * the model ids up front.
 */
export function modelPickerBody(ctx: CommandCtx, page = 0): { text: string; markup: unknown } {
	const available = listAvailableModels(ctx);
	const providers = ctx.availableProviders === null
		? [...new Set(available.map((m) => m.provider))].sort()
		: [...ctx.availableProviders].sort();
	const providerList = providers.length > 0 ? providers.join(", ") : "(none)";

	if (available.length === 0) {
		// No static models for the available providers. The user has keys
		// for providers (e.g. ollama-cloud) whose catalogs are dynamic.
		// Tell them how to set the model by name.
		const hint = providers.length > 0
			? `Available providers (${providers.length}): <code>${escapeHtml(providers.join(", "))}</code>.\n\n` +
				`Their model catalogs are loaded on demand. To switch, type:\n` +
				providers.map((p) => `<code>/tgmodel ${p}/&lt;model-id&gt;</code>`).join("\n")
			: "No providers have a configured API key. Add a key to auth.json or set an env var, then restart pi.";
		return { text: `<b>No static models for the configured providers</b>\n\n${hint}`, markup: undefined };
	}

	const total = available.length;
	const perPage = 8;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const start = page * perPage;
	const slice = available.slice(start, start + perPage);
	const text = `<b>Pick a model</b>\n` +
		`Available providers: <code>${escapeHtml(providerList)}</code>\n` +
		`Showing ${start + 1}–${Math.min(start + perPage, total)} of ${total}` +
		(totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : "");

	const markup = modelPickerMarkup(available, page, perPage, ctx.currentModelId ?? undefined);
	return { text, markup };
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Apply a model selection. Returns the human-readable result. */
export async function applyModelBody(ctx: CommandCtx, provider: string, id: string): Promise<string> {
	const m = ctx.registry.find(provider, id);
	if (!m) return `unknown model: ${provider}/${id}`;
	const ok = await ctx.pi.setModel(m);
	return ok ? `✓ model: ${provider}/${id}` : `setModel(${provider}/${id}) failed (no API key?)`;
}

export function statusBody(ctx: CommandCtx): string {
	const providers = ctx.availableProviders === null
		? "(filter disabled)"
		: ([...ctx.availableProviders].sort().join(", ") || "(none)");
	const lines: string[] = [
		`bot: ${ctx.client ? "connected" : "not connected"}`,
		`chat: ${ctx.chatId ?? "(unset)"}`,
		`queue: ${ctx.queue.size} item(s)`,
		`model: ${ctx.currentModelId ?? "(none)"}`,
		`thinking: ${ctx.pi.getThinkingLevel()}`,
		`active tools: ${ctx.pi.getActiveTools().join(", ") || "(none)"}`,
		`available providers: ${providers}`,
	];
	return lines.join("\n");
}

export function queueBody(ctx: CommandCtx): { text: string; markup: unknown } {
	const items = ctx.queue.list();
	if (items.length === 0) {
		return { text: "queue empty", markup: undefined };
	}
	const counts = { pending: 0, running: 0, completed: 0 };
	for (const i of items) {
		if (counts[i.status] !== undefined) counts[i.status] += 1;
	}
	const text = `<b>Queue (${items.length})</b>\n` +
		`pending: ${counts.pending}  running: ${counts.running}  completed: ${counts.completed}`;
	const markup = queueBrowserMarkup(items);
	return { text, markup };
}

export function thinkingBody(arg: string): { level: ThinkingLevel | null; hint: string } {
	const a = arg.trim().toLowerCase();
	if ((THINKING_LEVELS as readonly string[]).includes(a)) {
		return { level: a as ThinkingLevel, hint: "" };
	}
	return { level: null, hint: THINKING_LEVELS.join(" | ") };
}

export function applyThinkingBody(ctx: CommandCtx, level: ThinkingLevel): string {
	ctx.pi.setThinkingLevel(level);
	return `thinking: ${level}`;
}

export function toolsBody(ctx: CommandCtx, arg: string): { text: string; all: string[] } {
	const all = ctx.pi.getAllTools().map((t) => t.name);
	return { text: arg.trim(), all };
}

export function applyToggleToolBody(ctx: CommandCtx, name: string): string {
	const cur = ctx.pi.getActiveTools();
	const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
	ctx.pi.setActiveTools(next);
	return `${name}: ${cur.includes(name) ? "off" : "on"}`;
}

export function approveListBody(): string {
	const list = loadAlwaysAllow().tools;
	return `always-allow (${list.length}):\n${list.join("\n") || "(empty)"}`;
}

export function approveClearBody(): string {
	saveAlwaysAllow([]);
	return "always-allow list cleared";
}

// --- Dispatcher used by the Telegram polling handler ---

export type CommandName =
	| "tgstatus" | "tgabort" | "tgqueue" | "tgmodel" | "tgthinking"
	| "tgtools" | "tgnew" | "tgcompact" | "tgreconnect" | "tgapprove" | "tgweather" | "tgweather-setdefault" | "tgweather-cleargetdefault"
	| "model" | "thinking" | "queue" | "status" | "compact" | "new" | "abort" | "modelpage";

/** Result returned by {@link dispatchTelegramCommand}. */
export interface CommandResult {
	text: string;
	markup?: unknown;
	richMessage?: InputRichMessage;
	toast?: { level: "info" | "warning" | "error" };
}

/**
 * Dispatch a command from Telegram. Returns the body that the caller should
 * send back to the user. The caller is responsible for actually calling
 * `client.sendMessage` / `client.sendRichMessage` (with any markup).
 *
 * For commands that produce an inline keyboard (model, queue), the caller
 * sends a message with `replyMarkup: result.markup`.
 *
 * For commands that have an immediate side effect (abort, reconnect, tool
 * toggle, new, compact), the side effect is taken on `ctx` and the result
 * is just a confirmation string.
 *
 * For commands that can use Telegram Bot API 10.1 Rich Messages, the result
 * includes `richMessage`; the caller should prefer `sendRichMessage` and fall
 * back to `text` if the Bot API rejects it.
 */
export async function dispatchTelegramCommand(
	name: CommandName,
	args: string,
	ctx: CommandCtx,
): Promise<CommandResult> {
	switch (name) {
		case "tgstatus":
		case "status": {
			return { text: statusBody(ctx) };
		}
		case "tgabort":
		case "abort": {
			ctx.abort();
			return { text: "abort requested" };
		}
		case "tgqueue":
		case "queue": {
			return queueBody(ctx);
		}
		case "tgmodel":
		case "model": {
			// If args look like provider/id, apply directly. Otherwise open the picker.
			const a = args.trim();
			if (a.includes("/")) {
				const [provider, id] = a.split("/", 2);
				if (provider && id) {
					return { text: await applyModelBody(ctx, provider, id) };
				}
			}
			return modelPickerBody(ctx, 0);
		}
		case "modelpage": {
			const page = Number(args.trim()) || 0;
			return modelPickerBody(ctx, page);
		}
		case "tgthinking":
		case "thinking": {
			const { level, hint } = thinkingBody(args);
			if (level) {
				return { text: applyThinkingBody(ctx, level) };
			}
			return { text: `pick a level: ${hint}`, markup: keyboardMarkup(
				THINKING_LEVELS.map((l) => [{ text: l, action: `tgcmd:thinking:${l}` }]),
			) };
		}
		case "tgtools": {
			const { all } = toolsBody(ctx, args);
			if (all.length === 0) return { text: "no tools available" };
			return {
				text: "toggle a tool:",
				markup: keyboardMarkup(all.map((n) => [{ text: n, action: `tgcmd:tooltoggle:${n}` }])),
			};
		}
		case "tgnew":
		case "new": {
			if (ctx.newSession) await ctx.newSession();
			return { text: "new session requested" };
		}
		case "tgcompact":
		case "compact": {
			// /compact is a pi core command; we don't have a programmatic
			// `compact()` exposed on the api, so we send it as a follow-up
			// user message — pi's input layer will then route it to the
			// core /compact command.
			ctx.sendFollowUp("/compact");
			return { text: "→ /compact queued" };
		}
		case "tgreconnect": {
			await ctx.reconnectPolling();
			return { text: "telegram: reconnected" };
		}
		case "tgapprove": {
			if (args.trim() === "clear") {
				return { text: approveClearBody() };
			}
			return { text: approveListBody() };
		}
		case "tgweather": {
			const query = args.trim();
			if (!query) {
				return { text: "Usage: /tgweather \u003clocation\u003e\nExamples: /tgweather London, /tgweather Tokyo, Japan\nFor forecasts: /tgweather forecast London or /tgweather London this week" };
			}
			// Check if the query is a forecast request.
			// Try the bare query first (e.g. "forecast London"), then with
			// "weather in " prefix (e.g. "London this week").
			let forecastMatch = isForecastQuery(query);
			if (!forecastMatch) {
				forecastMatch = isForecastQuery("weather in " + query);
			}
			if (forecastMatch) {
				const loc = forecastMatch.location || readDefaultLocation();
				if (!loc) return { text: "❌ Tell me the location. Usage: /tgweather forecast London" };
				try {
					const rich = await weatherReplyForecastRich(loc);
					return { text: plainFromRichHtml(rich.html ?? ""), richMessage: rich };
				} catch (err) {
					return { text: `❌ Forecast lookup failed: ${(err as Error).message}` };
				}
			}
			try {
				const rich = await weatherReplyRich(query);
				return { text: plainFromRichHtml(rich.html ?? ""), richMessage: rich };
			} catch (err) {
				return { text: `❌ Weather lookup failed: ${(err as Error).message}` };
			}
		}
		case "tgweather-setdefault": {
			const loc = args.trim();
			if (!loc) {
				const current = readDefaultLocation();
				return { text: current ? `Default weather location: ${current}` : "No default weather location set. Usage: /tgweather-setdefault \u003clocation\u003e" };
			}
			saveDefaultLocation(loc);
			return { text: `✓ Default weather location set to: ${loc}` };
		}
		case "tgweather-cleargetdefault": {
			saveDefaultLocation(undefined);
			return { text: "✓ Default weather location cleared" };
		}
	}
}

// --- Map from `tgcmd:...` callback data to action handlers ---

export async function dispatchTgCmdCallback(
	action: string,
	ctx: CommandCtx,
): Promise<{ text: string; markup?: unknown }> {
	// Format: tgcmd:<verb>:<arg...>
	const parts = action.split(":");
	if (parts.length < 3 || parts[0] !== "tgcmd") return { text: "unknown action" };
	const verb = parts[1] ?? "";
	const arg = parts.slice(2).join(":");
	switch (verb) {
		case "model": {
			const [provider, id] = arg.split("/", 2);
			if (!provider || !id) return { text: "bad model" };
			return { text: await applyModelBody(ctx, provider, id) };
		}
		case "modelpage": {
			const page = Number(arg) || 0;
			return modelPickerBody(ctx, page);
		}
		case "thinking": {
			return { text: applyThinkingBody(ctx, arg as ThinkingLevel) };
		}
		case "tooltoggle": {
			return { text: applyToggleToolBody(ctx, arg) };
		}
		default:
			return { text: `unknown verb: ${verb}` };
	}
}

/** Build a CommandCtx from a terminal command invocation. */
export async function commandCtxFromTerminal(
	pi: ExtensionAPI,
	queue: TurnQueue,
	args: CommandDeps,
	terminalCtx: ExtensionCommandContext,
): Promise<CommandCtx> {
	return {
		pi,
		registry: terminalCtx.modelRegistry,
		queue,
		client: args.getClient(),
		chatId: args.getChatId(),
		currentModelId: terminalCtx.model ? `${terminalCtx.model.provider}/${terminalCtx.model.id}` : null,
		availableProviders: await getAvailableProviders(),
		notify: (text, level) => terminalCtx.ui.notify(text, level),
		select: async (title, options) => (await terminalCtx.ui.select(title, options)) ?? null,
		confirm: async (title, body) => (await terminalCtx.ui.confirm(title, body)) ?? false,
		abort: () => terminalCtx.abort(),
		reconnectPolling: args.reconnectPolling,
		newSession: async () => { await terminalCtx.newSession({}); },
		sendFollowUp: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
	};
}

export interface CommandDeps {
	getClient: () => TelegramClient | null;
	getChatId: () => number | null;
	queue: TurnQueue;
	reconnectPolling: () => Promise<void>;
	getTokenForRedaction: () => string | null;
}
