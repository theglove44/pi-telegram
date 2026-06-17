/**
 * Tests for src/render.ts — markdown→Telegram HTML conversion + chunking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMessage, chunkForTelegram } from "../src/render.ts";

test("plain text passes through with HTML escaping", () => {
	const r = renderMessage("hello world");
	assert.equal(r.html, "hello world");
	assert.equal(r.buttons.length, 0);
	assert.equal(r.voice.length, 0);
});

test("HTML metacharacters are escaped", () => {
	const r = renderMessage(`<script>alert("x")</script> & 'quotes'`);
	// & and < and > are escaped; ' is not.
	assert.match(r.html, /&lt;script&gt;/);
	assert.match(r.html, /&amp;/);
	assert.doesNotMatch(r.html, /<script>/);
});

test("bold renders as <b>", () => {
	const r = renderMessage("this is **bold** text");
	assert.match(r.html, /<b>bold<\/b>/);
});

test("italic renders as <i>", () => {
	const r = renderMessage("this is _italic_ text");
	assert.match(r.html, /<i>italic<\/i>/);
});

test("strikethrough renders as <s>", () => {
	const r = renderMessage("~~struck~~");
	assert.match(r.html, /<s>struck<\/s>/);
});

test("inline code renders as <code>", () => {
	const r = renderMessage("use `foo()` here");
	assert.match(r.html, /<code>foo\(\)<\/code>/);
});

test("fenced code block renders as <pre><code>", () => {
	const r = renderMessage("before\n```js\nconst x = 1;\n```\nafter");
	assert.match(r.html, /<pre><code class="language-js">/);
	assert.match(r.html, /const x = 1;/);
});

test("inline markup inside code is NOT interpreted", () => {
	const r = renderMessage("`a * b = c`");
	assert.match(r.html, /<code>a \* b = c<\/code>/);
});

test("links render as <a href>", () => {
	const r = renderMessage("see [docs](https://example.com)");
	assert.match(r.html, /<a href="https:\/\/example\.com">docs<\/a>/);
});

test("telegram_button markup is stripped and captured", () => {
	const r = renderMessage('hello <!-- telegram_button text="Approve" action="app:yes:abc" --> world');
	assert.equal(r.buttons.length, 1);
	assert.deepEqual(r.buttons[0], { text: "Approve", action: "app:yes:abc" });
	assert.doesNotMatch(r.html, /telegram_button/);
	assert.match(r.html, /hello\s+world/);
});

test("telegram_voice markup is stripped and captured", () => {
	const r = renderMessage('hi <!-- telegram_voice text="say this" lang="en" rate="fast" --> bye');
	assert.equal(r.voice.length, 1);
	assert.equal(r.voice[0]?.text, "say this");
	assert.equal(r.voice[0]?.lang, "en");
	assert.equal(r.voice[0]?.rate, "fast");
	assert.equal(r.hasVoice, true);
	assert.doesNotMatch(r.html, /telegram_voice/);
});

test("chunkForTelegram returns single chunk for short text", () => {
	const chunks = chunkForTelegram("short text");
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0], "short text");
});

test("chunkForTelegram splits long text on safe boundaries", () => {
	// Build text > 4096 chars.
	const big = "x".repeat(5000);
	const chunks = chunkForTelegram(big);
	assert.ok(chunks.length >= 2);
	for (const c of chunks) {
		assert.ok(c.length <= 4096, `chunk too long: ${c.length}`);
	}
});

test("chunkForTelegram prefers to break on </pre> or whitespace", () => {
	// Put a long <pre> block, then a long line of plain text.
	const pre = "<pre>" + "a".repeat(3000) + "</pre>";
	const rest = "word ".repeat(500);
	const html = pre + "\n" + rest;
	const chunks = chunkForTelegram(html);
	assert.ok(chunks.length >= 2);
	// First chunk should end with </pre> if possible.
	assert.match(chunks[0] ?? "", /<\/pre>/);
});
