import { describe, expect, it } from "vitest";
import { EdgeConfigSchema, RepositoryConfigSchema } from "./config-schemas.js";

const baseRepo = {
	id: "r1",
	name: "r1",
	repositoryPath: "/tmp/r",
	workspaceBaseDir: "/tmp/r-ws",
	baseBranch: "main",
};

describe("telemetry config", () => {
	it("accepts telemetry block on EdgeConfig with all fields", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			telemetry: {
				enabled: true,
				linearFooter: false,
				ndjsonDir: "/tmp/telemetry",
				otlp: {
					endpoint: "http://localhost:4318",
					protocol: "http/protobuf",
					headers: { "x-api-key": "secret" },
				},
			},
		});
		expect(parsed.telemetry?.enabled).toBe(true);
		expect(parsed.telemetry?.linearFooter).toBe(false);
		expect(parsed.telemetry?.otlp?.endpoint).toBe("http://localhost:4318");
	});

	it("strips unknown legacy `linearRollup` field with strict-mode behavior", () => {
		// We intentionally removed linearRollup. Zod's default behavior strips
		// unknown keys, so existing configs that set it continue to load —
		// the field is just ignored. No backward-compat shim needed.
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			telemetry: { enabled: true, linearRollup: true } as any,
		});
		expect((parsed.telemetry as any).linearRollup).toBeUndefined();
	});

	it("accepts telemetry override on RepositoryConfig", () => {
		const parsed = RepositoryConfigSchema.parse({
			...baseRepo,
			telemetry: { enabled: false },
		});
		expect(parsed.telemetry?.enabled).toBe(false);
	});

	it("accepts EdgeConfig without telemetry (off by default)", () => {
		const parsed = EdgeConfigSchema.parse({ repositories: [] });
		expect(parsed.telemetry).toBeUndefined();
	});

	it("rejects invalid otlp.protocol", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				telemetry: {
					otlp: { endpoint: "http://x", protocol: "not-a-protocol" },
				},
			}),
		).toThrow();
	});
});
