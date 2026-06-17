/**
 * pi-telegram extension entry point.
 *
 * Wires:
 *   - Polling loop (long-poll getUpdates; flock-guarded singleton)
 *   - Lifecycle event hooks (reply routing, draft streaming, permission gate)
 *   - Slash commands (model picker, thinking, tools, queue, status, abort, setup)
 *
 * Security model:
 *   - Bot token: GNOME keyring (`secret-tool`) → env var fallback. Never on disk in plaintext.
 *   - Allowlist: one chat_id; all other updates are dropped silently.
 *   - Singleton: O_EXCL pidfile at ~/.pi/agent/telegram.lock — two pi processes cannot both poll.
 *   - No `child_process.spawn` on update-derived content. No exec template engine.
 *
 * Install (local path):
 *   Add to ~/.pi/agent/settings.json:
 *     "extensions": ["/home/christof21/Projects/pi-telegram"]
 *   Then `cd /home/christof21/Projects/pi-telegram && npm install`.
 *
 * First run:
 *   pi -e /home/christof21/Projects/pi-telegram/index.ts
 *   /telegram-setup
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { TurnQueue } from "./src/queue.js";
import { TelegramClient } from "./src/transport.js";
import { runPollingLoop } from "./src/polling.js";
import { registerTelegramCommands } from "./src/commands.js";
import { registerLifecycleHandlers } from "./src/lifecycle.js";
import { tryAcquirePollingLock } from "./src/lock.js";
import {
	loadConfig,
	writeTokenToKeyring,
	saveConfigFile,
	keyringAvailable,
	readDefaultLocation,
} from "./src/config.js";
import { buildTurnFromMessage, annotateForPi } from "./src/turns.js";
import { dispatchCallback } from "./src/inline.js";
import type { TgUpdate } from "./src/types.js";
import {
	dispatchTelegramCommand,
	dispatchTgCmdCallback,
	getAvailableProviders,
	type CommandCtx,
	type ModelRegistryLike,
} from "./src/commandBody.js";
import { extractLocation, weatherReply } from "./src/weather.js";

export default function (pi: ExtensionAPI): void {
	const queue = new TurnQueue();
	let client: TelegramClient | null = null;
	let chatId: number | null = null;
	let lock: { release: () => Promise<void> } | null = null;
	let pollCtl: AbortController | null = null;
	let pollTask: Promise<void> | null = null;
	let currentModel: { provider: string; id: string } | null = null;
	// True while pi is running an agent turn (from any source: terminal or Telegram).
	// We track this so Telegram messages queue instead of being dropped.
	let isAgentBusy = false;
	let modelRegistry: ModelRegistryLike | null = null;

	pi.on("model_select", async (event) => {
		currentModel = { provider: event.model.provider, id: event.model.id };
	});

	const dispatchNext = async (): Promise<void> => {
		if (isAgentBusy) return;
		const turn = queue.startNext();
		if (!turn) return;
		if (!client || chatId === null) return;
		isAgentBusy = true;
		const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
			{ type: "text", text: turn.text },
		];
		if (turn.images?.[0]) {
			content.push({ type: "image", data: turn.images[0].data, mimeType: turn.images[0].mimeType });
		}
		try {
			// deliverAs: "followUp" is required whenever the agent isn't fully
			// idle. Even with our own single-in-flight queue, pi may consider
			// itself "already processing" during state transitions.
			pi.sendUserMessage(content as unknown as Parameters<typeof pi.sendUserMessage>[0], { deliverAs: "followUp" });
		} catch (err) {
			console.error(`[pi-telegram] dispatch failed: ${(err as Error).message}`);
			isAgentBusy = false;
		}
	};

	const onAgentStart = async (): Promise<void> => {
		isAgentBusy = true;
	};

	const onAgentEnd = async (): Promise<void> => {
		queue.completeRunning();
		isAgentBusy = false;
		// If another Telegram message is queued, dispatch it now.
		await dispatchNext();
	};

	const reconnectPolling = async (): Promise<void> => {
		pollCtl?.abort();
		if (pollTask) { try { await pollTask; } catch { /* ignore */ } }
		if (lock) { try { await lock.release(); } catch { /* ignore */ } lock = null; }
		await startPolling();
	};

	const startPolling = async (): Promise<void> => {
		const lk = await tryAcquirePollingLock();
		if (!lk) {
			console.warn("[pi-telegram] another pi instance owns the polling lock — not starting");
			return;
		}
		lock = lk;
		try {
			const cfg = await loadConfig();
			if (!cfg.allowedChatId || cfg.allowedChatId <= 0) {
				console.error("[pi-telegram] no allowedChatId configured; run /telegram-setup");
				if (lock) { try { await lock.release(); } catch { /* ignore */ } lock = null; }
				return;
			}
			chatId = cfg.allowedChatId;
			const c = new TelegramClient({ token: cfg.botToken });
			client = c;
			const me = await c.getMe();
			console.log(`[pi-telegram] bot @${me.username ?? me.first_name} (id ${me.id}) for chat ${cfg.allowedChatId}`);

			// Register the command menu so Telegram shows suggestions when the user types "/".
			try {
				await c.call("setMyCommands", {
					commands: [
						{ command: "tgstatus", description: "Show bot status, queue, model, tools" },
						{ command: "tgqueue", description: "Show the inbound turn queue" },
						{ command: "tgabort", description: "Abort the current agent turn" },
						{ command: "tgmodel", description: "Open the model picker" },
						{ command: "tgthinking", description: "Set thinking level" },
						{ command: "tgtools", description: "Toggle tools on/off" },
						{ command: "tgnew", description: "Start a new session" },
						{ command: "tgcompact", description: "Compact the session" },
						{ command: "tgreconnect", description: "Force a long-poll reconnect" },
						{ command: "tgapprove", description: "Manage always-allow list" },
						{ command: "tgweather", description: "Get weather for a location" },
					],
				});
				console.log("[pi-telegram] command menu registered with Telegram");
			} catch (err) {
				console.warn(`[pi-telegram] setMyCommands failed: ${(err as Error).message}`);
			}

			pollCtl = new AbortController();
			pollTask = runPollingLoop({
				client: c,
				chatId: cfg.allowedChatId,
				initialOffset: cfg.lastUpdateId,
				signal: pollCtl.signal,
				log: (level, msg) => {
					if (level === "error") console.error(`[pi-telegram] ${msg}`);
					else if (level === "warn") console.warn(`[pi-telegram] ${msg}`);
				},
				handler: async (u: TgUpdate) => {
					await handleUpdate(c, cfg.allowedChatId, u, queue, buildCommandCtx, () => isAgentBusy, dispatchNext);
				},
			}).catch((err) => {
				console.error(`[pi-telegram] polling terminated: ${(err as Error).message}`);
			});
		} catch (err) {
			console.error(`[pi-telegram] start failed: ${(err as Error).message}`);
			if (lock) { try { await lock.release(); } catch { /* ignore */ } lock = null; }
		}
	};

	// Build a CommandCtx from the polling closure's state. Used by both the
	// polling handler (for /tg* and core commands from Telegram) and by the
	// callback handler (for inline-keyboard actions). `availableProviders`
	// is resolved async at command-dispatch time (see handleUpdate).
	const buildCommandCtx = (): CommandCtx => ({
		pi,
		registry: modelRegistry ?? stubRegistry(),
		queue,
		client,
		chatId,
		currentModelId: currentModel ? `${currentModel.provider}/${currentModel.id}` : null,
		availableProviders: null,         // resolved at dispatch time
		notify: () => { /* no-op in polling scope */ },
		select: async () => null,
		confirm: async () => false,
		abort: () => { /* can't abort from polling scope — needs ctx */ },
		reconnectPolling,
		newSession: null,
		sendFollowUp: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
	});

	// Lifecycle events: streaming, agent_end, tool_call permission gate.
	registerLifecycleHandlers({
		pi,
		getClient: () => client,
		getChatId: () => chatId,
		onAgentStart,
		onAgentEnd,
	});

	// Terminal slash commands: /tgstatus, /tgqueue, /tgmodel, etc. These have
	// proper ctx, so we capture a fresh model-registry snapshot from the
	// terminal ctx every time the user runs one.
	registerTelegramCommands(pi, {
		getClient: () => client,
		getChatId: () => chatId,
		queue,
		reconnectPolling,
		getTokenForRedaction: () => null,
	});

	// /telegram-setup: one-shot interactive configuration.
	pi.registerCommand("telegram-setup", {
		description: "pi-telegram: configure the bot token, allowed chat id, and keyring.",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const want = arg === "--yes"
				? true
				: await ctx.ui.confirm(
					"pi-telegram setup",
					"Configure bot token + allowed chat id now? (token is stored in the GNOME keyring)",
				);
			if (!want) return;

			const hasKeyring = await keyringAvailable();
			if (!hasKeyring) {
				ctx.ui.notify("secret-tool not found. Install libsecret-tools: `sudo apt install libsecret-tools`.", "error");
				return;
			}

			const token = ((await ctx.ui.input("Bot token (from @BotFather):", "")) ?? "").trim();
			if (!token) { ctx.ui.notify("setup cancelled (no token)", "warning"); return; }

			const chatRaw = ((await ctx.ui.input("Your numeric Telegram chat id:", "")) ?? "").trim();
			const chat = Number(chatRaw);
			if (!Number.isFinite(chat) || chat <= 0) { ctx.ui.notify("invalid chat id", "error"); return; }

			await writeTokenToKeyring(token);
			const me = await new TelegramClient({ token }).getMe();
			saveConfigFile({ botUsername: me.username, botId: me.id, allowedChatId: chat, lastUpdateId: 0 });
			ctx.ui.notify(`saved token to keyring, allowed chat = ${chat}, bot @${me.username ?? me.first_name} (id ${me.id})`, "info");
			console.log(`[pi-telegram] setup complete: chat ${chat} allowed, bot @${me.username ?? me.first_name}`);
		},
	});

	// session_start: snapshot the model registry (it's only on ctx here),
	// then start the polling loop. We snapshot in a `pi.on("session_start")`
	// handler so the registry is fresh on `/reload` too.
	pi.on("session_start", async (_event, ctx) => {
		modelRegistry = ctx.modelRegistry as ModelRegistryLike;
		if (ctx.model) currentModel = { provider: ctx.model.provider, id: ctx.model.id };
		await startPolling();
	});

	// session_shutdown: clean up.
	pi.on("session_shutdown", async () => {
		pollCtl?.abort();
		pollCtl = null;
		if (lock) { try { await lock.release(); } catch { /* ignore */ } lock = null; }
		client = null;
		chatId = null;
	});
}

async function handleUpdate(
	client: TelegramClient,
	chatId: number,
	u: TgUpdate,
	queue: TurnQueue,
	buildCommandCtx: () => CommandCtx,
	getIsAgentBusy: () => boolean,
	dispatchNext: () => Promise<void>,
): Promise<void> {
	if (u.callback_query) {
		const data = u.callback_query.data ?? "";
		try { await client.answerCallbackQuery(u.callback_query.id); } catch { /* ignore */ }
		await handleCallback(client, chatId, data, u.callback_query.id, queue, buildCommandCtx);
		return;
	}
	const msg = u.message;
	if (!msg) return;

	const text = (msg.text ?? "").trim();

	// If this is a recognised slash command, dispatch it directly to the
	// command body (NOT as a user message — the LLM doesn't know what
	// /tgmodel is, and pi's command matcher doesn't re-run for messages
	// injected via sendUserMessage).
	if (text.startsWith("/")) {
		const dispatched = await tryDispatchTelegramCommand(client, chatId, text, buildCommandCtx);
		if (dispatched) return;
		// Not a recognised pi-telegram command. Forward the raw text to
		// pi so the LLM can see it (e.g. user typed a slash command we
		// don't intercept, like /help or something).
		const ctx = buildCommandCtx();
		ctx.pi.sendUserMessage(text, { deliverAs: "followUp" });
		try { await client.sendMessage(chatId, "📨 sent to pi", {}); } catch { /* ignore */ }
		return;
	}

	// Build the turn and enqueue it. We manage the queue ourselves so that
	// multiple Telegram messages sent while pi is busy don't get dropped by
	// pi.sendUserMessage's "Agent is already processing" error.

	// First, intercept plain-English weather questions (e.g. "what's the
	// weather in London?") so they don't have to round-trip through the LLM.
	const weatherLocation = extractLocation(text) ?? readDefaultLocation();
	if (weatherLocation !== undefined && weatherLocation !== null) {
		if (!weatherLocation) {
			try { await client.sendMessage(chatId, "🌍 Tell me the location: e.g. \"/tgweather London\" or \"weather in Tokyo\"", {}); } catch { /* ignore */ }
			return;
		}
		try {
			try { await client.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
			const reply = await weatherReply(weatherLocation);
			const parseMode = /<[a-z]/.test(reply) ? "HTML" : undefined;
			try { await client.sendMessage(chatId, reply, { parseMode }); } catch (err) {
				console.error(`[pi-telegram] weather reply failed: ${(err as Error).message}`);
			}
		} catch (err) {
			console.error(`[pi-telegram] weather lookup failed: ${(err as Error).message}`);
			try { await client.sendMessage(chatId, `❌ Weather lookup failed: ${(err as Error).message}`, {}); } catch { /* ignore */ }
		}
		return;
	}

	const built = await buildTurnFromMessage(client, msg);
	const composed = annotateForPi(msg, "msg") + (built.files.length > 0
		? `\n\n[attached files: ${built.files.map((f) => f.name).join(", ")}]`
		: "");
	queue.enqueue({
		text: composed,
		images: built.images,
		files: built.files,
		telegramMessageId: msg.message_id,
	});

	const position = queue.pendingCount();
	const ack = position > 1
		? `📨 queued (${position} pending)`
		: getIsAgentBusy()
			? "📨 queued (waiting for current turn)"
			: "📨 received";
	try { await client.sendMessage(chatId, ack, {}); } catch (err) {
		console.error(`[pi-telegram] ack failed: ${(err as Error).message}`);
	}

	// If pi is idle, dispatch immediately. Otherwise it will be dispatched
	// by onAgentEnd when the current turn finishes.
	if (!getIsAgentBusy()) {
		await dispatchNext();
	}
}

/** Return true if the text was handled as a command and a reply was sent. */
async function tryDispatchTelegramCommand(
	client: TelegramClient,
	chatId: number,
	text: string,
	buildCommandCtx: () => CommandCtx,
): Promise<boolean> {
	// Strip the leading `/` and split into command + args.
	const stripped = text.replace(/^\//, "");
	const spaceIdx = stripped.search(/\s/);
	const name = (spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx)).toLowerCase();
	const args = spaceIdx === -1 ? "" : stripped.slice(spaceIdx + 1);

	// Recognised commands. We use the same name set as the terminal
	// `registerCommand` calls in commands.ts (without the `tg` prefix where
	// we want to alias a core pi command).
	const known = new Set([
		"tgstatus", "tgabort", "tgqueue", "tgmodel", "tgthinking",
		"tgtools", "tgnew", "tgcompact", "tgreconnect", "tgapprove", "tgweather",
		"status", "abort", "queue", "model", "thinking", "compact", "new",
	]);
	if (!known.has(name)) return false;

	const baseCtx = buildCommandCtx();
	const providers = await getAvailableProviders();
	const ctx: CommandCtx = { ...baseCtx, availableProviders: providers };
	const r = await dispatchTelegramCommand(name as Parameters<typeof dispatchTelegramCommand>[0], args, ctx);
	const opts: { parseMode?: "HTML"; replyMarkup?: unknown } = {};
	if (r.markup) opts.replyMarkup = r.markup;
	// Use HTML for commands that may have markup, plain text otherwise.
	const parseMode = /<[a-z]/.test(r.text) ? "HTML" : undefined;
	if (parseMode) opts.parseMode = parseMode;
	try { await client.sendMessage(chatId, r.text, opts); } catch (err) {
		console.error(`[pi-telegram] sendMessage failed: ${(err as Error).message}`);
	}
	return true;
}

async function handleCallback(
	client: TelegramClient,
	chatId: number,
	data: string,
	callbackQueryId: string,
	queue: TurnQueue,
	buildCommandCtx: () => CommandCtx,
): Promise<void> {
	const ctx = buildCommandCtx();

	// Queue mutations (kept inline; they don't need a command body).
	if (data.startsWith("tprior:")) {
		const id = data.slice("tprior:".length);
		for (const t of queue.list()) {
			if (t.id === id) { queue.prioritise(t.telegramMessageId); break; }
		}
		return;
	}
	if (data.startsWith("tdrop:")) {
		const id = data.slice("tdrop:".length);
		for (const t of queue.list()) {
			if (t.id === id) { queue.removeByMessageId(t.telegramMessageId); break; }
		}
		return;
	}
	if (data === "tclear") {
		const cleared = queue.clearPending();
		try { await client.sendMessage(chatId, `cleared ${cleared} pending item(s)`, {}); } catch { /* ignore */ }
		return;
	}

	// New unified tgcmd:... actions (model picker, thinking, tools).
	if (data.startsWith("tgcmd:")) {
		const baseCtx = buildCommandCtx();
		const providers = await getAvailableProviders();
		const ctx: CommandCtx = { ...baseCtx, availableProviders: providers };
		const r = await dispatchTgCmdCallback(data, ctx);
		const opts: { parseMode?: "HTML"; replyMarkup?: unknown } = {};
		if (r.markup) opts.replyMarkup = r.markup;
		if (/<[a-z]/.test(r.text)) opts.parseMode = "HTML";
		try { await client.sendMessage(chatId, r.text, opts); } catch (err) {
			console.error(`[pi-telegram] sendMessage failed: ${(err as Error).message}`);
		}
		return;
	}

	// Approval buttons from src/inline.ts (app:yes:nonce / app:no:nonce / app:always:nonce).
	// These resolve the pending askApproval() promise and let the tool_call handler proceed.
	console.log(`[pi-telegram] approval callback: ${data}`);
	const handled = await dispatchCallback(data);
	if (!handled) {
		console.warn(`[pi-telegram] no approval handler for callback: ${data}`);
		try { await client.answerCallbackQuery(callbackQueryId, { text: "approval prompt expired or unknown", showAlert: true }); } catch { /* ignore */ }
	}
	return;
}

/** Empty registry used when nothing has been snapshotted yet. */
function stubRegistry(): ModelRegistryLike {
	const empty: Array<{ id: string; provider: string; name?: string; reasoning?: boolean }> = [];
	return {
		getAll: () => empty,
		find: (): Model<Api> | undefined => undefined,
	};
}
