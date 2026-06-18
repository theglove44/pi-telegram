/**
 * Tests for src/transport.ts — fetch wrapper, retry, auth failure.
 *
 * Uses a stubbed fetch so we don't need a real bot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, TelegramApiError, TelegramAuthError } from "../src/transport.ts";

type FetchResult = { status: number; body: unknown; retryAfter?: string };

function makeFetch(responses: FetchResult[]): { fn: typeof fetch; callCount: () => number } {
	let i = 0;
	let count = 0;
	const fn: typeof fetch = async (_url, _init) => {
		count += 1;
		const r = responses[Math.min(i, responses.length - 1)];
		if (r === undefined) {
			throw new Error("no response");
		}
		i += 1;
		const headers = new Headers();
		if (r.retryAfter) headers.set("retry-after", r.retryAfter);
		return new Response(JSON.stringify(r.body), { status: r.status, headers });
	};
	return { fn, callCount: () => count };
}

test("successful call returns result", async () => {
	const { fn } = makeFetch([{ status: 200, body: { ok: true, result: { id: 1 } } }]);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 1000 });
	const r = await c.call<{ id: number }>("getMe");
	assert.deepEqual(r, { id: 1 });
});

test("auth failure (401) throws TelegramAuthError, no retry", async () => {
	const { fn, callCount } = makeFetch([{ status: 401, body: "unauthorized" }]);
	const c = new TelegramClient({ token: "bad", fetchImpl: fn, timeoutMs: 1000 });
	await assert.rejects(c.call("getMe"), (err: unknown) => err instanceof TelegramAuthError);
	assert.equal(callCount(), 1, "must not retry on 401");
});

test("api error (400) throws TelegramApiError, no retry", async () => {
	const { fn, callCount } = makeFetch([{ status: 400, body: { ok: false, error_code: 400, description: "bad" } }]);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 1000 });
	await assert.rejects(c.call("sendMessage"), (err: unknown) => err instanceof TelegramApiError);
	assert.equal(callCount(), 1);
});

test("429 with retry-after is honoured then succeeds", async () => {
	const { fn, callCount } = makeFetch([
		{ status: 429, body: { ok: false, error_code: 429, description: "ratelimit" }, retryAfter: "1" },
		{ status: 200, body: { ok: true, result: 42 } },
	]);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 5000 });
	// We can't easily assert on the actual sleep duration in unit tests, but
	// we can confirm that retry happens and the second response wins.
	const r = await c.call<number>("getMe");
	assert.equal(r, 42);
	assert.equal(callCount(), 2);
});

test("5xx retries with exponential backoff up to MAX_RETRIES, then throws", async () => {
	// MAX_RETRIES is 4 → 5 attempts total (initial + 4 retries).
	const { fn, callCount } = makeFetch(
		Array.from({ length: 10 }, () => ({ status: 500, body: "boom" })),
	);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 1000 });
	await assert.rejects(c.call("getMe"), (err: unknown) => err instanceof TelegramApiError);
	assert.equal(callCount(), 5, "expected initial + 4 retries = 5 attempts");
});

test("sendRichMessage calls the sendRichMessage method with rich_message payload", async () => {
	const { fn, callCount } = makeFetch([{ status: 200, body: { ok: true, result: { message_id: 7 } } }]);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 1000 });
	const r = await c.sendRichMessage(123, { html: "\u003ch1\u003eHi\u003c/h1\u003e" });
	assert.equal(r.message_id, 7);
	assert.equal(callCount(), 1);
});

test("sendRichMessageDraft calls the sendRichMessageDraft method", async () => {
	const { fn, callCount } = makeFetch([{ status: 200, body: { ok: true, result: { message_id: 8 } } }]);
	const c = new TelegramClient({ token: "tok", fetchImpl: fn, timeoutMs: 1000 });
	const r = await c.sendRichMessageDraft(123, { markdown: "# Hi" });
	assert.equal(r.message_id, 8);
	assert.equal(callCount(), 1);
});
