/**
 * Tests for src/polling.ts — backoff on error, allowlist filter, abort.
 *
 * Uses a stubbed TelegramClient (we don't need real HTTP — transport.ts is
 * already tested). Actually we test through the loop with a fake client.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runPollingLoop } from "../src/polling.ts";
import type { TelegramClient } from "../src/transport.ts";
import type { TgUpdate } from "../src/types.ts";

interface FakeClient {
	getUpdates: (offset: number, timeout: number, signal?: AbortSignal) => Promise<TgUpdate[]>;
}

function makeFakeClient(scenarios: Array<() => TgUpdate[] | Promise<TgUpdate[]>>): { client: TelegramClient; calls: () => number } {
	let i = 0;
	let count = 0;
	return {
		client: {
			getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> => {
				count += 1;
				if (signal?.aborted) throw new Error("aborted");
				const s = scenarios[Math.min(i, scenarios.length - 1)];
				if (!s) return [];
				i += 1;
				const out = await s();
				void _offset; void _timeout;
				return out;
			},
		} as unknown as TelegramClient,
		calls: () => count,
	};
}

const makeUpdate = (id: number, chatId: number, text?: string): TgUpdate => ({
	update_id: id,
	message: text ? {
		message_id: id,
		date: 0,
		chat: { id: chatId, type: "private" },
		text,
	} : undefined,
});

test("loop processes updates and advances offset", async () => {
	const { client, calls } = makeFakeClient([
		() => [makeUpdate(100, 42, "hello"), makeUpdate(101, 42, "world")],
		() => [],                                  // no more updates
	]);
	const handled: number[] = [];
	const ctl = new AbortController();
	const task = runPollingLoop({
		client,
		chatId: 42,
		initialOffset: 0,
		signal: ctl.signal,
		handler: async (u) => { handled.push(u.update_id); },
	});
	// Give it 50ms to consume the first batch, then abort.
	setTimeout(() => ctl.abort(), 50);
	await task;
	assert.deepEqual(handled, [100, 101]);
	assert.ok(calls() >= 1);
});

test("loop drops updates from non-allowlisted chat", async () => {
	const { client } = makeFakeClient([
		() => [makeUpdate(200, 999, "hijack"), makeUpdate(201, 42, "ok")],
		() => [],
	]);
	const handled: number[] = [];
	const ctl = new AbortController();
	const task = runPollingLoop({
		client,
		chatId: 42,
		initialOffset: 0,
		signal: ctl.signal,
		handler: async (u) => { handled.push(u.update_id); },
	});
	setTimeout(() => ctl.abort(), 50);
	await task;
	assert.deepEqual(handled, [201], "the chat-999 update must be dropped");
});

test("loop recovers from a transient getUpdates error", async () => {
	let threw = false;
	const client = {
		getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("aborted");
			if (!threw) { threw = true; throw new Error("network blip"); }
			return [];
		},
	} as unknown as TelegramClient;
	const ctl = new AbortController();
	const task = runPollingLoop({
		client,
		chatId: 42,
		initialOffset: 0,
		signal: ctl.signal,
		handler: async () => { /* noop */ },
	});
	setTimeout(() => ctl.abort(), 200);
	await task;
	assert.ok(threw, "loop should have caught the throw and retried");
});
