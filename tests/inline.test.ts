/**
 * Tests for src/inline.ts — keyboard markup, callback dispatch, approval
 * gating. The interactive askApproval flow is not unit-tested because it
 * requires a real Telegram round-trip; we test the helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	keyboardMarkup,
	dispatchCallback,
	registerOnceCallback,
	loadAlwaysAllow,
	saveAlwaysAllow,
} from "../src/inline.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("keyboardMarkup packs rows correctly", () => {
	const m = keyboardMarkup([
		[{ text: "A", action: "app:yes:abc" }, { text: "B", action: "app:no:abc" }],
		[{ text: "C", action: "tclear" }],
	]);
	assert.deepEqual(m, {
		inline_keyboard: [
			[{ text: "A", callback_data: "app:yes:abc" }, { text: "B", callback_data: "app:no:abc" }],
			[{ text: "C", callback_data: "tclear" }],
		],
	});
});

test("dispatchCallback routes by exact nonce for app:*", async () => {
	let called = "";
	registerOnceCallback("nonce-xyz", async (data) => { called = data; });
	const handled = await dispatchCallback("app:yes:nonce-xyz");
	assert.equal(handled, true);
	assert.equal(called, "app:yes:nonce-xyz");
});

test("dispatchCallback returns false for unknown data", async () => {
	const handled = await dispatchCallback("nothing-matches");
	assert.equal(handled, false);
});

test("stale app:* callback edits the prompt to expired and uses message_id", async () => {
	const edits: Array<{ chatId: number; messageId: number | undefined; text: string }> = [];
	const client = { editMessageText: async (chatId: number, messageId: number | undefined, text: string) => { edits.push({ chatId, messageId, text }); return {}; } };
	const handled = await dispatchCallback("app:yes:no-such-nonce", client as never, 1, 42);
	assert.equal(handled, false);
	assert.equal(edits.length, 1);
	assert.equal(edits[0]?.messageId, 42);
	assert.match(edits[0]?.text ?? "", /Approval prompt expired/i);
});

test("stale app:* callback skips edit when message_id is missing", async () => {
	const edits: Array<{ chatId: number; messageId: number | undefined; text: string }> = [];
	const client = { editMessageText: async (chatId: number, messageId: number | undefined, text: string) => { edits.push({ chatId, messageId, text }); return {}; } };
	const handled = await dispatchCallback("app:no:no-such-nonce", client as never, 1);
	assert.equal(handled, false);
	assert.equal(edits.length, 0);
});

test("always-allow list persists across calls (round-trip)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tg-test-"));
	try {
		process.env.PI_AGENT_DIR = dir;
		saveAlwaysAllow(["read", "bash"]);
		const cur = loadAlwaysAllow();
		assert.deepEqual(cur.tools.sort(), ["bash", "read"]);
		saveAlwaysAllow([]);
		const empty = loadAlwaysAllow();
		assert.deepEqual(empty.tools, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
