import { describe, expect, it } from "vitest";
import { LinearWorkspaceConfigSchema } from "../src/config-schemas.js";

describe("LinearWorkspaceConfigSchema linearTokenExpiresAt", () => {
	it("accepts and preserves an absolute token expiry (epoch ms)", () => {
		const parsed = LinearWorkspaceConfigSchema.parse({
			linearToken: "token",
			linearRefreshToken: "refresh",
			linearTokenExpiresAt: 1_700_000_000_000,
		});
		expect(parsed.linearTokenExpiresAt).toBe(1_700_000_000_000);
	});

	it("treats linearTokenExpiresAt as optional for legacy configs", () => {
		const parsed = LinearWorkspaceConfigSchema.parse({
			linearToken: "token",
		});
		expect(parsed.linearTokenExpiresAt).toBeUndefined();
	});
});
