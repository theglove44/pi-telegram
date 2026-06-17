/**
 * Configuration: secrets in keyring, allowlist + state in JSON.
 *
 * Order of token resolution (highest priority first):
 *   1. GNOME keyring via `secret-tool` (service=pi-telegram, account=bot-token)
 *   2. TELEGRAM_BOT_TOKEN env var (only if keyring lookup is unavailable —
 *      env vars leak into subprocesses and process listings, so we treat
 *      them as a deliberate override, not a default)
 *   3. ~/.pi/agent/telegram.json (mode 0o600) — but the JSON file does NOT
 *      hold the token; it only holds botUsername/botId/allowedChatId/lastUpdateId.
 *      The token is always keyring-first.
 *
 * The `allowedChatId` is mandatory. There is no "first DM becomes allowed"
 * pairing flow — at /telegram-setup the user provides it explicitly.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync, renameSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import type { TgConfig, TgConfigFile } from "./types.js";

const execFileP = promisify(execFile);

const KEYRING_SERVICE = "pi-telegram";
const KEYRING_ACCOUNT = "bot-token";

function configFilePath(): string {
	const dir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "telegram.json");
}

function configDir(): string {
	return dirname(configFilePath());
}

function ensureConfigDir(): void {
	const dir = configDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Read the token from the GNOME keyring via secret-tool. */
async function readTokenFromKeyring(): Promise<string | null> {
	try {
		const { stdout } = await execFileP("secret-tool", [
			"lookup",
			`service=${KEYRING_SERVICE}`,
			`account=${KEYRING_ACCOUNT}`,
		], { timeout: 5000 });
		const token = stdout.trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

/**
 * Write the token to the GNOME keyring via secret-tool. We use spawn so we
 * can write the secret to stdin without it appearing on the process command
 * line (which would show up in `ps`, `top`, and the proc cmdline file).
 */
export async function writeTokenToKeyring(token: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("secret-tool", [
			"store",
			"--label=pi-telegram bot token",
			`service=${KEYRING_SERVICE}`,
			`account=${KEYRING_ACCOUNT}`,
		], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
		let stderr = "";
		child.stderr.on("data", (d) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`secret-tool store exited ${code}: ${stderr}`));
		});
		child.stdin.on("error", reject);
		child.stdin.end(token, "utf8");
	});
}

/** Remove the token from the GNOME keyring (best-effort). */
export async function deleteTokenFromKeyring(): Promise<void> {
	try {
		await execFileP("secret-tool", [
			"clear",
			`service=${KEYRING_SERVICE}`,
			`account=${KEYRING_ACCOUNT}`,
		], { timeout: 5000 });
	} catch {
		// Not present is fine.
	}
}

function readConfigFile(): TgConfigFile | null {
	const path = configFilePath();
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<TgConfigFile>;
		if (typeof parsed.allowedChatId !== "number") return null;
		return {
			botUsername: typeof parsed.botUsername === "string" ? parsed.botUsername : undefined,
			botId: typeof parsed.botId === "number" ? parsed.botId : undefined,
			allowedChatId: parsed.allowedChatId,
			lastUpdateId: typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : 0,
			defaultLocation: typeof parsed.defaultLocation === "string" ? parsed.defaultLocation : undefined,
		};
	} catch {
		return null;
	}
}

/** Atomic write: temp + rename + chmod 0o600. */
export function writeConfigFile(cfg: TgConfigFile): void {
	ensureConfigDir();
	const finalPath = configFilePath();
	const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
	const fd = openSync(tmpPath, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(cfg, null, "\t"), "utf8");
	} finally {
		closeSync(fd);
	}
	// Atomic on the same filesystem.
	renameSync(tmpPath, finalPath);
	chmodSync(finalPath, 0o600);
}

/** Last-known good config, even if the JSON file is missing. */
function readConfigFileOrEmpty(): TgConfigFile {
	return readConfigFile() ?? { allowedChatId: 0, lastUpdateId: 0 };
}

/**
 * Resolve the bot token. Never returns the placeholder; throws if no source works.
 * Order: keyring → env → throw.
 */
export async function resolveBotToken(): Promise<{ token: string; source: TgConfig["botTokenSource"] }> {
	const fromKeyring = await readTokenFromKeyring();
	if (fromKeyring) return { token: fromKeyring, source: "keyring" };
	const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
	if (fromEnv && fromEnv.length > 0) return { token: fromEnv, source: "env" };
	throw new Error(
		"pi-telegram: no bot token. " +
		`Store one in the keyring (secret-tool store --label='pi-telegram bot token' service=${KEYRING_SERVICE} account=${KEYRING_ACCOUNT}) ` +
		"or set TELEGRAM_BOT_TOKEN in the environment."
	);
}

/** Load the full config: token (from keyring/env) + file state. */
export async function loadConfig(): Promise<TgConfig> {
	const { token, source } = await resolveBotToken();
	const file = readConfigFileOrEmpty();
	return {
		botToken: token,
		botTokenSource: source,
		botUsername: file.botUsername,
		botId: file.botId,
		allowedChatId: file.allowedChatId,
		lastUpdateId: file.lastUpdateId,
		defaultLocation: file.defaultLocation,
	};
}

/** Persist only the non-secret parts of the config. */
export function saveConfigFile(partial: Partial<TgConfigFile>): TgConfigFile {
	const current = readConfigFileOrEmpty();
	const next: TgConfigFile = { ...current, ...partial };
	writeConfigFile(next);
	return next;
}

/** Update the last seen update_id (used to advance the long-poll offset). */
export function setLastUpdateId(id: number): void {
	if (id <= 0) return;
	const current = readConfigFileOrEmpty();
	if (id > current.lastUpdateId) saveConfigFile({ lastUpdateId: id });
}

/** Read the configured default weather location (if any). */
export function readDefaultLocation(): string | undefined {
	return readConfigFileOrEmpty().defaultLocation;
}

/** Persist a default weather location (or clear it if empty). */
export function saveDefaultLocation(location: string | undefined): void {
	const current = readConfigFileOrEmpty();
	saveConfigFile({ ...current, defaultLocation: location && location.trim() ? location.trim() : undefined });
}

/** Check if the keyring backend is available. */
export async function keyringAvailable(): Promise<boolean> {
	try {
		await execFileP("secret-tool", ["--help"], { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

/** Redact a token in any string — used before logging or notifying. */
export function redactToken(s: string, token: string | null | undefined): string {
	if (!token) return s;
	if (token.length < 8) return s;
	return s.split(token).join("<BOT_TOKEN>");
}

/** Path to the lock file (used by polling.ts). */
export function lockFilePath(): string {
	return join(configDir(), "telegram.lock");
}

/** Path to the temp directory for downloaded media. */
export function tempDirPath(): string {
	return join(configDir(), "tmp", "telegram");
}

export async function ensureTempDir(): Promise<string> {
	const dir = tempDirPath();
	await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
