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
				linearRollup: true,
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
