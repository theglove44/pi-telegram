/**
 * Tests for src/config.ts — redaction, atomic write, env fallback.
 *
 * We do not test keyring paths because they require a real keyring.
 * The redaction helper is a pure function — that's what we test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactToken } from "../src/config.ts";

test("redactToken replaces token occurrences", () => {
	const tok = "123456:ABCDEFG-secret";
	const out = redactToken(`url: https://api.telegram.org/bot${tok}/getMe`, tok);
	assert.doesNotMatch(out, /123456:ABCDEFG-secret/);
	assert.match(out, /<BOT_TOKEN>/);
});

test("redactToken leaves other strings alone when token is absent", () => {
	const out = redactToken("no token here", null);
	assert.equal(out, "no token here");
});

test("redactToken is safe with a short token (does not redact)", () => {
	// Short tokens (< 8 chars) are not redacted — this is a safety guard
	// to avoid accidentally mangling small text.
	const out = redactToken("hi abc", "abc");
	assert.equal(out, "hi abc");
});

test("redactToken handles multiple occurrences", () => {
	const tok = "abcdefgh-secret";
	const out = redactToken(`${tok} and ${tok} again`, tok);
	assert.equal(out, "<BOT_TOKEN> and <BOT_TOKEN> again");
});
