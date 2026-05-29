import { vi } from "vitest";

type AnyRecord = Record<string | symbol, unknown>;

/**
 * Build a mock object whose every (string-keyed) method is a cached `vi.fn()`
 * unless seeded.
 *
 * Accessing an unseeded method lazily creates and caches a `vi.fn()` on the
 * backing object, so when EdgeWorker (or any caller) starts invoking a
 * brand-new collaborator method, a test using this mock keeps working instead
 * of throwing "<method> is not a function". That throw was the root cause of a
 * recurring class of EdgeWorker test failures: feature branches added new
 * `agentSessionManager.*` / `tracker.*` calls, but the hand-written inline mock
 * literals in each test file were never updated — and the breakage only
 * surfaced on the deploy branch where several features combined.
 *
 * Symbols (e.g. `Symbol.iterator`) and `then` are deliberately NOT auto-stubbed
 * — returning a `vi.fn()` for them would make the mock look iterable/thenable
 * and break vitest deep-equality, `await`, and assertions. The proxy is backed
 * by a real object, so `in`, `Object.keys`, `vi.spyOn`, and reassignment all
 * behave naturally. `seed` supplies specific return values / behaviour.
 */
export function autoMock<T extends object = AnyRecord>(
	seed: AnyRecord = {},
): T {
	const target: AnyRecord = { ...seed };
	return new Proxy(target, {
		get(obj, prop, receiver) {
			// Never synthesize symbols or the promise-detection `then` property.
			if (typeof prop === "symbol" || prop === "then") {
				return Reflect.get(obj, prop, receiver);
			}
			if (!(prop in obj)) {
				obj[prop] = vi.fn();
			}
			return obj[prop];
		},
	}) as T;
}

/**
 * Shared AgentSessionManager test double. Defaults cover the methods the
 * prompted/resume webhook path reads a value from; pass `overrides` for
 * per-test behaviour (most commonly `getSession`). Every other method
 * auto-stubs via {@link autoMock}, so new AgentSessionManager methods never
 * break existing tests.
 */
export function createMockAgentSessionManager(overrides: AnyRecord = {}): any {
	return autoMock({
		getSession: vi.fn().mockReturnValue(null),
		hasAgentRunner: vi.fn().mockReturnValue(false),
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllClaudeRunners: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		getSessionsByIssueId: vi.fn().mockReturnValue([]),
		serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
		postAnalyzingThought: vi.fn().mockResolvedValue(null),
		createThoughtActivity: vi.fn().mockResolvedValue(undefined),
		createResponseActivity: vi.fn().mockResolvedValue(undefined),
		...overrides,
	});
}

/**
 * Shared issue-tracker test double (Linear/GitHub/GitLab adapters implement
 * `IIssueTrackerService`). Defaults cover `getClient`; pass `overrides` for
 * `fetchIssue` / `getIssueLabels` / etc. Every other method auto-stubs, so new
 * tracker methods (e.g. `notifyTurnStarted`) never break existing tests.
 */
export function createMockIssueTracker(overrides: AnyRecord = {}): any {
	return autoMock({
		getClient: vi.fn().mockReturnValue({}),
		...overrides,
	});
}
