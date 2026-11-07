/**
 * Tests for src/reconnect.ts — Telegram /tgreconnect must not deadlock
 * by awaiting the poll loop from inside that loop's handler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReconnectPolling } from "../src/reconnect.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

test("reconnect from inside a poll handler returns without waiting for the loop", async () => {
	const loopDone = deferred<void>();
	let pollTask: Promise<void> | null = loopDone.promise;
	let started = 0;
	let aborted = false;
	const scheduled: Array<() => void> = [];

	const rec = createReconnectPolling({
		abort: () => { aborted = true; },
		takePollTask: () => {
			const t = pollTask;
			pollTask = null;
			return t;
		},
		releaseLock: async () => { /* noop */ },
		startPolling: async () => { started += 1; },
		schedule: (fn) => { scheduled.push(fn); },
	});

	let handlerReturned = false;
	const handler = rec.wrapHandler(async () => {
		await rec.reconnect();
		handlerReturned = true;
	});

	let loopExited = false;
	const loop = (async () => {
		await handler(undefined);
		loopExited = true;
		loopDone.resolve();
	})();

	await Promise.race([
		loop,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("deadlock: reconnect awaited the poll loop")), 200);
		}),
	]);

	assert.equal(handlerReturned, true);
	assert.equal(loopExited, true);
	assert.equal(aborted, true);
	assert.equal(started, 0);
	assert.equal(scheduled.length, 1);

	scheduled[0]!();
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(started, 1);
});

test("reconnect from outside the poll handler awaits a real restart", async () => {
	const loopDone = deferred<void>();
	let pollTask: Promise<void> | null = loopDone.promise;
	let started = 0;

	const rec = createReconnectPolling({
		abort: () => { loopDone.resolve(); },
		takePollTask: () => {
			const t = pollTask;
			pollTask = null;
			return t;
		},
		releaseLock: async () => { /* noop */ },
		startPolling: async () => { started += 1; },
	});

	await rec.reconnect();
	assert.equal(started, 1);
});

test("overlapping reconnects do not start two poll loops", async () => {
	let started = 0;
	const scheduled: Array<() => void> = [];
	const rec = createReconnectPolling({
		abort: () => { /* noop */ },
		takePollTask: () => null,
		releaseLock: async () => { /* noop */ },
		startPolling: async () => { started += 1; },
		schedule: (fn) => { scheduled.push(fn); },
	});

	const handler = rec.wrapHandler(async () => {
		await rec.reconnect();
		await rec.reconnect();
	});
	await handler(undefined);

	assert.equal(scheduled.length, 1);
	scheduled[0]!();
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(started, 1);
});
