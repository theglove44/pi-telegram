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

/**
 * Detect whether a text asks for a multi-day forecast.
 *
 * Matches patterns like:
 *   "forecast"
 *   "forecast for London"
 *   "what's the weather in London this week?"
 *   "weather in Paris next few days"
 *   "weekly forecast Tokyo"
 *
 * Returns a {@link ForecastQueryMatch} with an optional extracted location,
 * or null if the text is not a forecast query.
 */
export function isForecastQuery(text: string): ForecastQueryMatch | null {
	const t = text.trim().replace(/[“”"']/g, "");

	// Helper: strip trailing question marks from captured location.
	const loc = (s: string | undefined): string | undefined => {
		const v = s?.replace(/\?+\s*$/, "").trim();
		return v || undefined;
	};

	// "forecast [for] [location]" or "[location] forecast"
	let m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?(?:weekly\s+)?forecast\s*(?:for\s+)?(.+?)$/i);
	if (m) return { text: t, location: loc(m[1]) };

	// "weather [in location] this week / next week / next few days / for the week"
	m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?))?\s*(?:this\s+week|next\s+(?:week|few\s+days|couple\s+of\s+days)|for\s+(?:the\s+)?(?:week|next\s+\d+\s+days))\??$/i);
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
 *   "how's the weather like in Paris today?" -> "Paris today"
 *
 * NOTE: does NOT match forecast keywords ("this week", "next week") —
 * those are handled by {@link isForecastQuery}.
 */
export function extractLocation(text: string): string | null {
	const t = text.trim().replace(/[“”"']/g, "");
	const m = t.match(/^(?:what'?s|how'?s|what is|how is)?\s*(?:the\s+)?weather\s*(?:like\s+)?(?:in\s+(.+?)|$)(?:\s*(?:today|now|currently|right now|at the moment))?\??$/i);
	if (!m) return null;
	const loc = (m[1] ?? "").trim();
	return loc || null;
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
