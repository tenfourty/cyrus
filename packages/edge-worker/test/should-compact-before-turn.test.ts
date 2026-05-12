import { describe, expect, it } from "vitest";
import { shouldCompactBeforeTurn } from "../src/pre-turn-compact.js";

function makeSession(overrides: {
	model?: string;
	usage?: {
		input_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}): any {
	return {
		id: "sess-1",
		claudeSessionId: "claude-1",
		metadata: {
			...(overrides.model !== undefined && { model: overrides.model }),
			...(overrides.usage !== undefined && { usage: overrides.usage }),
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
});
