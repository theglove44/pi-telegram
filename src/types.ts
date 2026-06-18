/**
 * Shared types for pi-telegram.
 *
 * The module intentionally holds no runtime state. Everything is plain
 * data so it can move between the transport, queue, and pi's ExtensionContext
 * without aliasing surprises.
 */

/** Telegram Bot API Update object (subset we use). */
export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	edited_message?: TgMessage;
	callback_query?: TgCallbackQuery;
}

export interface TgMessage {
	message_id: number;
	date: number;
	chat: { id: number; type: string };
	from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
	text?: string;
	caption?: string;
	photo?: TgPhotoSize[];
	document?: TgDocument;
	voice?: TgVoice;
	audio?: TgAudio;
	video?: TgVideo;
	media_group_id?: string;
	reply_to_message?: TgMessage;
	entities?: TgMessageEntity[];
}

export interface TgPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TgDocument {
	file_id: string;
	file_unique_id: string;
	thumb?: TgPhotoSize;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TgVoice {
	file_id: string;
	file_unique_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

export interface TgAudio {
	file_id: string;
	file_unique_id: string;
	duration: number;
	mime_type?: string;
	file_name?: string;
	file_size?: number;
}

export interface TgVideo {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

export interface TgMessageEntity {
	type: string;
	offset: number;
	length: number;
}

export interface TgCallbackQuery {
	id: string;
	from: { id: number };
	chat_instance: string;
	message?: TgMessage;
	data?: string;
}

/** Persisted + keyring-backed config. */
export interface TgConfig {
	botToken: string;          // Resolved at runtime; may come from keyring
	botTokenSource: "keyring" | "json" | "env";
	botUsername?: string;
	botId?: number;
	allowedChatId: number;     // Hard allowlist; only this chat id may drive the bot
	lastUpdateId: number;      // Long-poll offset
	/** Default location for bare weather queries. */
	defaultLocation?: string;
}

/** What's stored in telegram.json (no secrets). */
export interface TgConfigFile {
	botUsername?: string;
	botId?: number;
	allowedChatId: number;
	lastUpdateId: number;
	/** Default location for bare weather queries (e.g. "Rochdale"). */
	defaultLocation?: string;
}

/** A queued user-supplied prompt waiting to be dispatched to pi. */
export interface PendingTurn {
	/** Stable id for keyboard callbacks. */
	id: string;
	/** Original Telegram message id (for the reply reference). */
	telegramMessageId: number;
	/** Combined text the LLM will see. */
	text: string;
	/** Optional images (base64 with mimeType) to attach. */
	images?: Array<{ mimeType: string; data: string }>;
	/** Optional file references (paths on disk) the LLM can read. */
	files?: Array<{ path: string; name: string; mime?: string }>;
	/** Enqueue timestamp. */
	queuedAt: number;
	/** Lane: "control" for slash commands, "prompt" for user text. */
	lane: "control" | "prompt";
	/** Priority boost set by 👍/⚡ reactions. */
	priority: number;
}

/** Inline keyboard button definition (parsed from assistant markup). */
export interface InlineButton {
	text: string;
	action: string;            // callback data
}

/** A draft preview state for streaming. */
export interface DraftState {
	chatId: number;
	messageId: number;
	lastSentText: string;
	lastSentAt: number;
}

/** Telegram Bot API 10.1 InputRichMessage payload.
 *
 * Can be a Telegram Rich HTML string or a Telegram Rich Markdown string.
 * Only one of html/markdown should be provided.
 */
export interface InputRichMessage {
	html?: string;
	markdown?: string;
	is_rtl?: boolean;
	skip_entity_detection?: boolean;
}
