/**
 * Weather lookup via Open-Meteo (no API key required).
 *
 * Supports:
 *   - explicit `/tgweather <location>` commands
 *   - casual queries like "what's the weather in London?"
 *   - forecast queries like "what's the weather in London this week?"
 *     or "forecast Paris"
 *
 * All outbound calls use the native `fetch` available in Node 22+.
 */

import { buildForecastDayRichMessage, buildForecastRichMessage, buildWeatherRichMessage, type RichForecastRow } from "./richMessage.js";
import type { InputRichMessage } from "./types.js";

export interface GeocodeResult {
	name: string;
	country?: string;
	admin1?: string;
	latitude: number;
	longitude: number;
}

export interface CurrentWeather {
	temperature: number;
	relativeHumidity: number;
	weatherCode: number;
	windSpeed: number;
}

export interface DailyForecast {
	max: number;
	min: number;
}

export interface WeatherResult {
	location: GeocodeResult;
	current: CurrentWeather;
	daily: DailyForecast;
}

/** A single day in a 7-day forecast. */
export interface ForecastDay {
	date: string;          // "2026-06-17"
	max: number;
	min: number;
	weatherCode: number;
}

export interface ForecastResult {
	location: GeocodeResult;
	days: ForecastDay[];
}

/** Result of parsing a forecast query. */
export interface ForecastQueryMatch {
	text: string;
	location?: string;
}

/** A specific day targeted by a forecast query, if any.
 *  `weekday` is 0=Sun..6=Sat (matching `Date.getDay()`). `relative` covers
 *  today/tomorrow. When both are absent the query wants the full 7-day window. */
export interface ForecastTarget {
	weekday?: number;
	relative?: "today" | "tomorrow";
}

const WEEKDAY_TO_DAY: Array<{ re: RegExp; day: number }> = [
	{ re: /^sun(?:day)?$/i, day: 0 },
	{ re: /^mon(?:day)?$/i, day: 1 },
	{ re: /^tue(?:sday)?$/i, day: 2 },
	{ re: /^wed(?:nesday)?$/i, day: 3 },
	{ re: /^thu(?:rsday)?$/i, day: 4 },
	{ re: /^fri(?:day)?$/i, day: 5 },
	{ re: /^sat(?:urday)?$/i, day: 6 },
];

function weekdayNameToDay(name: string): number | undefined {
	const n = name.trim().toLowerCase();
	for (const w of WEEKDAY_TO_DAY) if (w.re.test(n)) return w.day;
	return undefined;
}

/** Extract a specific target day from a forecast query, if any.
 *
 * Returns null for multi-day phrases ("this week", "this weekend", "next few
 * days", bare "forecast") so the caller returns the full 7-day window.
 *
 * Examples:
 *   "forecast for this Sunday"  -> { weekday: 0 }
 *   "weather tomorrow"           -> { relative: "tomorrow" }
 *   "what's the weather today?"  -> { relative: "today" }
 *   "forecast for this week"     -> null
 *   "weekly forecast Tokyo"      -> null
 */
export function parseForecastTarget(text: string): ForecastTarget | null {
	const t = text.trim().replace(/[“”"'‘’]/g, "");

	// today / tomorrow
	const rel = t.match(/\b(today|tomorrow)\b/i);
	if (rel) return { relative: rel[1]!.toLowerCase() as "today" | "tomorrow" };

	// weekday with an optional qualifier (this/next/coming/on/for/over the)
	const weekdayRe = /\b(?:this\s+coming\s+|this\s+|next\s+|coming\s+|on\s+|for\s+|over\s+the\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/i;
	const m = t.match(weekdayRe);
	if (m) {
		const day = weekdayNameToDay(m[1] ?? "");
		if (day !== undefined) return { weekday: day };
	}
	return null;
}

/** Select the forecast day matching a target from a 7-day window.
 *  Returns null when the requested day isn't within the window. */
export function selectForecastDay(days: ForecastDay[], target: ForecastTarget): ForecastDay | null {
	if (target.relative === "today") return days[0] ?? null;
	if (target.relative === "tomorrow") return days[1] ?? null;
	if (target.weekday !== undefined) {
		return days.find((d) => new Date(d.date + "T12:00:00").getDay() === target.weekday) ?? null;
	}
	return null;
}

/** Detect whether a text asks for a multi-day forecast.
 *
 * Matches patterns like:
 *   "forecast"
 *   "forecast for London"
 *   "what's the weather in London this week?"
 *   "weather in Paris next few days"
 *   "weekly forecast Tokyo"
 *   "what's the weather forecast for today?"
 *
 * Returns a {@link ForecastQueryMatch} with an optional extracted location,
 * or null if the text is not a forecast query. Time-only phrases such as
 * "today", "this week" or "this Sunday" are treated as if no location was
 * given so the configured default location can be used.
 */

// Weekday names with common abbreviations.
const WEEKDAY = "(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)";

// A captured location phrase that is *entirely* temporal (no real place).
// Covers weekdays (with this/next/coming/on/for/over the qualifiers) plus
// the week/weekend/today/tomorrow family.
const TEMPORAL_ONLY_RE = new RegExp(
	"^\\s*(?:" +
		"(?:this\\s+coming\\s+|this\\s+|next\\s+|coming\\s+|on\\s+|for\\s+|over\\s+the\\s+)?" + WEEKDAY + "" +
		"|today|tomorrow|tonight|now" +
		"|this\\s+week|next\\s+week" +
		"|this\\s+weekend|next\\s+weekend|the\\s+weekend" +
		"|next\\s+(?:few|couple(?:\\s+of)?)\\s+days" +
		"|the\\s+week|the\\s+next\\s+(?:few|couple(?:\\s+of)?)\\s+days|for\\s+(?:the|this)\\s+(?:week|weekend)" +
	")\\s*\\??$",
	"i",
);

/** Strip temporal phrases (weekdays, week/weekend, today/tomorrow) and
 * leftover connectors from a captured location phrase. Returns the
 * residual location, or undefined when nothing real remains — so the caller
 * falls back to the configured default location.
 *
 * Examples:
 *   "this Sunday"        -> undefined
 *   "Sunday"             -> undefined
 *   "next Monday"        -> undefined
 *   "Rochdale this Sunday" -> "Rochdale"
 *   "this Sunday in London" -> "London"
 *   "London"             -> "London"
 *   "London this week"   -> "London"
 *   ""                   -> undefined
 */
function stripTemporal(s: string | undefined): string | undefined {
	if (!s) return undefined;
	let v = s.replace(/\?+$/g, "").trim();
	// Drop weekday-based temporal chunks (with optional qualifiers).
	const weekdayChunk = new RegExp(
		"\\s*\\b(?:this\\s+coming\\s+|this\\s+|next\\s+|coming\\s+|on\\s+|for\\s+|over\\s+the\\s+)?" + WEEKDAY + "\\b\\s*",
		"gi",
	);
	v = v.replace(weekdayChunk, " ");
	// Drop standalone week/weekend/today phrases.
	v = v.replace(
		/\b(?:today|tomorrow|tonight|now|this\s+week|next\s+week|this\s+weekend|next\s+weekend|the\s+weekend|the\s+week|the\s+next\s+(?:few|couple(?:\s+of)?)\s+days|next\s+(?:few|couple(?:\s+of)?)\s+days)\b/gi,
		" ",
	);
	// Drop leftover leading/trailing connectors.
	v = v.replace(/^\s*(?:in|for|on|at|of)\s+/i, "").replace(/\s+(?:in|for|on|at)\s*$/i, " ");
	v = v.replace(/\s{2,}/g, " ").trim();
	if (!v) return undefined;
	if (TEMPORAL_ONLY_RE.test(v)) return undefined;
	return v;
}

export function isForecastQuery(text: string): ForecastQueryMatch | null {
	const t = text.trim().replace(/[“”"'‘’]/g, "");

	const loc = (s: string | undefined): string | undefined => stripTemporal(s);

	// "forecast [for] [location]" or "[location] forecast"
	let m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?(?:weekly\s+)?forecast\s*(?:for\s+)?(.+?)$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// "weather forecast [for] [location]" (e.g. "what's the weather forecast for today?")
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?(?:weekly\s+)?weather\s+forecast\s*(?:for\s+)?(.+?)$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// "weather [in location] this week / next week / next few days / for the week / for this week"
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?))?\s*(?:this\s+week|next\s+(?:week|few\s+days|couple\s+of\s+days)|for\s+(?:the\s+|this\s+)?(?:week|next\s+\d+\s+days))\??$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// "weather [in location] <weekday-phrase>"  e.g. "weather in London this Sunday",
	// "what's the weather this Sunday?", "weather forecast for Sunday".
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?))?\s*(?:this\s+coming\s+|this\s+|next\s+|coming\s+|on\s+|for\s+|over\s+the\s+)?(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\??$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// "weather [in location] tomorrow"  e.g. "weather tomorrow", "what's the
	// weather in London tomorrow?". ("today" is intentionally NOT matched here —
	// "what's the weather today?" stays a current-weather request.)
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?))?\s*tomorrow\??$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// Bare "forecast" or "weekly forecast" (no location phrase)
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?(?:weekly\s+)?forecasts?\??$/i);
	if (m) return { text: t };

	return null;
}

/**
 * Extract a location from a free-form weather question.
 *
 * Matches patterns like:
 *   "what's the weather?" -> null
 *   "what's the weather in London?" -> "London"
 *   "weather in New York" -> "New York"
 *   "how's the weather like in Paris today?" -> "Paris"
 *
 * Temporal phrases (weekdays, this week, today, ...) are stripped from the
 * captured location so they never get sent to the geocoder. NOTE: forecast
 * keywords ("this week", "this Sunday", ...) are handled by
 * {@link isForecastQuery}, which is checked first by the caller.
 */
export function extractLocation(text: string): string | null {
	const t = text.trim().replace(/[“”"'‘’]/g, "");
	const m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?)|$)(?:\s*(?:today|now|currently|right\s+now|at\s+the\s+moment))?\??$/i);
	if (!m) return null;
	const stripped = stripTemporal(m[1] ?? "");
	return stripped ?? null;
}

/**
 * Look up a location by name using Open-Meteo's geocoding API.
 */
export async function geocodeLocation(
	location: string,
	fetchImpl: typeof fetch = fetch,
): Promise<GeocodeResult | null> {
	const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
	url.searchParams.set("name", location);
	url.searchParams.set("count", "1");
	url.searchParams.set("language", "en");
	url.searchParams.set("format", "json");

	const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
	const data = (await res.json()) as { results?: Array<GeocodeResult> };
	const hit = data.results?.[0];
	if (!hit) return null;
	return {
		name: hit.name,
		country: hit.country,
		admin1: hit.admin1,
		latitude: hit.latitude,
		longitude: hit.longitude,
	};
}

/**
 * Fetch current weather + today's high/low from Open-Meteo.
 */
export async function fetchWeather(
	location: GeocodeResult,
	fetchImpl: typeof fetch = fetch,
): Promise<WeatherResult> {
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.searchParams.set("latitude", String(location.latitude));
	url.searchParams.set("longitude", String(location.longitude));
	url.searchParams.set("current", "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m");
	url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
	url.searchParams.set("timezone", "auto");
	url.searchParams.set("forecast_days", "1");
	url.searchParams.set("temperature_unit", "celsius");
	url.searchParams.set("wind_speed_unit", "kmh");

	const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`forecast failed: HTTP ${res.status}`);
	const data = (await res.json()) as {
		current?: {
			temperature_2m?: number;
			relative_humidity_2m?: number;
			weather_code?: number;
			wind_speed_10m?: number;
		};
		daily?: {
			temperature_2m_max?: number[];
			temperature_2m_min?: number[];
		};
	};

	if (!data.current) throw new Error("forecast response missing current weather");
	return {
		location,
		current: {
			temperature: Number(data.current.temperature_2m ?? 0),
			relativeHumidity: Number(data.current.relative_humidity_2m ?? 0),
			weatherCode: Number(data.current.weather_code ?? 0),
			windSpeed: Number(data.current.wind_speed_10m ?? 0),
		},
		daily: {
			max: Number(data.daily?.temperature_2m_max?.[0] ?? 0),
			min: Number(data.daily?.temperature_2m_min?.[0] ?? 0),
		},
	};
}

/**
 * Fetch a 7-day daily forecast from Open-Meteo.
 */
export async function fetchForecast(
	location: GeocodeResult,
	fetchImpl: typeof fetch = fetch,
): Promise<ForecastResult> {
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.searchParams.set("latitude", String(location.latitude));
	url.searchParams.set("longitude", String(location.longitude));
	url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
	url.searchParams.set("timezone", "auto");
	url.searchParams.set("forecast_days", "7");
	url.searchParams.set("temperature_unit", "celsius");

	const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`forecast failed: HTTP ${res.status}`);
	const data = (await res.json()) as {
		daily?: {
			time?: string[];
			temperature_2m_max?: number[];
			temperature_2m_min?: number[];
			weather_code?: number[];
		};
	};

	if (!data.daily?.time?.length) throw new Error("forecast response missing daily data");

	const days: ForecastDay[] = data.daily.time.map((date, i) => ({
		date,
		max: Number(data.daily!.temperature_2m_max?.[i] ?? 0),
		min: Number(data.daily!.temperature_2m_min?.[i] ?? 0),
		weatherCode: Number(data.daily!.weather_code?.[i] ?? 0),
	}));

	return { location, days };
}

/**
 * Format a 7-day forecast as a Telegram HTML message.
 */
export function formatForecast(result: ForecastResult, query?: string): string {
	const loc = result.location;
	const region = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");

	const lines: string[] = [
		`<b>7-day forecast for ${escapeHtml(region)}</b>`,
		"",
	];

	for (const day of result.days) {
		const date = new Date(day.date + "T12:00:00");
		const dayName = date.toLocaleDateString("en-GB", { weekday: "short" });
		const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
		const conditions = describeWeatherCode(day.weatherCode);
		lines.push(`<b>${dayName} ${dateStr}</b> — ${conditions}`);
		lines.push(`  📈 ${day.max.toFixed(1)}°C  📉 ${day.min.toFixed(1)}°C`);
	}

	if (query && query.trim().toLowerCase() !== region.toLowerCase()) {
		lines.push("", `<i>Query: ${escapeHtml(query)}</i>`);
	}

	return lines.join("\n");
}

function forecastRows(result: ForecastResult): RichForecastRow[] {
	return result.days.map((day) => {
		const date = new Date(day.date + "T12:00:00");
		const dayName = date.toLocaleDateString("en-GB", { weekday: "short" });
		const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
		return {
			day: `${dayName} ${dateStr}`,
			conditions: describeWeatherCode(day.weatherCode),
			high: `${day.max.toFixed(1)}°C`,
			low: `${day.min.toFixed(1)}°C`,
		};
	});
}

/**
 * Format a 7-day forecast as a Rich Message payload.
 */
export function formatForecastRich(result: ForecastResult, query?: string): InputRichMessage {
	const region = [result.location.name, result.location.admin1, result.location.country].filter(Boolean).join(", ");
	return buildForecastRichMessage({ region, rows: forecastRows(result), query });
}

/**
 * Resolve a free-text location into a formatted 7-day forecast reply.
 */
export async function weatherReplyForecast(query: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const loc = await geocodeLocation(query, fetchImpl);
	if (!loc) return `❌ Couldn't find a location matching "${escapeHtml(query)}". Try "/tgweather forecast City, Country".`;
	const forecast = await fetchForecast(loc, fetchImpl);
	return formatForecast(forecast, query);
}

/**
 * Resolve a free-text location into a Rich Message 7-day forecast reply.
 */
export async function weatherReplyForecastRich(query: string, fetchImpl: typeof fetch = fetch): Promise<InputRichMessage> {
	const loc = await geocodeLocation(query, fetchImpl);
	if (!loc) {
		return buildForecastRichMessage({
			region: "Unknown",
			rows: [],
			query: `❌ Couldn't find a location matching "${query}". Try "/tgweather forecast City, Country".`,
		});
	}
	const forecast = await fetchForecast(loc, fetchImpl);
	return formatForecastRich(forecast, query);
}

/** Format a single forecast day as a Rich Message payload. */
export function formatForecastDayRich(result: ForecastResult, day: ForecastDay, query?: string): InputRichMessage {
	const region = [result.location.name, result.location.admin1, result.location.country].filter(Boolean).join(", ");
	const date = new Date(day.date + "T12:00:00");
	const dayName = date.toLocaleDateString("en-GB", { weekday: "long" });
	const dateStr = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
	return buildForecastDayRichMessage({
		region,
		day: {
			day: `${dayName} ${dateStr}`,
			conditions: describeWeatherCode(day.weatherCode),
			high: `${day.max.toFixed(1)}°C`,
			low: `${day.min.toFixed(1)}°C`,
		},
		query,
	});
}

/**
 * Resolve a free-text location + target day into a single-day Rich Message
 * forecast reply. Returns a "no data" card when the requested day is outside
 * the 7-day forecast window or the location can't be found.
 */
export async function weatherReplyForecastDayRich(
	query: string,
	target: ForecastTarget,
	fetchImpl: typeof fetch = fetch,
): Promise<InputRichMessage> {
	const loc = await geocodeLocation(query, fetchImpl);
	const notFound = `❌ Couldn't find a location matching "${query}". Try "/tgweather forecast City, Country".`;
	if (!loc) {
		return buildForecastDayRichMessage({
			region: "Unknown",
			day: { day: "", conditions: notFound, high: "", low: "" },
			query,
		});
	}
	const region = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
	const forecast = await fetchForecast(loc, fetchImpl);
	const day = selectForecastDay(forecast.days, target);
	if (!day) {
		return buildForecastDayRichMessage({
			region,
			day: { day: "", conditions: "❌ No forecast available for that day — it's beyond the 7-day forecast window.", high: "", low: "" },
			query,
		});
	}
	return formatForecastDayRich(forecast, day, query);
}

/**
 * Convert a WMO weather code to a short human-readable label + emoji.
 *
 * Codes from https://open-meteo.com/en/docs
 */
export function describeWeatherCode(code: number): string {
	const map: Record<number, string> = {
		0: "☀️ clear sky",
		1: "🌤️ mainly clear",
		2: "⛅ partly cloudy",
		3: "☁️ overcast",
		45: "🌫️ fog",
		48: "🌫️ depositing rime fog",
		51: "🌦️ light drizzle",
		53: "🌦️ moderate drizzle",
		55: "🌧️ dense drizzle",
		56: "🌦️ light freezing drizzle",
		57: "🌧️ dense freezing drizzle",
		61: "🌧️ slight rain",
		63: "🌧️ moderate rain",
		65: "🌧️ heavy rain",
		66: "🌨️ light freezing rain",
		67: "🌨️ heavy freezing rain",
		71: "🌨️ slight snow",
		73: "🌨️ moderate snow",
		75: "🌨️ heavy snow",
		77: "🌨️ snow grains",
		80: "🌦️ slight rain showers",
		81: "🌦️ moderate rain showers",
		82: "⛈️ violent rain showers",
		85: "🌨️ slight snow showers",
		86: "🌨️ heavy snow showers",
		95: "⛈️ thunderstorm",
		96: "⛈️ thunderstorm with hail",
		99: "⛈️ heavy thunderstorm with hail",
	};
	return map[code] ?? "🌡️ unknown conditions";
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

/**
 * Format a WeatherResult as a Telegram HTML message.
 */
export function formatWeather(result: WeatherResult, query?: string): string {
	const loc = result.location;
	const region = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
	const conditions = describeWeatherCode(result.current.weatherCode);
	const lines = [
		`<b>Weather for ${escapeHtml(region)}</b>`,
		"",
		`${conditions}`,
		`🌡️ ${result.current.temperature.toFixed(1)}°C`,
		`💧 ${result.current.relativeHumidity}% humidity`,
		`💨 ${result.current.windSpeed.toFixed(1)} km/h wind`,
		`📈 High ${result.daily.max.toFixed(1)}°C · Low ${result.daily.min.toFixed(1)}°C`,
	];
	if (query && query.trim().toLowerCase() !== region.toLowerCase()) {
		lines.push("", `<i>Query: ${escapeHtml(query)}</i>`);
	}
	return lines.join("\n");
}

/**
 * Format a WeatherResult as a Rich Message payload.
 */
export function formatWeatherRich(result: WeatherResult, query?: string): InputRichMessage {
	const region = [result.location.name, result.location.admin1, result.location.country].filter(Boolean).join(", ");
	return buildWeatherRichMessage({
		region,
		conditions: describeWeatherCode(result.current.weatherCode),
		temperature: result.current.temperature,
		humidity: result.current.relativeHumidity,
		windSpeed: result.current.windSpeed,
		high: result.daily.max,
		low: result.daily.min,
		query,
	});
}

/**
 * Resolve a free-text location into a formatted weather reply.
 *
 * Returns a string ready to send back to the user. Throws on network errors;
 * callers should catch and present a friendly message.
 */
export async function weatherReply(query: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const loc = await geocodeLocation(query, fetchImpl);
	if (!loc) return `❌ Couldn't find a location matching "${escapeHtml(query)}". Try "/tgweather City, Country".`;
	const weather = await fetchWeather(loc, fetchImpl);
	return formatWeather(weather, query);
}

/**
 * Resolve a free-text location into a Rich Message weather reply.
 */
export async function weatherReplyRich(query: string, fetchImpl: typeof fetch = fetch): Promise<InputRichMessage> {
	const loc = await geocodeLocation(query, fetchImpl);
	if (!loc) {
		return buildWeatherRichMessage({
			region: "Unknown",
			conditions: `❌ Couldn't find a location matching "${query}". Try "/tgweather City, Country".`,
			temperature: 0,
			humidity: 0,
			windSpeed: 0,
			high: 0,
			low: 0,
			query,
		});
	}
	const weather = await fetchWeather(loc, fetchImpl);
	return formatWeatherRich(weather, query);
}
