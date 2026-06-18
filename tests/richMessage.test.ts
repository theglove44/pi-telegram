/**
 * Tests for src/richMessage.ts — Telegram Bot API 10.1 Rich HTML builder.
 *
 * These tests assert the Rich HTML vocabulary documented at
 * https://core.telegram.org/bots/api#rich-message-formatting-options.
 * Notably Rich HTML tables are flat (<table><caption>?<tr><th|td>...) and do
 * NOT use <thead>/<tbody>, which the Rich parser does not recognise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeatherRichMessage, buildForecastRichMessage, plainFromRichHtml, escapeRichHtml } from "../src/richMessage.ts";

test("escapeRichHtml escapes ampersand and angle brackets", () => {
	assert.equal(escapeRichHtml("A & B < C > D"), "A &amp; B &lt; C &gt; D");
	assert.equal(escapeRichHtml("plain"), "plain");
});

test("buildWeatherRichMessage produces a Rich HTML payload with heading and pull-quote", () => {
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
	assert.match(rich.html!, /<tg-pull-quote>☁️ overcast<\/tg-pull-quote>/);
	assert.match(rich.html!, /18\.1°C/);
	assert.match(rich.html!, /67%/);
	assert.match(rich.html!, /14\.8 km\/h/);
	assert.match(rich.html!, /19\.9°C/);
	assert.match(rich.html!, /14\.8°C/);
	// Metrics rendered as a bordered striped table, no thead/tbody.
	assert.match(rich.html!, /<table>/);
	assert.match(rich.html!, /<caption>Current conditions<\/caption>/);
	assert.doesNotMatch(rich.html!, /<thead>/);
	assert.doesNotMatch(rich.html!, /<tbody>/);
});

test("buildWeatherRichMessage includes query footer when query differs from region", () => {
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
	assert.match(rich.html!, /<footer><i>Query: Springfield, IL<\/i><\/footer>/);
});

test("buildWeatherRichMessage omits query footer when query matches region", () => {
	const rich = buildWeatherRichMessage({
		region: "Rochdale",
		conditions: "☀️ clear sky",
		temperature: 20.0,
		humidity: 50,
		windSpeed: 5.0,
		high: 25.0,
		low: 15.0,
		query: "rochdale",
	});
	assert.doesNotMatch(rich.html!, /<footer>/);
});

test("buildForecastRichMessage produces a flat bordered striped table with caption", () => {
	const rich = buildForecastRichMessage({
		region: "Rochdale, England, United Kingdom",
		rows: [
			{ day: "Wed 17 Jun", conditions: "🌦️ moderate drizzle", high: "19.9°C", low: "14.8°C" },
			{ day: "Thu 18 Jun", conditions: "☁️ overcast", high: "21.8°C", low: "12.5°C" },
		],
	});
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>Forecast for Rochdale, England, United Kingdom<\/h1>/);
	assert.match(rich.html!, /<table>/);
	assert.match(rich.html!, /<caption>7-day forecast for Rochdale, England, United Kingdom<\/caption>/);
	assert.match(rich.html!, /<th>Day<\/th>/);
	assert.match(rich.html!, /<th>Conditions<\/th>/);
	assert.match(rich.html!, /<th>High<\/th>/);
	assert.match(rich.html!, /<th>Low<\/th>/);
	assert.match(rich.html!, /<td>Wed 17 Jun<\/td>/);
	assert.match(rich.html!, /<td>🌦️ moderate drizzle<\/td>/);
	assert.match(rich.html!, /<td><b>19\.9°C<\/b><\/td>/);
	// Rich HTML tables must NOT use thead/tbody.
	assert.doesNotMatch(rich.html!, /<thead>/);
	assert.doesNotMatch(rich.html!, /<tbody>/);
});

test("buildForecastRichMessage includes query footer when query differs", () => {
	const rich = buildForecastRichMessage({
		region: "Paris, France",
		rows: [{ day: "Mon 1 Jan", conditions: "☀️ clear sky", high: "10.0°C", low: "2.0°C" }],
		query: "paris",
	});
	// "paris" !== "Paris, France" so footer is included.
	assert.match(rich.html!, /<footer><i>Query: paris<\/i><\/footer>/);
});

test("plainFromRichHtml strips tags and decodes entities", () => {
	const plain = plainFromRichHtml("<h1>Hello</h1><p>A <b>world</b></p>");
	assert.match(plain, /Hello/);
	assert.match(plain, /world/);
	assert.doesNotMatch(plain, /<\/?h1>/);
	assert.doesNotMatch(plain, /<\/?p>/);
});

test("plainFromRichHtml converts br tags to newlines", () => {
	const plain = plainFromRichHtml("<p>a<br>b</p>");
	assert.match(plain, /a\nb/);
});

test("plainFromRichHtml unwraps blockquote, footer, and caption", () => {
	const plain = plainFromRichHtml("<blockquote>hi</blockquote><footer>bot</footer><table><caption>cap</caption></table>");
	assert.match(plain, /hi/);
	assert.match(plain, /bot/);
	assert.match(plain, /cap/);
});