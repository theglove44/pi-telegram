/**
 * Tests for src/weather.ts — Open-Meteo lookup, formatting, and natural
 * language location extraction.
 *
 * Network calls are mocked; no real outbound requests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	extractLocation,
	geocodeLocation,
	fetchWeather,
	fetchForecast,
	formatWeather,
	formatForecast,
	formatWeatherRich,
	formatForecastRich,
	weatherReply,
	weatherReplyForecast,
	weatherReplyRich,
	weatherReplyForecastRich,
	weatherReplyForecastDayRich,
	describeWeatherCode,
	isForecastQuery,
	parseForecastTarget,
	selectForecastDay,
	type GeocodeResult,
	type ForecastDay,
} from "../src/weather.ts";

function makeFetch(handlers: { geocode?: unknown; forecast?: unknown; fail?: string }): typeof fetch {
	return async (input) => {
		const url = input.toString();
		if (handlers.fail) throw new Error(handlers.fail);
		if (url.includes("geocoding-api")) {
			return {
				ok: true,
				status: 200,
				json: async () => handlers.geocode ?? { results: [] },
			} as Response;
		}
		if (url.includes("api.open-meteo.com")) {
			return {
				ok: true,
				status: 200,
				json: async () => handlers.forecast ?? {},
			} as Response;
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
}

test("extractLocation returns null for unrelated text", () => {
	assert.equal(extractLocation("hello world"), null);
	assert.equal(extractLocation("tell me a joke"), null);
});

test("extractLocation returns null when no location is given", () => {
	assert.equal(extractLocation("what's the weather?"), null);
	assert.equal(extractLocation("how's the weather"), null);
	assert.equal(extractLocation("what is the weather like?"), null);
});

test("extractLocation extracts city names", () => {
	assert.equal(extractLocation("what's the weather in London?"), "London");
	assert.equal(extractLocation("weather in New York"), "New York");
	assert.equal(extractLocation("how's the weather like in Paris?"), "Paris");
	assert.equal(extractLocation('weather in "Tokyo"'), "Tokyo");
	assert.equal(extractLocation("weather in Berlin right now"), "Berlin");
});

test("geocodeLocation returns the first result", async () => {
	const fetchImpl = makeFetch({
		geocode: {
			results: [{
				name: "London",
				country: "United Kingdom",
				admin1: "England",
				latitude: 51.5074,
				longitude: -0.1278,
			}],
		},
	});
	const result = await geocodeLocation("London", fetchImpl);
	assert.equal(result?.name, "London");
	assert.equal(result?.country, "United Kingdom");
	assert.equal(result?.admin1, "England");
	assert.equal(result?.latitude, 51.5074);
	assert.equal(result?.longitude, -0.1278);
});

test("geocodeLocation returns null when no results", async () => {
	const fetchImpl = makeFetch({ geocode: { results: [] } });
	const result = await geocodeLocation("Nowheresville", fetchImpl);
	assert.equal(result, null);
});

test("fetchWeather parses current and daily fields", async () => {
	const location: GeocodeResult = { name: "Berlin", country: "Germany", latitude: 52.52, longitude: 13.41 };
	const fetchImpl = makeFetch({
		forecast: {
			current: {
				temperature_2m: 18.5,
				relative_humidity_2m: 62,
				weather_code: 2,
				wind_speed_10m: 12.3,
			},
			daily: {
				temperature_2m_max: [22.1],
				temperature_2m_min: [14.0],
			},
		},
	});
	const w = await fetchWeather(location, fetchImpl);
	assert.equal(w.location.name, "Berlin");
	assert.equal(w.current.temperature, 18.5);
	assert.equal(w.current.relativeHumidity, 62);
	assert.equal(w.current.weatherCode, 2);
	assert.equal(w.current.windSpeed, 12.3);
	assert.equal(w.daily.max, 22.1);
	assert.equal(w.daily.min, 14.0);
});

test("formatWeather renders Telegram HTML", () => {
	const result = formatWeather({
		location: { name: "London", country: "United Kingdom", admin1: "England", latitude: 0, longitude: 0 },
		current: { temperature: 15.0, relativeHumidity: 70, weatherCode: 63, windSpeed: 10.0 },
		daily: { max: 18.0, min: 12.0 },
	}, "London");
	assert.match(result, /<b>Weather for London, England, United Kingdom<\/b>/);
	assert.match(result, /🌧️ moderate rain/);
	assert.match(result, /15\.0°C/);
	assert.match(result, /70% humidity/);
	assert.match(result, /10\.0 km\/h wind/);
	assert.match(result, /High 18\.0°C · Low 12\.0°C/);
});

test("formatWeather includes query when it differs from resolved region", () => {
	const result = formatWeather({
		location: { name: "Springfield", country: "United States", admin1: "Illinois", latitude: 0, longitude: 0 },
		current: { temperature: 20.0, relativeHumidity: 50, weatherCode: 0, windSpeed: 5.0 },
		daily: { max: 25.0, min: 15.0 },
	}, "Springfield, IL");
	assert.match(result, /<i>Query: Springfield, IL<\/i>/);
});

test("describeWeatherCode maps known codes and falls back", () => {
	assert.match(describeWeatherCode(0), /clear sky/);
	assert.match(describeWeatherCode(61), /rain/);
	assert.match(describeWeatherCode(95), /thunderstorm/);
	assert.match(describeWeatherCode(999), /unknown/);
});

test("weatherReply returns formatted weather on success", async () => {
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: {
			current: { temperature_2m: 20.0, relative_humidity_2m: 55, weather_code: 1, wind_speed_10m: 8.0 },
			daily: { temperature_2m_max: [23.0], temperature_2m_min: [16.0] },
		},
	});
	const reply = await weatherReply("Paris", fetchImpl);
	assert.match(reply, /Weather for Paris, France/);
	assert.match(reply, /20\.0°C/);
});

test("weatherReply returns a not-found message when geocoding misses", async () => {
	const fetchImpl = makeFetch({ geocode: { results: [] } });
	const reply = await weatherReply("Nowheresville", fetchImpl);
	assert.match(reply, /Couldn't find a location/);
});

// --- Forecast tests ---

test("isForecastQuery detects bare forecast", () => {
	assert.ok(isForecastQuery("forecast"));
	assert.ok(isForecastQuery("Forecast"));
	assert.ok(isForecastQuery("what's the forecast?"));
	assert.ok(isForecastQuery("what is the forecast"));
	assert.ok(isForecastQuery("weekly forecast"));
	assert.equal(isForecastQuery("what's the weather?"), null);
	assert.equal(isForecastQuery("hello"), null);
});

test("isForecastQuery detects forecast + location", () => {
	const m1 = isForecastQuery("forecast for London");
	assert.ok(m1);
	assert.equal(m1!.location, "London");

	const m2 = isForecastQuery("what's the forecast for Tokyo?");
	assert.ok(m2);
	assert.equal(m2!.location, "Tokyo");       // trailing ? stripped

	const mQ = isForecastQuery("forecast for Paris?");
	assert.ok(mQ);
	assert.equal(mQ!.location, "Paris");

	const m3 = isForecastQuery("weekly forecast Paris");
	assert.ok(m3);
	assert.equal(m3!.location, "Paris");
});

test("isForecastQuery detects weather + this week / next week / next few days", () => {
	const m1 = isForecastQuery("weather in London this week");
	assert.ok(m1);
	assert.equal(m1!.location, "London");

	const m2 = isForecastQuery("what's the weather in Paris next week?");
	assert.ok(m2);
	assert.equal(m2!.location, "Paris");

	const m3 = isForecastQuery("weather in Berlin next few days");
	assert.ok(m3);
	assert.equal(m3!.location, "Berlin");

	// User's exact phrasing: "for this week"
	const m4 = isForecastQuery("what's the weather for this week?");
	assert.ok(m4);
	assert.equal(m4!.location, undefined);

	const m5 = isForecastQuery("what's the weather in Manchester for this week?");
	assert.ok(m5);
	assert.equal(m5!.location, "Manchester");

	const m6 = isForecastQuery("what's the weather for the week?");
	assert.ok(m6);
	assert.equal(m6!.location, undefined);

	// No location — uses default
	const m7 = isForecastQuery("weather this week");
	assert.ok(m7);
	assert.equal(m7!.location, undefined);

	// Not a forecast — "today" should not match
	assert.equal(isForecastQuery("weather in London today"), null);
	assert.equal(isForecastQuery("what's the weather?"), null);
});

test("isForecastQuery detects 'weather forecast' phrasing", () => {
	const m1 = isForecastQuery("what's the weather forecast for London?");
	assert.ok(m1);
	assert.equal(m1!.location, "London");

	const m2 = isForecastQuery("weather forecast Tokyo");
	assert.ok(m2);
	assert.equal(m2!.location, "Tokyo");

	const m3 = isForecastQuery("what's the weather forecast?");
	assert.ok(m3);
	assert.equal(m3!.location, undefined);
});

test("isForecastQuery treats time-only phrases as no location", () => {
	const m1 = isForecastQuery("what's the weather forecast for today?");
	assert.ok(m1);
	assert.equal(m1!.location, undefined);

	const m2 = isForecastQuery("forecast for tomorrow");
	assert.ok(m2);
	assert.equal(m2!.location, undefined);

	const m3 = isForecastQuery("weather forecast for next week");
	assert.ok(m3);
	assert.equal(m3!.location, undefined);

	const m4 = isForecastQuery("forecast for now");
	assert.ok(m4);
	assert.equal(m4!.location, undefined);

	// Curly apostrophe (common on iOS/macOS) should also match.
	const m5 = isForecastQuery("What’s the weather forecast for today?");
	assert.ok(m5);
	assert.equal(m5!.location, undefined);

	// Weekend phrasing falls back to the default location.
	const m6 = isForecastQuery("What's the weather forecast for the weekend?");
	assert.ok(m6);
	assert.equal(m6!.location, undefined);

	const m7 = isForecastQuery("forecast for next weekend");
	assert.ok(m7);
	assert.equal(m7!.location, undefined);
});

test("isForecastQuery treats weekday phrases as temporal-only (default location)", () => {
	// Bare weekday phrases fall back to the default location.
	const a1 = isForecastQuery("what's the weather forecast for this Sunday?");
	assert.ok(a1);
	assert.equal(a1!.location, undefined);

	const a2 = isForecastQuery("weather forecast for Sunday");
	assert.ok(a2);
	assert.equal(a2!.location, undefined);

	const a3 = isForecastQuery("forecast for next Monday");
	assert.ok(a3);
	assert.equal(a3!.location, undefined);

	const a4 = isForecastQuery("weather this Friday");
	assert.ok(a4);
	assert.equal(a4!.location, undefined);

	// Location + weekday: the weekday is stripped, the location is kept.
	const b1 = isForecastQuery("what's the weather in London this Sunday?");
	assert.ok(b1);
	assert.equal(b1!.location, "London");

	const b2 = isForecastQuery("forecast for Rochdale this Sunday");
	assert.ok(b2);
	assert.equal(b2!.location, "Rochdale");

	const b3 = isForecastQuery("what's the weather in Paris next Saturday?");
	assert.ok(b3);
	assert.equal(b3!.location, "Paris");
});

test("extractLocation strips trailing temporal phrases", () => {
	assert.equal(extractLocation("what's the weather in London today?"), "London");
	assert.equal(extractLocation("weather in Paris right now"), "Paris");
	assert.equal(extractLocation("what's the weather in Manchester this Sunday?"), "Manchester");
});

test("fetchForecast returns 7 days of forecast data", async () => {
	const location: GeocodeResult = { name: "Berlin", country: "Germany", latitude: 52.52, longitude: 13.41 };
	const fetchImpl = makeFetch({
		forecast: {
			daily: {
				time: ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23"],
				temperature_2m_max: [22.1, 24.0, 19.5, 21.0, 23.5, 25.0, 20.0],
				temperature_2m_min: [14.0, 15.0, 11.0, 13.0, 16.0, 17.0, 12.0],
				weather_code: [2, 1, 61, 3, 0, 63, 45],
			},
		},
	});
	const f = await fetchForecast(location, fetchImpl);
	assert.equal(f.location.name, "Berlin");
	assert.equal(f.days.length, 7);
	const d0 = f.days[0]!;
	assert.equal(d0.date, "2026-06-17");
	assert.equal(d0.max, 22.1);
	assert.equal(d0.min, 14.0);
	assert.equal(d0.weatherCode, 2);
	const d6 = f.days[6]!;
	assert.equal(d6.date, "2026-06-23");
	assert.equal(d6.max, 20.0);
	assert.equal(d6.weatherCode, 45);
});

test("formatForecast renders 7-day Telegram HTML", () => {
	const days: ForecastDay[] = [
		{ date: "2026-06-17", max: 22.1, min: 14.0, weatherCode: 2 },
		{ date: "2026-06-18", max: 24.0, min: 15.0, weatherCode: 1 },
	];
	const result = formatForecast({
		location: { name: "Berlin", country: "Germany", latitude: 52.52, longitude: 13.41 },
		days,
	});
	assert.match(result, /7-day forecast for Berlin, Germany/);
	assert.match(result, /Wed.*Jun.*\u2014.*partly cloudy/);
	assert.match(result, /Thu.*Jun.*\u2014.*mainly clear/);
	assert.match(result, /22\.1/);
	assert.match(result, /14\.0/);
});

test("formatForecast includes query when it differs from resolved region", () => {
	const days: ForecastDay[] = [
		{ date: "2026-06-17", max: 20.0, min: 10.0, weatherCode: 0 },
	];
	const result = formatForecast({
		location: { name: "Springfield", country: "United States", admin1: "Illinois", latitude: 0, longitude: 0 },
		days,
	}, "Springfield, IL");
	assert.match(result, /<i>Query: Springfield, IL<\/i>/);
});

test("weatherReplyForecast returns formatted forecast on success", async () => {
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: {
			daily: {
				time: ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23"],
				temperature_2m_max: [23.0, 25.0, 20.0, 22.0, 24.0, 26.0, 21.0],
				temperature_2m_min: [16.0, 17.0, 13.0, 15.0, 18.0, 19.0, 14.0],
				weather_code: [1, 0, 61, 2, 3, 63, 45],
			},
		},
	});
	const reply = await weatherReplyForecast("Paris", fetchImpl);
	assert.match(reply, /7-day forecast for Paris/);
	assert.match(reply, /Jun/);
});

test("weatherReplyForecast returns not-found when geocoding misses", async () => {
	const fetchImpl = makeFetch({ geocode: { results: [] } });
	const reply = await weatherReplyForecast("Nowheresville", fetchImpl);
	assert.match(reply, /Couldn't find a location/);
});

test("formatWeatherRich returns an InputRichMessage with heading and details", () => {
	const rich = formatWeatherRich({
		location: { name: "London", country: "United Kingdom", admin1: "England", latitude: 0, longitude: 0 },
		current: { temperature: 15.0, relativeHumidity: 70, weatherCode: 63, windSpeed: 10.0 },
		daily: { max: 18.0, min: 12.0 },
	}, "London");
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>Weather for London, England, United Kingdom<\/h1>/);
	assert.match(rich.html!, /<tg-pull-quote>🌧️ moderate rain<\/tg-pull-quote>/);
	assert.match(rich.html!, /15\.0°C/);
	assert.match(rich.html!, /18\.0°C/);
	assert.match(rich.html!, /12\.0°C/);
	// Rich HTML table is flat — no thead/tbody.
	assert.match(rich.html!, /<table>/);
	assert.match(rich.html!, /<caption>Current conditions<\/caption>/);
	assert.doesNotMatch(rich.html!, /<thead>/);
	assert.doesNotMatch(rich.html!, /<tbody>/);
});

test("formatForecastRich returns an InputRichMessage with a flat bordered table", () => {
	const days: ForecastDay[] = [
		{ date: "2026-06-17", max: 20.0, min: 14.0, weatherCode: 61 },
		{ date: "2026-06-18", max: 22.0, min: 15.0, weatherCode: 0 },
	];
	const rich = formatForecastRich({
		location: { name: "Rochdale", country: "United Kingdom", admin1: "England", latitude: 0, longitude: 0 },
		days,
	}, "Rochdale");
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>Forecast for Rochdale, England, United Kingdom<\/h1>/);
	assert.match(rich.html!, /<table>/);
	assert.match(rich.html!, /<caption>7-day forecast for Rochdale, England, United Kingdom<\/caption>/);
	assert.match(rich.html!, /20\.0°C/);
	// Rich HTML tables are flat; thead/tbody must not appear.
	assert.doesNotMatch(rich.html!, /<thead>/);
	assert.doesNotMatch(rich.html!, /<tbody>/);
});

test("weatherReplyRich returns a rich message on success", async () => {
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: {
			current: { temperature_2m: 20.0, relative_humidity_2m: 55, weather_code: 1, wind_speed_10m: 8.0 },
			daily: { temperature_2m_max: [23.0], temperature_2m_min: [16.0] },
		},
	});
	const rich = await weatherReplyRich("Paris", fetchImpl);
	assert.ok(rich.html);
	assert.match(rich.html!, /Weather for Paris, France/);
	assert.match(rich.html!, /20\.0°C/);
});

test("weatherReplyForecastRich returns a rich table on success", async () => {
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: {
			daily: {
				time: ["2026-06-17", "2026-06-18"],
				temperature_2m_max: [23.0, 25.0],
				temperature_2m_min: [16.0, 17.0],
				weather_code: [1, 0],
			},
		},
	});
	const rich = await weatherReplyForecastRich("Paris", fetchImpl);
	assert.ok(rich.html);
	assert.match(rich.html!, /7-day forecast for Paris, France/);
	assert.match(rich.html!, /<table>/);
});

test("weatherReplyForecastRich returns an error rich message when geocoding misses", async () => {
	const fetchImpl = makeFetch({ geocode: { results: [] } });
	const rich = await weatherReplyForecastRich("Nowheresville", fetchImpl);
	assert.ok(rich.html);
	assert.match(rich.html!, /Couldn't find a location/);
});

test("parseForecastTarget extracts weekday and relative targets", () => {
	assert.deepEqual(parseForecastTarget("forecast for this Sunday"), { weekday: 0 });
	assert.deepEqual(parseForecastTarget("weather forecast for Monday"), { weekday: 1 });
	assert.deepEqual(parseForecastTarget("what's the weather in London next Friday?"), { weekday: 5 });
	assert.deepEqual(parseForecastTarget("weather tomorrow"), { relative: "tomorrow" });
	assert.deepEqual(parseForecastTarget("what's the weather today?"), { relative: "today" });
	// Multi-day phrases have no specific target.
	assert.equal(parseForecastTarget("forecast for this week"), null);
	assert.equal(parseForecastTarget("weekly forecast Tokyo"), null);
	assert.equal(parseForecastTarget("forecast"), null);
});

test("selectForecastDay picks the right day from a 7-day window", () => {
	// 2026-06-17 is a Wednesday; window Wed..Tue (getDay: 3,4,5,6,0,1,2).
	const days: ForecastDay[] = ["2026-06-17","2026-06-18","2026-06-19","2026-06-20","2026-06-21","2026-06-22","2026-06-23"]
		.map((d) => ({ date: d, max: 20, min: 10, weatherCode: 0 }));
	assert.equal(selectForecastDay(days, { relative: "today" })?.date, "2026-06-17");
	assert.equal(selectForecastDay(days, { relative: "tomorrow" })?.date, "2026-06-18");
	// First Sunday in the window is 2026-06-21; Friday is 2026-06-19.
	assert.equal(selectForecastDay(days, { weekday: 0 })?.date, "2026-06-21");
	assert.equal(selectForecastDay(days, { weekday: 5 })?.date, "2026-06-19");
});

test("weatherReplyForecastDayRich returns a single-day card for a weekday target", async () => {
	// 2026-06-17 (Wed) window; Sunday target -> 2026-06-21.
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: {
			daily: {
				time: ["2026-06-17","2026-06-18","2026-06-19","2026-06-20","2026-06-21","2026-06-22","2026-06-23"],
				temperature_2m_max: [20, 21, 22, 23, 24, 25, 26],
				temperature_2m_min: [10, 11, 12, 13, 14, 15, 16],
				weather_code: [0, 1, 2, 3, 61, 63, 45],
			},
		},
	});
	const rich = await weatherReplyForecastDayRich("Paris", { weekday: 0 }, fetchImpl);
	assert.ok(rich.html);
	assert.match(rich.html!, /<h1>Forecast for Paris, France<\/h1>/);
	// Sunday's caption should appear, with Sunday's high (24.0°C).
	assert.match(rich.html!, /<caption>Sunday 21 Jun<\/caption>/);
	assert.match(rich.html!, /24\.0°C/);
	assert.match(rich.html!, /14\.0°C/);
	// Must be a single-day card, not the 7-day table.
	assert.doesNotMatch(rich.html!, /7-day forecast/);
});

test("weatherReplyForecastDayRich handles a day outside the 7-day window", async () => {
	const fetchImpl = makeFetch({
		geocode: { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] },
		forecast: { daily: { time: ["2026-06-17"], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [0] } },
	});
	// No Saturday in a one-day Wed window.
	const rich = await weatherReplyForecastDayRich("Paris", { weekday: 6 }, fetchImpl);
	assert.ok(rich.html);
	assert.match(rich.html!, /No forecast available for that day/);
});

test("isForecastQuery treats 'weather tomorrow' as a forecast query", () => {
	const m1 = isForecastQuery("weather tomorrow");
	assert.ok(m1);
	assert.equal(m1!.location, undefined);
	const m2 = isForecastQuery("what's the weather in London tomorrow?");
	assert.ok(m2);
	assert.equal(m2!.location, "London");
	// 'today' stays a current-weather request, not a forecast.
	assert.equal(isForecastQuery("what's the weather today?"), null);
});

test("isForecastQuery handles stacked qualifiers like 'for this coming Sunday'", () => {
	// Reported bug: "for this coming Sunday" has two stacked qualifiers and was
	// not recognised, so it fell through to current weather instead of a forecast.
	const m1 = isForecastQuery("what's the weather for this coming Sunday");
	assert.ok(m1);
	assert.equal(m1!.location, undefined);
	const m2 = isForecastQuery("what's the weather for this coming Sunday?");
	assert.ok(m2);
	assert.equal(m2!.location, undefined);
	const m3 = isForecastQuery("weather for this coming Friday");
	assert.ok(m3);
	assert.equal(m3!.location, undefined);
	// Location + stacked qualifier: the qualifier words must not eat into the
	// location name (e.g. the "on" in "London").
	const m4 = isForecastQuery("what's the weather for London this coming Sunday");
	assert.ok(m4);
	assert.equal(m4!.location, "London");
	const m5 = isForecastQuery("weather in London this Sunday");
	assert.ok(m5);
	assert.equal(m5!.location, "London");
});

test("isForecastQuery keeps 'for today' as a current-weather request", () => {
	assert.equal(isForecastQuery("what's the weather for today"), null);
	assert.equal(isForecastQuery("what's the weather today?"), null);
});
