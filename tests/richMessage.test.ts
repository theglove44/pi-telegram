/**
 * Tests for src/richMessage.ts — Telegram Bot API 10.1 Rich HTML builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeatherRichMessage, buildForecastRichMessage, plainFromRichHtml, escapeRichHtml } from "../src/richMessage.ts";

test("escapeRichHtml escapes ampersand and angle brackets", () => {
	assert.equal(escapeRichHtml("A & B < C > D"), "A &amp; B &lt; C &gt; D");
	assert.equal(escapeRichHtml("plain"), "plain");
});

test("buildWeatherRichMessage produces a Rich HTML payload", () => {
	const rich = buildWeatherRichMessage({
		region: "Rochdale, England, United Kingdom",
		conditions: "☁️ overcast",
		temperature: 18.1,
		humidity: 67,
		windSpeed: 14.8,
		high: 19.9,
		low: 14.8,
		query: "Rochdale",
	});
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>Weather for Rochdale, England, United Kingdom<\/h1>/);
	assert.match(rich.html!, /☁️ overcast/);
	assert.match(rich.html!, /18\.1°C/);
	assert.match(rich.html!, /67% humidity/);
	assert.match(rich.html!, /14\.8 km\/h wind/);
	assert.match(rich.html!, /High 19\.9°C · Low 14\.8°C/);
});

test("buildWeatherRichMessage includes query note when it differs from region", () => {
	const rich = buildWeatherRichMessage({
		region: "Springfield, Illinois, United States",
		conditions: "☀️ clear sky",
		temperature: 20.0,
		humidity: 50,
		windSpeed: 5.0,
		high: 25.0,
		low: 15.0,
		query: "Springfield, IL",
	});
	assert.match(rich.html!, /<i>Query: Springfield, IL<\/i>/);
});

test("buildForecastRichMessage produces a table", () => {
	const rich = buildForecastRichMessage({
		region: "Rochdale, England, United Kingdom",
		rows: [
			{ day: "Wed 17 Jun", conditions: "🌦️ moderate drizzle", high: "19.9°C", low: "14.8°C" },
			{ day: "Thu 18 Jun", conditions: "☁️ overcast", high: "21.8°C", low: "12.5°C" },
		],
	});
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>7-day forecast for Rochdale, England, United Kingdom<\/h1>/);
	assert.match(rich.html!, /<table>/);
	assert.match(rich.html!, /<thead>/);
	assert.match(rich.html!, /<tbody>/);
	assert.match(rich.html!, /<th>Day<\/th>/);
	assert.match(rich.html!, /<td>Wed 17 Jun<\/td>/);
	assert.match(rich.html!, /19\.9°C/);
});

test("plainFromRichHtml strips tags and decodes entities", () => {
	const plain = plainFromRichHtml("\u003ch1\u003eHello\u003c/h1\u003e\u003cp\u003eA \u003cb\u003eworld\u003c/b\u003e\u003c/p\u003e");
	assert.match(plain, /Hello/);
	assert.match(plain, /world/);
	assert.doesNotMatch(plain, /<\/?h1>/);
	assert.doesNotMatch(plain, /<\/?p>/);
});

test("plainFromRichHtml converts br tags to newlines", () => {
	const plain = plainFromRichHtml("\u003cp\u003ea\u003cbr\u003eb\u003c/p\u003e");
	assert.match(plain, /a\nb/);
});
