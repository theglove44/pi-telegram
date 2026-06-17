/**
 * Slash commands exposed to pi from the terminal.
 *
 * The terminal-side handlers here delegate to `commandBody.ts`, which is
 * the same module the Telegram polling handler dispatches into. This keeps
 * the two paths in sync — change once, applies to both.
 *
 * To trigger these from Telegram, send `/<commandName>` in a DM. The
 * polling handler in `index.ts` resolves the slash to a `CommandName` and
 * calls `dispatchTelegramCommand` directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactToken } from "./config.js";
import {
	commandCtxFromTerminal,
	dispatchTelegramCommand,
	type CommandDeps,
} from "./commandBody.js";

export function registerTelegramCommands(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("tgstatus", {
		description: "pi-telegram: show transport, queue, and session info.",
		handler: async (_args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const { text } = await dispatchTelegramCommand("tgstatus", "", c);
			ctx.ui.notify(redactToken(text, deps.getTokenForRedaction() ?? undefined), "info");
		},
	});

	pi.registerCommand("tgabort", {
		description: "pi-telegram: abort the current agent turn.",
		handler: async (_args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const { text } = await dispatchTelegramCommand("tgabort", "", c);
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("tgqueue", {
		description: "pi-telegram: show the inbound turn queue.",
		handler: async (_args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgqueue", "", c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgmodel", {
		description: "pi-telegram: open the model picker (terminal: lists; Telegram: keyboard).",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgmodel", args, c);
			if (r.markup) {
				const client = deps.getClient();
				const chatId = deps.getChatId();
				if (client && chatId !== null) {
					await client.sendMessage(chatId, r.text, { parseMode: "HTML", replyMarkup: r.markup });
					return;
				}
			}
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgthinking", {
		description: "pi-telegram: set the thinking level.",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgthinking", args, c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgtools", {
		description: "pi-telegram: toggle a tool on/off.",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgtools", args, c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgnew", {
		description: "pi-telegram: start a new session.",
		handler: async (_args, ctx) => {
			await ctx.newSession({});
		},
	});

	pi.registerCommand("tgcompact", {
		description: "pi-telegram: compact the session.",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage("/compact", { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("tgreconnect", {
		description: "pi-telegram: force a long-poll reconnect.",
		handler: async (_args, ctx) => {
			await deps.reconnectPolling();
			ctx.ui.notify("telegram: reconnected", "info");
		},
	});

	pi.registerCommand("tgapprove", {
		description: "pi-telegram: manage always-allow list (clears if 'clear' arg).",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgapprove", args, c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgweather", {
		description: "pi-telegram: get weather for a location via Open-Meteo.",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgweather", args, c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgweather-setdefault", {
		description: "pi-telegram: set a default weather location (bare weather queries use it).",
		handler: async (args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgweather-setdefault", args, c);
			ctx.ui.notify(r.text, "info");
		},
	});

	pi.registerCommand("tgweather-cleargetdefault", {
		description: "pi-telegram: clear the default weather location.",
		handler: async (_args, ctx) => {
			const c = await commandCtxFromTerminal(pi, deps.queue, deps, ctx);
			const r = await dispatchTelegramCommand("tgweather-cleargetdefault", "", c);
			ctx.ui.notify(r.text, "info");
		},
	});
}
