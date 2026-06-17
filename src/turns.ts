/**
 * Convert a Telegram message (or media group) into a pi-side user message.
 *
 * - Text: passed as-is, prefixed with sender attribution in group/DM context.
 * - Photos: largest variant is downloaded; base64 + mediaType passed to
 *   `pi.sendUserMessage({ ..., images })`.
 * - Documents/voice/audio/video: downloaded to a temp file; the path is
 *   passed in `files` so the LLM can read it. We do not transcribe voice
 *   inline — that's a separate concern (out of scope for v1).
 *
 * Media groups (multiple photos + caption) are handled in `media.ts`.
 */

import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TelegramClient } from "./transport.js";
import { ensureTempDir } from "./config.js";
import type { TgMessage, TgPhotoSize, TgDocument, TgVoice, TgAudio, TgVideo } from "./types.js";

export interface BuiltTurn {
	text: string;
	images: Array<{ mimeType: string; data: string }>;
	files: Array<{ path: string; name: string; mime?: string }>;
}

const PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

function inferImageMediaType(buf: Buffer): string {
	// Magic byte sniff — covers JPEG, PNG, WebP, GIF.
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
	return "application/octet-stream";
}

function pickLargestPhoto(photos: TgPhotoSize[]): TgPhotoSize {
	return photos.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
}

async function downloadToTemp(
	client: TelegramClient,
	fileId: string,
	ext: string,
): Promise<{ path: string; size: number }> {
	const meta = await client.getFile(fileId);
	if (!meta.file_path) throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
	const dir = await ensureTempDir();
	const name = `${randomUUID()}${ext}`;
	const abs = join(dir, name);
	const { size } = await client.downloadFile(meta.file_path, abs);
	return { path: abs, size };
}

export async function buildTurnFromMessage(
	client: TelegramClient,
	msg: TgMessage,
): Promise<BuiltTurn> {
	const text = (msg.text ?? msg.caption ?? "").trim();
	const images: BuiltTurn["images"] = [];
	const files: BuiltTurn["files"] = [];

	if (msg.photo && msg.photo.length > 0) {
		const largest = pickLargestPhoto(msg.photo);
		const meta = await client.getFile(largest.file_id);
		if (meta.file_path) {
			// For images we want the bytes in memory (pi takes base64).
			const dir = await ensureTempDir();
			const name = `${randomUUID()}.img`;
			const abs = join(dir, name);
			await client.downloadFile(meta.file_path, abs);
			const { readFileSync } = await import("node:fs");
			const buf = readFileSync(abs);
			images.push({ mimeType: inferImageMediaType(buf), data: buf.toString("base64") });
		}
	}

	if (msg.document) {
		const f = await downloadDocument(client, msg.document);
		files.push(f);
	}
	if (msg.voice) {
		const f = await downloadVoice(client, msg.voice);
		files.push(f);
	}
	if (msg.audio) {
		const f = await downloadAudio(client, msg.audio);
		files.push(f);
	}
	if (msg.video) {
		const f = await downloadVideo(client, msg.video);
		files.push(f);
	}

	return { text, images, files };
}

async function downloadDocument(client: TelegramClient, doc: TgDocument): Promise<{ path: string; name: string; mime?: string }> {
	const ext = doc.file_name ? extname(doc.file_name) : "";
	const { path } = await downloadToTemp(client, doc.file_id, ext);
	return { path, name: doc.file_name ?? basename(path), mime: doc.mime_type };
}

async function downloadVoice(client: TelegramClient, voice: TgVoice): Promise<{ path: string; name: string; mime?: string }> {
	const ext = voice.mime_type?.includes("ogg") ? ".ogg" : ".voice";
	const { path } = await downloadToTemp(client, voice.file_id, ext);
	return { path, name: basename(path), mime: voice.mime_type ?? "audio/ogg" };
}

async function downloadAudio(client: TelegramClient, audio: TgAudio): Promise<{ path: string; name: string; mime?: string }> {
	const ext = audio.file_name ? extname(audio.file_name) : (audio.mime_type?.includes("mpeg") ? ".mp3" : ".audio");
	const { path } = await downloadToTemp(client, audio.file_id, ext);
	return { path, name: audio.file_name ?? basename(path), mime: audio.mime_type };
}

async function downloadVideo(client: TelegramClient, video: TgVideo): Promise<{ path: string; name: string; mime?: string }> {
	const ext = video.mime_type?.includes("mp4") ? ".mp4" : ".video";
	const { path } = await downloadToTemp(client, video.file_id, ext);
	return { path, name: basename(path), mime: video.mime_type };
}

/** A short header prepended to text turns to give pi context about the source. */
export function annotateForPi(msg: TgMessage, prefix: string): string {
	const sender = msg.from?.username
		? `@${msg.from.username}`
		: msg.from?.first_name ?? "user";
	return `[telegram ${prefix} from ${sender}]\n${msg.text ?? msg.caption ?? ""}`;
}

/** Media-type list exported so render.ts / tests can reference. */
export { PHOTO_MEDIA_TYPES };
