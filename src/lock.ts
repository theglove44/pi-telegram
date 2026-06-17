/**
 * Singleton polling lock via O_EXCL + pid file.
 *
 * Strategy: write a file with `wx` (create + O_EXCL). If it already exists,
 * check whether the recorded pid is still alive. If dead, take over. If
 * alive, refuse.
 *
 * This is the classic "safe lockfile" pattern (PEP 343 / vacuous pleasure
 * of `flock`-equivalents). It is good enough to prevent two pi processes
 * from polling the same bot simultaneously on a single-user box.
 *
 * Stale-pid detection: `process.kill(pid, 0)` throws ESRCH if dead.
 *
 * Note: NOT a real `flock(2)` — this won't auto-release on process crash
 * unless the OS cleans up the lock file. The release() function MUST be
 * called. We register it on session_shutdown and SIGINT/SIGTERM.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lockFilePath } from "./config.js";

export interface PollingLock {
	release: () => Promise<void>;
}

function pidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM means the process exists but we lack permission — treat as alive.
		return code === "EPERM";
	}
}

/** Try to acquire the polling lock. Returns null if another process holds it. */
export async function tryAcquirePollingLock(): Promise<PollingLock | null> {
	const path = lockFilePath();
	const myPid = process.pid;

	// If the file exists, check whether its owner is alive.
	if (existsSync(path)) {
		let existingPid: number | null = null;
		try {
			const raw = readFileSync(path, "utf8").trim();
			existingPid = Number(raw);
		} catch { /* unreadable; treat as stale */ }
		if (existingPid !== null && Number.isFinite(existingPid) && existingPid !== myPid && pidAlive(existingPid)) {
			return null;        // another live pi owns it
		}
		// Stale — try to take it over.
		try { unlinkSync(path); } catch { /* race; another process beat us */ }
	}

	// Try to create exclusively. O_EXCL via the 'wx' flag in node:fs.
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (err) {
		// EEXIST means we lost the race; assume another live owner.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw err;
	}
	try {
		writeFileSync(fd, `${myPid}\n`, "utf8");
	} finally {
		closeSync(fd);
	}

	let released = false;
	return {
		release: async () => {
			if (released) return;
			released = true;
			// Only delete the file if WE still own it (pid matches).
			try {
				const raw = readFileSync(path, "utf8").trim();
				if (Number(raw) === myPid) unlinkSync(path);
			} catch { /* gone */ }
		},
	};
}
