/**
 * Guards against two agent runners working the same Linear issue at once.
 *
 * Linear can emit two `AgentSessionEvent: created` webhooks for one issue (a
 * delegation and a comment @-mention), each with its own agentSession id.
 * Cyrus resolves a worktree by issue identifier, so naively starting a runner
 * per webhook means both runners mutate the same worktree and branch. This
 * module provides the decision ("is this a duplicate of a live session?") and
 * a per-issue lock that makes the check-and-act atomic.
 */

export type SessionCreationAction =
	| { action: "create" }
	| { action: "fold-in"; targetSessionId?: string };

interface ActiveSessionLike {
	id: string;
	updatedAt?: number;
}

/**
 * Decide whether a newly-created agent session for `issueId` should spawn its
 * own runner/worktree ("create") or be folded into an already-live session for
 * the same issue ("fold-in"). When folding in, targets the most-recently-active
 * session (the one whose runner is most likely mid-flight), excluding the new
 * session itself so re-entry is idempotent.
 */
export function decideSessionCreationAction(
	issueId: string,
	newSessionId: string,
	deps: {
		getActiveSessionsByIssueId: (issueId: string) => ActiveSessionLike[];
		/**
		 * Whether another session for this issue is mid-initialization (its
		 * worktree is still being created, so it isn't 'active' yet). Closes the
		 * true-concurrency window where two webhooks both see no active session.
		 */
		isIssueInitializing?: (issueId: string) => boolean;
	},
): SessionCreationAction {
	const others = deps
		.getActiveSessionsByIssueId(issueId)
		.filter((s) => s.id !== newSessionId);

	if (others.length > 0) {
		const target = others.reduce((newest, s) =>
			(s.updatedAt ?? 0) > (newest.updatedAt ?? 0) ? s : newest,
		);
		return { action: "fold-in", targetSessionId: target.id };
	}

	if (deps.isIssueInitializing?.(issueId)) {
		// A sibling owns the worktree but has no running runner yet — decline
		// without a delivery target.
		return { action: "fold-in" };
	}

	return { action: "create" };
}

/**
 * A mutex keyed by an arbitrary string. Calls sharing a key run one at a time
 * in submission order; calls with different keys run concurrently. A rejecting
 * callback never wedges later runs on the same key.
 */
export class KeyedMutex {
	private tail = new Map<string, Promise<void>>();

	runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tail.get(key) ?? Promise.resolve();
		// Run fn once the predecessor settles, regardless of its outcome.
		const run = prev.then(fn, fn);
		// The next waiter chains onto a settled (error-swallowed) link.
		const settled = run.then(
			() => {},
			() => {},
		);
		this.tail.set(key, settled);
		// Drop the key once the chain drains, so the map doesn't grow unbounded.
		settled.then(() => {
			if (this.tail.get(key) === settled) {
				this.tail.delete(key);
			}
		});
		return run;
	}
}
