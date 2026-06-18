/**
 * Telegram Bot API 10.1 Rich Messages — minimal builder.
 *
 * Telegram's `sendRichMessage` accepts an InputRichMessage whose payload is
 * either a Telegram Rich HTML document (`html` field) or a Telegram Rich
 * Markdown document (`markdown` field). This module builds the HTML variant.
 *
 * The allowed subset is close to normal HTML: block tags like <h1>...<h6>,
 * <p>, <table>/<thead>/<tbody>/<tr>/<th>/<td>, <pre>, <blockquote>,
 * <ul>/<ol>/<li>, plus inline formatting (<b>, <i>, <u>, <s>, <code>, <a>).
 *
 * We intentionally keep the builder tiny and auditable. For the full Bot API
 * type definitions see https://core.telegram.org/bots/api#rich-messages.
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
		.replace(/\u003cbr\s*\/?\u003e/gi, "\n")
		.replace(/\u003c\/(p|h[1-6]|li|tr)\u003e/gi, "\n")
		.replace(/\u003c[^\u003e]+\u003e/g, "")
		.replace(/\u0026amp;/g, "&")
		.replace(/\u0026lt;/g, "<")
		.replace(/\u0026gt;/g, ">")
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

/** Build a simple <table> from string cells. Cells are NOT re-escaped. */
function table(headers: string[], rows: string[][]): string {
	const ths = headers.map((h) => `<th>${h}</th>`).join("");
	const head = `<thead><tr>${ths}</tr></thead>`;
	const bodyRows = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
		.join("");
	const body = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
	return `<table>${head}${body}</table>`;
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
	const blocks: string[] = [
		h(1, `Weather for ${opts.region}`),
		p(escapeRichHtml(opts.conditions)),
		p([
			`🌡️ ${opts.temperature.toFixed(1)}°C`,
			`💧 ${opts.humidity}% humidity`,
			`💨 ${opts.windSpeed.toFixed(1)} km/h wind`,
			`📈 High ${opts.high.toFixed(1)}°C · Low ${opts.low.toFixed(1)}°C`,
		].join("<br>")),
	];
	if (opts.query && opts.query.trim().toLowerCase() !== opts.region.toLowerCase()) {
		blocks.push(p(italic(`Query: ${opts.query}`)));
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
		escapeRichHtml(r.high),
		escapeRichHtml(r.low),
	]);
	const blocks: string[] = [h(1, `7-day forecast for ${opts.region}`), table(headerCells, rows)];
	if (opts.query && opts.query.trim().toLowerCase() !== opts.region.toLowerCase()) {
		blocks.push(p(italic(`Query: ${opts.query}`)));
	}
	return richHtml(...blocks);
}
