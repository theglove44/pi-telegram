/**
 * Telegram Bot API 10.1 Rich Messages — Rich HTML builder.
 *
 * Telegram's `sendRichMessage` accepts an InputRichMessage whose payload is
 * either a Telegram Rich HTML document (`html` field) or a Telegram Rich
 * Markdown document (`markdown` field). This module builds the HTML variant
 * using the full Rich HTML vocabulary documented at
 * https://core.telegram.org/bots/api#rich-message-formatting-options.
 *
 * Supported Rich HTML block tags (subset we use):
 *   <h1>...<h6>, <p>, <blockquote>, <tg-pull-quote>, <hr/>,
 *   <ul>/<ol>/<li>, <tg-list-item checked>, <details open>/<summary>,
 *   <table><caption><tr><th align> <td align colspan rowspan valign>,
 *   <pre><code class="language-...">, <footer>, <a name="...">.
 *
 * Supported inline tags:
 *   <b>/<strong>, <i>/<em>, <u>/<ins>, <s>/<del>, <tg-spoiler>, <code>,
 *   <tg-marked>, <tg-subscript>, <tg-superscript>, <a href="...">,
 *   <tg-time unix="..." format="...">, <tg-math>...</tg-math>.
 *
 * IMPORTANT: Rich HTML tables do NOT use <thead>/<tbody>; rows live directly
 * under <table>. A <caption> may appear as the first child of <table>.
 */

import type { InputRichMessage } from "./types.js";

export function escapeRichHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

/** Convert a Telegram Rich HTML snippet to a plain-text fallback.
 *
 * Used when `sendRichMessage` is unavailable so the user still gets a
 * readable answer instead of raw tags.
 */
export function plainFromRichHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|h[1-6]|li|tr|blockquote|details|footer|caption|summary)>/gi, "\n")
		.replace(/<hr\s*\/?>/gi, "\n---\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function h(level: number, text: string): string {
	const tag = `h${Math.max(1, Math.min(6, level))}`;
	return `<${tag}>${escapeRichHtml(text)}</${tag}>`;
}

function p(text: string): string {
	return `<p>${text}</p>`;
}

function italic(text: string): string {
	return `<i>${escapeRichHtml(text)}</i>`;
}

function bold(text: string): string {
	return `<b>${escapeRichHtml(text)}</b>`;
}

/** A block quotation with optional credit. Rich HTML: <blockquote>...</blockquote>. */
function blockquote(content: string, credit?: string): string {
	const c = credit ? `<cite>${escapeRichHtml(credit)}</cite>` : "";
	return `<blockquote>${content}${c}</blockquote>`;
}

/** A divider. Rich HTML: <hr/>. */
function divider(): string {
	return `<hr/>`;
}

/** A footer. Rich HTML: <footer>...</footer>. */
function footer(text: string): string {
	return `<footer>${text}</footer>`;
}

/** Build a Rich HTML <table> from pre-rendered cell HTML.
 *
 * Rich HTML tables are flat: <table><caption>?<tr><th|td>...</tr>...</table>.
 * There is NO <thead>/<tbody>; those are plain-HTML constructs the Rich HTML
 * parser does not recognise, which is why earlier output rendered flat.
 */
function table(opts: {
	caption?: string;
	headers?: string[];
	rows: string[][];
	isBordered?: boolean;
	isStriped?: boolean;
}): string {
	const cap = opts.caption ? `<caption>${escapeRichHtml(opts.caption)}</caption>` : "";
	const headerRow = opts.headers?.length
		? `<tr>${opts.headers.map((hd) => `<th>${hd}</th>`).join("")}</tr>`
		: "";
	const bodyRows = opts.rows
		.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
		.join("");
	return `<table>${cap}${headerRow}${bodyRows}</table>`;
}

/** Helper to build a Rich HTML document from one or more block fragments. */
function richHtml(...blocks: string[]): InputRichMessage {
	return { html: blocks.join("") };
}

/** Build the Rich HTML payload for a current-weather reply. */
export function buildWeatherRichMessage(opts: {
	region: string;
	conditions: string;
	temperature: number;
	humidity: number;
	windSpeed: number;
	high: number;
	low: number;
	query?: string;
}): InputRichMessage {
	const temp = opts.temperature.toFixed(1);
	const hum = String(opts.humidity);
	const wind = opts.windSpeed.toFixed(1);
	const hi = opts.high.toFixed(1);
	const lo = opts.low.toFixed(1);

	// Conditions as a pull quote — Telegram renders these as centred emphasis.
	const conditionsQuote = `<tg-pull-quote>${escapeRichHtml(opts.conditions)}</tg-pull-quote>`;

	// Key metrics in a bordered, striped two-column table for a clean card look.
	const metrics = table({
		caption: "Current conditions",
		isBordered: true,
		isStriped: true,
		rows: [
			[`🌡️ Temperature`, bold(`${temp}°C`)],
			[`💧 Humidity`, bold(`${hum}%`)],
			[`💨 Wind`, bold(`${wind} km/h`)],
			[`📈 High / 📉 Low`, bold(`${hi}°C / ${lo}°C`)],
		],
	});

	const blocks: string[] = [
		h(1, `Weather for ${opts.region}`),
		conditionsQuote,
		metrics,
		divider(),
	];

	if (opts.query && opts.query.trim().toLowerCase() !== opts.region.toLowerCase()) {
		blocks.push(footer(italic(`Query: ${opts.query}`)));
	}

	return richHtml(...blocks);
}

/** A single forecast day prepared for the rich table. */
export interface RichForecastRow {
	day: string;
	conditions: string;
	high: string;
	low: string;
}

/** Build the Rich HTML payload for a 7-day forecast reply. */
export function buildForecastRichMessage(opts: {
	region: string;
	rows: RichForecastRow[];
	query?: string;
}): InputRichMessage {
	const headerCells = ["Day", "Conditions", "High", "Low"];
	const rows = opts.rows.map((r) => [
		escapeRichHtml(r.day),
		escapeRichHtml(r.conditions),
		bold(escapeRichHtml(r.high)),
		escapeRichHtml(r.low),
	]);

	const forecastTable = table({
		caption: `7-day forecast for ${opts.region}`,
		headers: headerCells,
		rows,
		isBordered: true,
		isStriped: true,
	});

	const blocks: string[] = [
		h(1, `Forecast for ${opts.region}`),
		forecastTable,
		divider(),
	];

	if (opts.query && opts.query.trim().toLowerCase() !== opts.region.toLowerCase()) {
		blocks.push(footer(italic(`Query: ${opts.query}`)));
	}

	return richHtml(...blocks);
}