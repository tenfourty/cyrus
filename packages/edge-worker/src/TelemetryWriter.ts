import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerTelemetryRecord } from "cyrus-core";

export interface TelemetryWriterOptions {
	onError?: (message: string) => void;
}

/**
 * Append-only NDJSON writer, one file per session at <dir>/<sessionId>.jsonl.
 *
 * Lives separately from the main edge-worker-state.json blob (already 48MB
 * on long-running installs) so per-turn telemetry growth is bounded to its
 * own files and can be deleted/gzipped/exported independently.
 *
 * Disk errors are swallowed and routed to onError so a write-amplification
 * failure (e.g., volume full) can't crash a live agent session.
 */
export class TelemetryWriter {
	private dirEnsured = false;

	constructor(
		private readonly dir: string,
		private readonly options: TelemetryWriterOptions = {},
	) {}

	async appendTurn(record: RunnerTelemetryRecord): Promise<void> {
		try {
			if (!this.dirEnsured) {
				await mkdir(this.dir, { recursive: true });
				this.dirEnsured = true;
			}
			const file = join(this.dir, `${record.sessionId}.jsonl`);
			await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
		} catch (err) {
			const msg = `telemetry write failed: ${(err as Error).message}`;
			if (this.options.onError) this.options.onError(msg);
		}
	}
}
