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
	formatWeather,
	weatherReply,
	describeWeatherCode,
	type GeocodeResult,
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
