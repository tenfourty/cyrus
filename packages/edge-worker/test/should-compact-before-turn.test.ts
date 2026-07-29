import { describe, expect, it, vi } from "vitest";
import {
	resolveAutoCompactThresholdPercent,
	shouldCompactBeforeTurn,
} from "../src/pre-turn-compact.js";

function makeSession(overrides: {
	model?: string;
	usage?: {
		input_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	modelUsage?: Record<string, { contextWindow?: number }>;
}): any {
	return {
		id: "sess-1",
		claudeSessionId: "claude-1",
		metadata: {
			...(overrides.model !== undefined && { model: overrides.model }),
			...(overrides.usage !== undefined && { usage: overrides.usage }),
			...(overrides.modelUsage !== undefined && {
				modelUsage: overrides.modelUsage,
			}),
		},
	};
}

const silentLogger: any = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	withContext: function () {
		return this;
	},
};

describe("shouldCompactBeforeTurn", () => {
	it("returns compact: false when no threshold configured (operator opt-in)", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 150_000 },
			}),
			thresholdPercent: undefined,
			logger: silentLogger,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("no-threshold-configured");
	});

	it("returns compact: false when session has no recorded usage yet", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({ model: "claude-sonnet-4-6" }),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("no-usage-yet");
	});

	it("returns compact: true when current usage exceeds threshold on a 200k window", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 120_000 }, // 60% of 200k
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(true);
		expect(result.currentPercent).toBeCloseTo(60);
	});

	it("returns compact: false when current usage is below threshold", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 40_000 }, // 20% of 200k
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(false);
		expect(result.currentPercent).toBeCloseTo(20);
	});

	it("sums input_tokens + cache_read + cache_creation as the effective context size", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-sonnet-4-6",
				usage: {
					input_tokens: 10_000,
					cache_read_input_tokens: 90_000,
					cache_creation_input_tokens: 20_000,
				}, // total 120_000 = 60% of 200k
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(true);
		expect(result.currentPercent).toBeCloseTo(60);
	});

	it("recognizes the 1M-token window for Opus [1m] models", () => {
		// 600k tokens on a 1M window = 60% — over a 50% threshold
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-opus-4-7[1m]",
				usage: { input_tokens: 600_000 },
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(true);
		expect(result.currentPercent).toBeCloseTo(60);
	});

	it("falls back to a 200k window when the model is unknown or missing", () => {
		// 120k tokens, no model → assume 200k window → 60%
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				usage: { input_tokens: 120_000 },
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(true);
		expect(result.currentPercent).toBeCloseTo(60);
	});

	it("does not trigger compact when usage is zero (e.g. brand-new session)", () => {
		const result = shouldCompactBeforeTurn({
			session: makeSession({
				model: "claude-sonnet-4-6",
				usage: {
					input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}),
			thresholdPercent: 50,
			logger: silentLogger,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("zero-tokens");
	});
	// -------------------------------------------------------------------
	// Context window: the SDK reports the real value on every result
	// message (`modelUsage[model].contextWindow`). The built-in map is only
	// a fallback for before the first result lands.
	// -------------------------------------------------------------------
	describe("context window resolution", () => {
		it("prefers the SDK-reported contextWindow over the built-in map", () => {
			// 300k tokens would be 150% of the map's 200k fallback (compact),
			// but is only 30% of the 1M window the SDK actually reported.
			const result = shouldCompactBeforeTurn({
				session: makeSession({
					model: "some-future-model",
					usage: { input_tokens: 300_000 },
					modelUsage: { "some-future-model": { contextWindow: 1_000_000 } },
				}),
				thresholdPercent: 50,
				logger: silentLogger,
			});
			expect(result.compact).toBe(false);
			expect(result.currentPercent).toBeCloseTo(30);
		});

		it("falls back to the built-in map when modelUsage has no entry for the session model", () => {
			// Only a subagent's model was billed; guessing across entries could
			// pick up a different window, so the map is used instead.
			const result = shouldCompactBeforeTurn({
				session: makeSession({
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 120_000 },
					modelUsage: { "claude-haiku-4-5": { contextWindow: 1_000_000 } },
				}),
				thresholdPercent: 50,
				logger: silentLogger,
			});
			expect(result.compact).toBe(true);
			expect(result.currentPercent).toBeCloseTo(60);
		});

		it("ignores a non-positive or non-numeric reported contextWindow", () => {
			const result = shouldCompactBeforeTurn({
				session: makeSession({
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 120_000 },
					modelUsage: { "claude-sonnet-4-6": { contextWindow: 0 } },
				}),
				thresholdPercent: 50,
				logger: silentLogger,
			});
			expect(result.compact).toBe(true);
			expect(result.currentPercent).toBeCloseTo(60);
		});
	});
});

// ---------------------------------------------------------------------
// Threshold validation. `ConfigService.load()` never safeParses
// ~/.cyrus/config.json against the Zod schema, so on self-host installs an
// arbitrary JSON value reaches the code that both injects
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and drives the pre-turn guard.
// ---------------------------------------------------------------------
describe("resolveAutoCompactThresholdPercent", () => {
	function loggerSpy() {
		return {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			withContext() {
				return this;
			},
		} as any;
	}

	it("passes integers inside 1-99 through unchanged", () => {
		for (const value of [1, 50, 75, 99]) {
			const logger = loggerSpy();
			expect(resolveAutoCompactThresholdPercent(value, logger)).toBe(value);
			expect(logger.warn).not.toHaveBeenCalled();
		}
	});

	it("returns undefined without warning when unset", () => {
		const logger = loggerSpy();
		expect(
			resolveAutoCompactThresholdPercent(undefined, logger),
		).toBeUndefined();
		expect(resolveAutoCompactThresholdPercent(null, logger)).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("rejects 0 and negatives, which would otherwise make every resume compact", () => {
		// currentPercent >= 0 is always true, so a 0 threshold would spawn a
		// full /compact subprocess before literally every resume.
		for (const value of [0, -1, -100]) {
			const logger = loggerSpy();
			expect(resolveAutoCompactThresholdPercent(value, logger)).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("rejects values above 99, which would silently disable the guard", () => {
		for (const value of [100, 150]) {
			const logger = loggerSpy();
			expect(resolveAutoCompactThresholdPercent(value, logger)).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("rejects non-integers", () => {
		const logger = loggerSpy();
		expect(resolveAutoCompactThresholdPercent(50.5, logger)).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("rejects non-numeric values, which would reach Claude Code verbatim", () => {
		// String(value) is what lands in CLAUDE_AUTOCOMPACT_PCT_OVERRIDE.
		for (const value of ["abc", "75", true, {}, []]) {
			const logger = loggerSpy();
			expect(resolveAutoCompactThresholdPercent(value, logger)).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("rejects NaN and Infinity", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const logger = loggerSpy();
			expect(resolveAutoCompactThresholdPercent(value, logger)).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("names the offending source in the warning so operators can find it", () => {
		const logger = loggerSpy();
		resolveAutoCompactThresholdPercent(
			0,
			logger,
			"repository.autoCompactThresholdPercent",
		);
		expect(logger.warn.mock.calls[0][0]).toContain(
			"repository.autoCompactThresholdPercent",
		);
	});
});
