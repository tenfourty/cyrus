import type {
	EdgeConfig,
	EdgeWorkerConfig,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { DEFAULT_SERVER_PORT, parsePort } from "../config/constants.js";

/**
 * Pure assembly of EdgeWorkerConfig from the loaded EdgeConfig, the
 * process environment, and the runtime fields the WorkerService owns.
 *
 * Lives as its own helper so the wiring seam between the on-disk config
 * and the EdgeWorker constructor is testable in isolation. The previous
 * hand-picked field list in WorkerService.startEdgeWorker silently
 * dropped any new top-level EdgeConfig field (most recently
 * `autoCompactThresholdPercent`) until someone remembered to amend
 * the picker — see buildEdgeWorkerConfig.test.ts for the regression.
 *
 * Notes on layering precedence:
 *   1. `...edgeConfig` spreads first so every persisted EdgeConfig field
 *      reaches EdgeWorker unless something below explicitly overrides.
 *   2. The explicit fields below preserve historical env-var precedence
 *      (CYRUS_* env vars > config > legacy `defaultModel`/`defaultFallbackModel`).
 *   3. Runtime-only fields (`version`, `cyrusHome`, `repositories`,
 *      server bindings, ngrok token) are written last; they cannot be
 *      persisted to config.json and the caller owns them.
 *
 * Handlers are intentionally not built here — they close over
 * WorkerService instance state (gitService, onOAuthCallback callback)
 * and are merged onto the result by the caller.
 */
export function buildEdgeWorkerConfig(input: {
	edgeConfig: EdgeConfig;
	env: NodeJS.ProcessEnv;
	repositories: RepositoryConfig[];
	cyrusHome: string;
	version?: string;
	ngrokAuthToken?: string;
}): Omit<EdgeWorkerConfig, "handlers"> {
	const { edgeConfig, env, repositories, cyrusHome, version, ngrokAuthToken } =
		input;

	const isExternalHost =
		env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";

	return {
		...edgeConfig,
		version,
		repositories,
		cyrusHome,
		defaultAllowedTools:
			env.ALLOWED_TOOLS?.split(",").map((t) => t.trim()) ??
			edgeConfig.defaultAllowedTools ??
			[],
		defaultDisallowedTools:
			env.DISALLOWED_TOOLS?.split(",").map((t) => t.trim()) ??
			edgeConfig.defaultDisallowedTools,
		claudeDefaultModel:
			env.CYRUS_CLAUDE_DEFAULT_MODEL ||
			env.CYRUS_DEFAULT_MODEL ||
			edgeConfig.claudeDefaultModel ||
			edgeConfig.defaultModel,
		claudeDefaultFallbackModel:
			env.CYRUS_CLAUDE_DEFAULT_FALLBACK_MODEL ||
			env.CYRUS_DEFAULT_FALLBACK_MODEL ||
			edgeConfig.claudeDefaultFallbackModel ||
			edgeConfig.defaultFallbackModel,
		geminiDefaultModel:
			env.CYRUS_GEMINI_DEFAULT_MODEL || edgeConfig.geminiDefaultModel,
		codexDefaultModel:
			env.CYRUS_CODEX_DEFAULT_MODEL || edgeConfig.codexDefaultModel,
		defaultRunner:
			(env.CYRUS_DEFAULT_RUNNER as RunnerType | undefined) ||
			edgeConfig.defaultRunner,
		webhookBaseUrl: env.CYRUS_BASE_URL,
		serverPort: parsePort(env.CYRUS_SERVER_PORT, DEFAULT_SERVER_PORT),
		serverHost: isExternalHost ? "0.0.0.0" : "localhost",
		ngrokAuthToken,
	};
}
