/**
 * Render assistant text to Telegram-safe HTML.
 *
 * Telegram HTML is a strict subset: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href="...">. We:
 *   1. Extract fenced code blocks so they're not mangled by markdown parsing.
 *   2. Run a small markdown-to-HTML pass.
 *   3. Reassemble code blocks (HTML-escaped, in <pre>).
 *   4. HTML-escape everything that isn't a known tag.
 *   5. Chunk to 4096 chars on safe boundaries (whitespace, after closing tags).
 *
 * We do NOT use MarkdownV2 — it requires escaping all `_*[]()~\`>#+-=|{}.!`
 * characters and one stray `*` in user content breaks the whole message.
 * HTML is more forgiving.
 *
 * We also parse assistant-authored `<!-- telegram_button ... -->` and
 * `<!-- telegram_voice ... -->` markup, removing the markers from the
 * visible text. Buttons are returned alongside the text; the caller
 * renders them as a Telegram inline keyboard.
 */

import type { InlineButton } from "./types.js";

const MAX_TG_MESSAGE = 4096;

export interface RenderedMessage {
	/** HTML body, ready for parse_mode=HTML. */
	html: string;
	/** Buttons extracted from telegram_button markup. */
	buttons: InlineButton[];
	/** Voice markers extracted from telegram_voice markup. */
	voice: Array<{ text: string; lang?: string; rate?: string }>;
	/** Did this text contain voice markup? */
	hasVoice: boolean;
}

const FENCE_RE = /```([a-zA-Z0-9_+\-#]*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /(^|[^A-Za-z0-9_])_([^_\n]+)_/g;
const STRIKE_RE = /~~([^~\n]+)~~/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

const TG_BUTTON_RE = /<!--\s*telegram_button\s+text="([^"]+)"\s+action="([^"]+)"\s*-->/g;
const TG_VOICE_RE = /<!--\s*telegram_voice(?:\s+text="([^"]*)")?(?:\s+lang="([^"]*)")?(?:\s+rate="([^"]*)")?\s*-->/g;

const HTML_ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => HTML_ESCAPE[c] ?? c);
}

function escapeAttr(s: string): string {
	return escapeHtml(s);
}

/** Render a single line (not in a code block) to safe Telegram HTML. */
function renderInline(s: string): string {
	let out = escapeHtml(s);

	// Inline code first — must come before other markdown because we don't
	// want to interpret * inside code spans.
	out = out.replace(INLINE_CODE_RE, (_m, code: string) => `<code>${code}</code>`);

	// Bold
	out = out.replace(BOLD_RE, (_m, txt: string) => `<b>${txt}</b>`);

	// Italic
	out = out.replace(ITALIC_RE, (_m, lead: string, txt: string) => `${lead}<i>${txt}</i>`);

	// Strikethrough
	out = out.replace(STRIKE_RE, (_m, txt: string) => `<s>${txt}</s>`);

	// Links [text](url)
	out = out.replace(LINK_RE, (_m, txt: string, url: string) => `<a href="${escapeAttr(url)}">${txt}</a>`);

	return out;
}

interface CodeBlock { lang: string; code: string }

/** Extract fenced code blocks, return them separately for un-mangled rendering. */
function extractCodeBlocks(input: string): { text: string; blocks: CodeBlock[] } {
	const blocks: CodeBlock[] = [];
	const text = input.replace(FENCE_RE, (_m, lang: string, code: string) => {
		const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
		blocks.push({ lang: lang ?? "", code: trimmed });
		return "\u0000CODEBLOCK_" + (blocks.length - 1) + "\u0000";
	});
	return { text, blocks };
}

function reassembleCodeBlocks(text: string, blocks: CodeBlock[]): string {
	return text.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx: string) => {
		const block = blocks[Number(idx)];
		if (!block) return "";
		const escaped = escapeHtml(block.code);
		if (block.lang) {
			return `<pre><code class="language-${escapeAttr(block.lang)}">${escaped}</code></pre>`;
		}
		return `<pre>${escaped}</pre>`;
	});
}

/** Render the full message body to safe Telegram HTML. */
export function renderMessage(text: string): RenderedMessage {
	const buttons: InlineButton[] = [];
	const voice: Array<{ text: string; lang?: string; rate?: string }> = [];
	let hasVoice = false;

	// 1. Strip telegram_button markup into structured data.
	let cleaned = text.replace(TG_BUTTON_RE, (_m, btnText: string, action: string) => {
		buttons.push({ text: btnText, action });
		return "";
	});

	// 2. Strip telegram_voice markup.
	cleaned = cleaned.replace(TG_VOICE_RE, (_m, vText: string | undefined, lang: string | undefined, rate: string | undefined) => {
		voice.push({ text: vText ?? "", lang, rate });
		hasVoice = true;
		return "";
	});

	// 3. Extract code blocks.
	const { text: stripped, blocks } = extractCodeBlocks(cleaned);

	// 4. Per-line rendering (avoid lines that are only placeholders).
	const lines = stripped.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const codeMatch = /^(\s*)\u0000CODEBLOCK_(\d+)\u0000(\s*)$/.exec(line);
		if (codeMatch) {
			const block = blocks[Number(codeMatch[2])];
			if (block) {
				const escaped = escapeHtml(block.code);
				if (block.lang) {
					out.push(`<pre><code class="language-${escapeAttr(block.lang)}">${escaped}</code></pre>`);
				} else {
					out.push(`<pre>${escaped}</pre>`);
				}
			}
			continue;
		}
		out.push(renderInline(line));
	}

	const html = reassembleCodeBlocks(out.join("\n"), blocks).trim();

	return { html, buttons, voice, hasVoice };
}

/**
 * Split a (potentially long) HTML message into chunks under 4096 chars.
 * Prefers to break on closing tags or whitespace.
 */
export function chunkForTelegram(html: string, max = MAX_TG_MESSAGE): string[] {
	if (html.length <= max) return [html];

	const chunks: string[] = [];
	let cursor = 0;
	const len = html.length;
	while (cursor < len) {
		const remaining = html.slice(cursor);
		if (remaining.length <= max) {
			chunks.push(remaining);
			break;
		}
		// Find the best break point ≤ max.
		let cut = max;
		const slice = remaining.slice(0, max);
		// Prefer "</pre>" or "</code>" or "\n\n" or " " as the break.
		const candidates: Array<[RegExp, number]> = [
			[/<\/pre>/g, 7],
			[/<\/code>/g, 8],
			[/\n\n/g, 2],
			[/[ \t]/g, 1],
		];
		for (const [re, len] of candidates) {
			re.lastIndex = 0;
			let best = -1;
			let m: RegExpExecArray | null;
			while ((m = re.exec(slice)) !== null) {
				best = m.index + len;
			}
			if (best > max * 0.5) {
				cut = best;
				break;
			}
		}
		chunks.push(remaining.slice(0, cut));
		cursor += cut;
	}
	return chunks;
}
