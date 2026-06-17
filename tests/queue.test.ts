/**
 * Tests for src/queue.ts — FIFO + control/prompt lanes + priority + status.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnQueue } from "../src/queue.ts";

function turn(text: string, lane: "control" | "prompt" = "prompt"): { text: string; telegramMessageId: number; lane?: "control" | "prompt" } {
	return { text, telegramMessageId: Math.floor(Math.random() * 1e9), lane };
}

test("empty queue returns null", () => {
	const q = new TurnQueue();
	assert.equal(q.startNext(), null);
	assert.equal(q.size, 0);
	assert.equal(q.pendingCount(), 0);
});

test("FIFO order for prompt items", () => {
	const q = new TurnQueue();
	q.enqueue(turn("first"));
	q.enqueue(turn("second"));
	q.enqueue(turn("third"));
	assert.equal(q.startNext()?.text, "first");
	assert.equal(q.startNext()?.text, "second");
	assert.equal(q.startNext()?.text, "third");
	assert.equal(q.startNext(), null);
});

test("control items drain before prompt items", () => {
	const q = new TurnQueue();
	q.enqueue(turn("p1"));
	q.enqueue(turn("c1", "control"));
	q.enqueue(turn("p2"));
	assert.equal(q.startNext()?.text, "c1");
	assert.equal(q.startNext()?.text, "p1");
	assert.equal(q.startNext()?.text, "p2");
});

test("priority boost moves an item to the front", () => {
	const q = new TurnQueue();
	const a = q.enqueue(turn("a"));
	q.enqueue(turn("b"));
	q.enqueue(turn("c"));
	q.prioritise(a.telegramMessageId);
	// 'a' now has priority 1; b, c have 0. a should win.
	assert.equal(q.startNext()?.text, "a");
});

test("removeByMessageId drops the matching item", () => {
	const q = new TurnQueue();
	const a = q.enqueue(turn("a"));
	q.enqueue(turn("b"));
	q.enqueue(turn("c"));
	const removed = q.removeByMessageId(a.telegramMessageId);
	assert.equal(removed?.text, "a");
	assert.equal(q.size, 2);
	assert.equal(q.startNext()?.text, "b");
});

test("clear removes everything", () => {
	const q = new TurnQueue();
	q.enqueue(turn("a"));
	q.enqueue(turn("b"));
	const n = q.clear();
	assert.equal(n, 2);
	assert.equal(q.size, 0);
});

test("clearPending removes only pending items", () => {
	const q = new TurnQueue();
	q.enqueue(turn("a"));
	q.enqueue(turn("b"));
	q.enqueue(turn("c", "control"));
	q.startNext(); // mark first as running
	const n = q.clearPending();
	assert.equal(n, 2); // b and c are pending, a is running
	assert.equal(q.size, 1);
	assert.equal(q.list()[0]?.status, "running");
});

test("prioritise is a no-op on unknown id", () => {
	const q = new TurnQueue();
	q.enqueue(turn("a"));
	const r = q.prioritise(999999);
	assert.equal(r, null);
});

test("startNext marks the turn as running", () => {
	const q = new TurnQueue();
	const a = q.enqueue(turn("a"));
	const t = q.startNext();
	assert.equal(t?.status, "running");
	assert.equal(t?.id, a.id);
});

test("completeRunning removes the running turn and returns it as completed", () => {
	const q = new TurnQueue();
	q.enqueue(turn("a"));
	q.startNext();
	const completed = q.completeRunning();
	assert.equal(completed?.status, "completed");
	assert.equal(q.size, 0);
});

test("pendingCount tracks only pending items", () => {
	const q = new TurnQueue();
	q.enqueue(turn("a"));
	q.enqueue(turn("b"));
	q.enqueue(turn("c"));
	assert.equal(q.pendingCount(), 3);
	q.startNext();
	assert.equal(q.pendingCount(), 2);
});
