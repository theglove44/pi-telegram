/**
 * Restart the Telegram poll loop without deadlocking when invoked from
 * inside that same loop's handler (Telegram `/tgreconnect`).
 */

export interface ReconnectPolling {
	/** Wrap a poll update handler so reconnect can detect re-entrancy. */
	wrapHandler<U>(handler: (u: U) => Promise<void>): (u: U) => Promise<void>;
	reconnect(): Promise<void>;
}

export interface ReconnectPollingDeps {
	abort: () => void;
	/** Return the current loop promise and drop the handle so a second reconnect cannot share it. */
	takePollTask: () => Promise<void> | null;
	releaseLock: () => Promise<void>;
	startPolling: () => Promise<void>;
	/** Override in tests. Defaults to setImmediate. */
	schedule?: (fn: () => void) => void;
}

export function createReconnectPolling(deps: ReconnectPollingDeps): ReconnectPolling {
	let inPollHandler = false;
	let busy = false;
	const schedule = deps.schedule ?? setImmediate;

	const finish = async (oldTask: Promise<void> | null): Promise<void> => {
		try {
			if (oldTask) {
				try { await oldTask; } catch { /* ignore */ }
			}
			await deps.releaseLock();
			await deps.startPolling();
		} finally {
			busy = false;
		}
	};

	return {
		wrapHandler<U>(handler: (u: U) => Promise<void>): (u: U) => Promise<void> {
			return async (u) => {
				inPollHandler = true;
				try {
					await handler(u);
				} finally {
					inPollHandler = false;
				}
			};
		},
		async reconnect(): Promise<void> {
			if (busy) return;
			busy = true;
			deps.abort();
			const oldTask = deps.takePollTask();
			if (inPollHandler) {
				// Awaiting oldTask here would deadlock: the loop is blocked on this handler.
				schedule(() => { void finish(oldTask); });
				return;
			}
			await finish(oldTask);
		},
	};
}
