/**
 * Per-session turn queue with status tracking.
 *
 * Two lanes:
 *   - "control"  — slash commands and reactions. Drained before prompts.
 *   - "prompt"   — user text. FIFO with optional priority boost.
 *
 * Status lifecycle:
 *   pending → running → completed
 *
 * Reactions: 👍/⚡/❤/🔥 = priority++ (jump the queue), 🗑/👎 = remove
 * the message that was replied to.
 *
 * The queue is in-memory only. We persist nothing between sessions.
 */

import type { PendingTurn } from "./types.js";

export type TurnStatus = "pending" | "running" | "completed";

export interface TrackedTurn extends PendingTurn {
	status: TurnStatus;
}

let nextId = 1;
function genId(): string {
	return `t${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export class TurnQueue {
	private items: TrackedTurn[] = [];

	/** Number of items currently in the queue. */
	get size(): number {
		return this.items.length;
	}

	/** Snapshot of all items (for /queue display). */
	list(): TrackedTurn[] {
		return [...this.items];
	}

	/** Count of pending (not yet running) items. */
	pendingCount(): number {
		return this.items.filter((i) => i.status === "pending").length;
	}

	/** Add a turn. `lane: "control"` puts it ahead of all "prompt" items. */
	enqueue(input: Omit<PendingTurn, "id" | "queuedAt" | "priority" | "lane"> & { lane?: "control" | "prompt" }): TrackedTurn {
		const item: TrackedTurn = {
			id: genId(),
			queuedAt: Date.now(),
			priority: 0,
			lane: input.lane ?? "prompt",
			status: "pending",
			telegramMessageId: input.telegramMessageId,
			text: input.text,
			images: input.images,
			files: input.files,
		};
		this.items.push(item);
		return item;
	}

	/** Mark the next pending turn as running and return it. */
	startNext(): TrackedTurn | null {
		const item = this.peekNext();
		if (!item) return null;
		item.status = "running";
		return item;
	}

	/** Mark the currently-running turn as completed and remove it. */
	completeRunning(): TrackedTurn | null {
		const idx = this.items.findIndex((i) => i.status === "running");
		if (idx === -1) return null;
		const [item] = this.items.splice(idx, 1);
		if (!item) return null;
		return { ...item, status: "completed" };
	}

	/** Peek at the next pending turn without changing status. */
	peekNext(): TrackedTurn | null {
		// Control items always come first.
		const controlIdx = this.items.findIndex((i) => i.lane === "control" && i.status === "pending");
		if (controlIdx !== -1) {
			const item = this.items[controlIdx];
			return item ?? null;
		}
		// Prompt lane: sort by priority desc, then queuedAt asc.
		const pending = this.items
			.filter((i) => i.status === "pending")
			.sort((a, b) => (b.priority - a.priority) || (a.queuedAt - b.queuedAt));
		return pending[0] ?? null;
	}

	/** Bump the priority of a queued turn (called on 👍/⚡ reactions). */
	prioritise(telegramMessageId: number): TrackedTurn | null {
		const item = this.items.find((i) => i.telegramMessageId === telegramMessageId && i.status === "pending");
		if (!item) return null;
		item.priority += 1;
		return item;
	}

	/** Remove a queued turn by the original Telegram message id. */
	removeByMessageId(telegramMessageId: number): TrackedTurn | null {
		const idx = this.items.findIndex((i) => i.telegramMessageId === telegramMessageId);
		if (idx === -1) return null;
		const [item] = this.items.splice(idx, 1);
		return item ?? null;
	}

	/** Clear all pending turns. Returns how many were removed. */
	clearPending(): number {
		const before = this.items.length;
		this.items = this.items.filter((i) => i.status !== "pending");
		return before - this.items.length;
	}

	/** Clear all queued turns. */
	clear(): number {
		const n = this.items.length;
		this.items = [];
		return n;
	}

	/** Find a queued turn by telegram message id, if any. */
	findByMessageId(telegramMessageId: number): TrackedTurn | null {
		return this.items.find((i) => i.telegramMessageId === telegramMessageId) ?? null;
	}
}
