import { describe, expect, it } from "vitest";
import { buildBaseSessionEnv } from "../src/session-env.js";

describe("buildBaseSessionEnv otlp passthrough", () => {
	it("sets CLAUDE_CODE_ENABLE_TELEMETRY + OTEL_* vars when otlp config provided", () => {
		const env = buildBaseSessionEnv(undefined, {
			otlp: {
				endpoint: "http://collector:4317",
				protocol: "grpc",
				headers: { "x-api-key": "secret" },
			},
		});
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector:4317");
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-api-key=secret");
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
		expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe(
			"false",
		);
	});

	it("does not set OTel env vars when otlp config absent", () => {
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
	});

	it("defaults protocol to grpc when only endpoint provided", () => {
		const env = buildBaseSessionEnv(undefined, {
			otlp: { endpoint: "http://x:4317" },
		});
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
	});

	it("encodes multi-header object as comma-separated key=value pairs", () => {
		const env = buildBaseSessionEnv(undefined, {
			otlp: {
				endpoint: "http://x",
				headers: { "x-a": "1", "x-b": "2" },
			},
		});
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-a=1,x-b=2");
	});

	it("preserves the `extra` param (no breaking change)", () => {
		const env = buildBaseSessionEnv({ MY_VAR: "hello" });
		expect(env.MY_VAR).toBe("hello");
	});
});
