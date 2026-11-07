/**
 * Tests for src/polling.ts — backoff on error, allowlist filter, abort,
 * and persisted getUpdates offset (next offset, not last seen id).
 *
 * Uses a stubbed TelegramClient (we don't need real HTTP — transport.ts is
 * already tested). Actually we test through the loop with a fake client.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPollingLoop } from "../src/polling.ts";
import type { TelegramClient } from "../src/transport.ts";
import type { TgUpdate } from "../src/types.ts";

/** runPollingLoop writes telegram.json via setLastUpdateId — never hit ~/.pi/agent. */
async function withIsolatedAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-tg-poll-test-"));
	const prev = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = dir;
	try {
		await run(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

function readPersistedOffset(dir: string): number {
	const raw = JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8")) as { lastUpdateId: number };
	return raw.lastUpdateId;
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

/** Fake that records offset and only returns updates with update_id >= offset. */
function makeOffsetAwareClient(store: TgUpdate[]): { client: TelegramClient; offsets: number[] } {
	const offsets: number[] = [];
	return {
		offsets,
		client: {
			getUpdates: async (offset: number, _timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> => {
				if (signal?.aborted) throw new Error("aborted");
				offsets.push(offset);
				void _timeout;
				return store.filter((u) => u.update_id >= offset);
			},
		} as unknown as TelegramClient,
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
	await withIsolatedAgentDir(async () => {
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
});

test("loop drops updates from non-allowlisted chat", async () => {
	await withIsolatedAgentDir(async (dir) => {
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
		assert.equal(readPersistedOffset(dir), 202, "dropped updates still advance the persisted offset");
	});
});

test("loop recovers from a transient getUpdates error", async () => {
	await withIsolatedAgentDir(async () => {
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
});

test("after handling update 100, persisted lastUpdateId is 101", async () => {
	await withIsolatedAgentDir(async (dir) => {
		const { client } = makeFakeClient([
			() => [makeUpdate(100, 42, "hello")],
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
		assert.deepEqual(handled, [100]);
		assert.equal(readPersistedOffset(dir), 101);
	});
});

test("restart with saved offset does not re-handle update 100", async () => {
	await withIsolatedAgentDir(async (dir) => {
		const store = [makeUpdate(100, 42, "once")];
		const first = makeOffsetAwareClient(store);
		const handled1: number[] = [];
		const ctl1 = new AbortController();
		const task1 = runPollingLoop({
			client: first.client,
			chatId: 42,
			initialOffset: 0,
			signal: ctl1.signal,
			handler: async (u) => { handled1.push(u.update_id); },
		});
		setTimeout(() => ctl1.abort(), 50);
		await task1;
		assert.deepEqual(handled1, [100]);
		const saved = readPersistedOffset(dir);
		assert.equal(saved, 101);

		const second = makeOffsetAwareClient(store);
		const handled2: number[] = [];
		const ctl2 = new AbortController();
		const task2 = runPollingLoop({
			client: second.client,
			chatId: 42,
			initialOffset: saved,
			signal: ctl2.signal,
			handler: async (u) => { handled2.push(u.update_id); },
		});
		setTimeout(() => ctl2.abort(), 50);
		await task2;
		assert.deepEqual(handled2, [], "update 100 must not replay after restart");
		assert.ok(second.offsets.length >= 1);
		assert.ok(second.offsets.every((o) => o >= 101), "restart must poll at the saved next offset");
	});
});
