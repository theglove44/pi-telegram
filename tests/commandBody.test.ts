/**
 * Tests for src/commandBody.ts — the command dispatcher used by both the
 * terminal command registry and the Telegram polling handler.
 *
 * These tests don't go through Telegram or pi; they exercise the pure
 * command bodies and dispatcher with a hand-rolled CommandCtx.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnQueue } from "../src/queue.ts";
import {
	dispatchTelegramCommand,
	dispatchTgCmdCallback,
	listModels,
	modelPickerBody,
	statusBody,
	queueBody,
	approveListBody,
	approveClearBody,
	type CommandCtx,
	type ModelRegistryLike,
} from "../src/commandBody.ts";

function makeCtx(overrides?: Partial<CommandCtx>): { ctx: CommandCtx; setModel: ReturnType<typeof makeSetModel>; notifyCalls: Array<{ text: string; level: string }> } {
	const setModel = makeSetModel();
	const notifyCalls: Array<{ text: string; level: string }> = [];
	const ctx: CommandCtx = {
		pi: {
			setModel: setModel.fn,
			getThinkingLevel: () => "medium",
			getActiveTools: () => ["read", "bash"],
			getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }] as never,
		} as unknown as CommandCtx["pi"],
		registry: {
			getAll: () => [
				{ id: "claude-sonnet-4-5", provider: "anthropic" },
				{ id: "gpt-4o", provider: "openai" },
				{ id: "gemini-2.5-pro", provider: "google" },
			],
			find: (p, i) => ({ id: i, provider: p } as never),
		},
		queue: new TurnQueue(),
		client: null,
		chatId: null,
		currentModelId: "anthropic/claude-sonnet-4-5",
		availableProviders: null,
		notify: (text, level) => { notifyCalls.push({ text, level }); },
		select: async () => null,
		confirm: async () => false,
		abort: () => { /* noop */ },
		reconnectPolling: async () => { /* noop */ },
		newSession: null,
		sendFollowUp: () => { /* noop */ },
		...overrides,
	};
	return { ctx, setModel, notifyCalls };
}

function makeSetModel() {
	const calls: Array<{ provider: string; id: string }> = [];
	return {
		fn: async (m: { provider: string; id: string }) => {
			calls.push({ provider: m.provider, id: m.id });
			return true;
		},
		calls: () => calls,
	};
}

test("listModels maps getAll() into a flat list", () => {
	const reg: ModelRegistryLike = {
		getAll: () => [
			{ id: "a", provider: "p1", name: "Model A" },
			{ id: "b", provider: "p2", name: "Model B" },
		],
		find: () => undefined,
	};
	const out = listModels(reg);
	assert.equal(out.length, 2);
	assert.deepEqual(out[0], { id: "a", provider: "p1", name: "Model A" });
});

test("statusBody produces a multi-line status", () => {
	const { ctx } = makeCtx();
	const out = statusBody(ctx);
	assert.match(out, /bot: not connected/);
	assert.match(out, /chat: \(unset\)/);
	assert.match(out, /model: anthropic\/claude-sonnet-4-5/);
	assert.match(out, /thinking: medium/);
	assert.match(out, /active tools: read, bash/);
});

test("queueBody is empty when the queue is empty", () => {
	const { ctx } = makeCtx();
	const out = queueBody(ctx);
	assert.equal(out.text, "queue empty");
	assert.equal(out.markup, undefined);
});

test("queueBody has a markup when the queue is non-empty", () => {
	const { ctx } = makeCtx();
	ctx.queue.enqueue({ text: "hello", telegramMessageId: 1 });
	const out = queueBody(ctx);
	assert.match(out.text, /<b>Queue \(1\)<\/b>/);
	assert.ok(out.markup);
});

test("modelPickerBody lists models and marks the current one", () => {
	const { ctx } = makeCtx();
	const out = modelPickerBody(ctx, 0);
	assert.match(out.text, /Pick a model/);
	assert.ok(out.markup);
});

test("dispatchTelegramCommand: tgstatus returns text", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgstatus", "", ctx);
	assert.match(r.text, /bot: not connected/);
});

test("dispatchTelegramCommand: tgreconnect calls reconnectPolling", async () => {
	let reconnected = false;
	const { ctx } = makeCtx({ reconnectPolling: async () => { reconnected = true; } });
	const r = await dispatchTelegramCommand("tgreconnect", "", ctx);
	assert.equal(reconnected, true);
	assert.match(r.text, /reconnected/);
});

test("dispatchTelegramCommand: tgabort calls abort and returns text", async () => {
	let aborted = false;
	const { ctx } = makeCtx({ abort: () => { aborted = true; } });
	const r = await dispatchTelegramCommand("tgabort", "", ctx);
	assert.equal(aborted, true);
	assert.match(r.text, /abort/);
});

test("dispatchTelegramCommand: tgmodel returns picker text + markup", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgmodel", "", ctx);
	assert.match(r.text, /Pick a model/);
	assert.ok(r.markup);
});

test("dispatchTelegramCommand: model<N> pages through the picker", async () => {
	const { ctx } = makeCtx();
	// 3 models, 8 per page — page 0 has them all.
	const r0 = await dispatchTelegramCommand("modelpage", "0", ctx);
	assert.match(r0.text, /Pick a model/);
	assert.match(r0.text, /Showing 1.3 of 3/);
});

test("dispatchTelegramCommand: tgcompact sends /compact as follow-up", async () => {
	let followUp = "";
	const { ctx } = makeCtx({ sendFollowUp: (text) => { followUp = text; } });
	const r = await dispatchTelegramCommand("tgcompact", "", ctx);
	assert.equal(followUp, "/compact");
	assert.match(r.text, /compact/);
});

test("dispatchTelegramCommand: tgthinking with valid level applies it", async () => {
	let applied: string | undefined;
	const { ctx } = makeCtx({
		pi: {
			setModel: async () => true,
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getAllTools: () => [] as never,
			setThinkingLevel: (l: string) => { applied = l; },
		} as unknown as CommandCtx["pi"],
	});
	const r = await dispatchTelegramCommand("tgthinking", "high", ctx);
	assert.equal(applied, "high");
	assert.match(r.text, /thinking: high/);
});

test("dispatchTelegramCommand: tgthinking with no level returns hint", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgthinking", "", ctx);
	assert.match(r.text, /pick a level/);
	assert.ok(r.markup);          // has the picker keyboard
});

test("dispatchTelegramCommand: tgtools returns the tools picker", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgtools", "", ctx);
	assert.match(r.text, /toggle a tool/);
	assert.ok(r.markup);
});

test("dispatchTelegramCommand: tgapprove lists always-allow", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgapprove", "", ctx);
	assert.match(r.text, /always-allow/);
});

test("dispatchTelegramCommand: tgapprove clear empties the list", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgapprove", "clear", ctx);
	assert.equal(r.text, approveClearBody());
	assert.equal(approveListBody(), "always-allow (0):\n(empty)");
});

test("dispatchTelegramCommand: tgweather with no args returns usage", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgweather", "", ctx);
	assert.match(r.text, /Usage/);
	assert.match(r.text, /tgweather/);
});

test("dispatchTelegramCommand: tgweather returns not-found for bogus location", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgweather", "XyzzyNope", ctx);
	assert.match(r.text, /Couldn't find/);
});

test("dispatchTelegramCommand: tgweather-setdefault sets the default", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTelegramCommand("tgweather-setdefault", "Rochdale", ctx);
	assert.match(r.text, /Default weather location set to: Rochdale/);
});

test("dispatchTelegramCommand: tgweather-cleargetdefault clears the default", async () => {
	const { ctx } = makeCtx();
	await dispatchTelegramCommand("tgweather-setdefault", "Rochdale", ctx);
	const r = await dispatchTelegramCommand("tgweather-cleargetdefault", "", ctx);
	assert.match(r.text, /cleared/);
	const r2 = await dispatchTelegramCommand("tgweather-setdefault", "", ctx);
	assert.match(r2.text, /No default/);
});

test("dispatchTgCmdCallback: tgcmd:model:apply sets the model", async () => {
	const { ctx, setModel } = makeCtx();
	const r = await dispatchTgCmdCallback("tgcmd:model:openai/gpt-4o", ctx);
	assert.equal(setModel.calls().length, 1);
	assert.deepEqual(setModel.calls()[0], { provider: "openai", id: "gpt-4o" });
	assert.match(r.text, /model: openai\/gpt-4o/);
});

test("dispatchTgCmdCallback: tgcmd:thinking:high applies thinking", async () => {
	let applied: string | undefined;
	const { ctx } = makeCtx({
		pi: {
			setModel: async () => true,
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getAllTools: () => [] as never,
			setThinkingLevel: (l: string) => { applied = l; },
		} as unknown as CommandCtx["pi"],
	});
	const r = await dispatchTgCmdCallback("tgcmd:thinking:high", ctx);
	assert.equal(applied, "high");
	assert.match(r.text, /thinking: high/);
});

test("dispatchTgCmdCallback: tgcmd:tooltoggle:read toggles the tool", async () => {
	let nextActive: string[] = [];
	const { ctx } = makeCtx({
		pi: {
			setModel: async () => true,
			getThinkingLevel: () => "off",
			getActiveTools: () => ["read", "bash"],
			getAllTools: () => [] as never,
			setActiveTools: (names: string[]) => { nextActive = [...names]; },
		} as unknown as CommandCtx["pi"],
	});
	const r = await dispatchTgCmdCallback("tgcmd:tooltoggle:read", ctx);
	assert.deepEqual(nextActive, ["bash"]);     // read was on, now off
	assert.match(r.text, /read: off/);
});

test("dispatchTgCmdCallback: unknown tgcmd verb returns a clear error", async () => {
	const { ctx } = makeCtx();
	const r = await dispatchTgCmdCallback("tgcmd:bogus:thing", ctx);
	assert.match(r.text, /unknown verb/);
});

// --- Filtered picker tests ---

test("modelPickerBody filters to availableProviders when set is provided", () => {
	const { ctx } = makeCtx({
		availableProviders: new Set(["openai"]),     // only openai, not anthropic or google
	});
	const out = modelPickerBody(ctx, 0);
	// Should mention openai but not anthropic/google in the header
	assert.match(out.text, /Available providers/);
	assert.match(out.text, /openai/);
	assert.doesNotMatch(out.text, /anthropic/);
	assert.match(out.text, /Showing 1/);     // 1 openai model
	assert.ok(out.markup);
});

test("modelPickerBody with empty availableProviders shows hint, no markup", () => {
	const { ctx } = makeCtx({ availableProviders: new Set() });
	const out = modelPickerBody(ctx, 0);
	assert.match(out.text, /No static models/);
	assert.equal(out.markup, undefined);
});

test("modelPickerBody with dynamic-only providers (e.g. ollama-cloud) shows the type-by-name hint", () => {
	const { ctx } = makeCtx({
		availableProviders: new Set(["ollama-cloud"]),
		registry: { getAll: () => [], find: () => undefined },        // empty registry
	});
	const out = modelPickerBody(ctx, 0);
	assert.match(out.text, /No static models/);
	assert.match(out.text, /ollama-cloud/);
	assert.match(out.text, /\/tgmodel ollama-cloud\/&lt;model-id&gt;/);
	assert.equal(out.markup, undefined);
});

test("modelPickerBody with null availableProviders shows all models (no filter)", () => {
	const { ctx } = makeCtx({ availableProviders: null });
	const out = modelPickerBody(ctx, 0);
	// 3 models in the test registry, all should be considered available
	assert.match(out.text, /Showing 1.3 of 3/);
});

test("dispatchTelegramCommand: /tgmodel <provider>/<id> applies directly", async () => {
	const { ctx, setModel } = makeCtx({ availableProviders: new Set(["openai"]) });
	const r = await dispatchTelegramCommand("tgmodel", "openai/gpt-4o", ctx);
	assert.equal(setModel.calls().length, 1);
	assert.deepEqual(setModel.calls()[0], { provider: "openai", id: "gpt-4o" });
	assert.match(r.text, /model: openai\/gpt-4o/);
	assert.equal(r.markup, undefined);   // direct apply, no keyboard
});

test("statusBody shows the available providers line", () => {
	const { ctx } = makeCtx({ availableProviders: new Set(["deepseek", "ollama-cloud"]) });
	const out = statusBody(ctx);
	assert.match(out, /available providers: deepseek, ollama-cloud/);
});
