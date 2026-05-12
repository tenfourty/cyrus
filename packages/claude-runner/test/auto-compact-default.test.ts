import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBaseSessionEnv } from "../src/session-env.js";

/**
 * Background — see CHANGELOG entry. Default Claude Code auto-compact
 * triggers when context fills to within ~13k tokens of the model window
 * (~93.5% of a 200k window). That leaves too thin a margin for
 * tool-heavy turns: AIN-555 wedged at ~96% of a 1M-token window after
 * the SDK's two compactions still failed to keep up with growth. Cyrus
 * now lowers the trigger to 50% by default via
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE so compaction fires earlier and
 * sessions stay survivable. Operators can override per parent
 * env or per-repo `.env`.
 */
describe("buildBaseSessionEnv auto-compact default", () => {
	const original = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
	beforeEach(() => {
		delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
	});
	afterEach(() => {
		if (original === undefined) {
			delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
		} else {
			process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = original;
		}
	});

	it("injects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 when the parent env does not set it", () => {
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("50");
	});

	it("honors a parent-process CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value verbatim", () => {
		process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "75";
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("75");
	});

	it("lets repo-supplied extra env override the Cyrus default (per-repo .env wins)", () => {
		const env = buildBaseSessionEnv({
			CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60",
		});
		expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("60");
	});
});
