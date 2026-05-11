import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
} from "./CyrusAgentSession.js";
import { createLogger, type ILogger } from "./logging/index.js";

/** Current persistence format version */
export const PERSISTENCE_VERSION = "4.0";

// Serialized versions with Date fields as strings
export type SerializedCyrusAgentSession = CyrusAgentSession;
// extends Omit<CyrusAgentSession, 'createdAt' | 'updatedAt'> {
//   createdAt: string
//   updatedAt: string
// }

export type SerializedCyrusAgentSessionEntry = CyrusAgentSessionEntry;
// extends Omit<CyrusAgentSessionEntry, 'metadata'> {
//   metadata?: Omit<CyrusAgentSessionEntry['metadata'], 'timestamp'> & {
//     timestamp?: string
//   }
// }

/**
 * v2.0 session format (for migration purposes)
 */
interface V2CyrusAgentSession {
	linearAgentActivitySessionId: string;
	type: string;
	status: string;
	context: string;
	createdAt: number;
	updatedAt: number;
	issueId: string;
	issue: IssueMinimal;
	workspace: {
		path: string;
		isGitWorktree: boolean;
		historyPath?: string;
	};
	claudeSessionId?: string;
	geminiSessionId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Serializable EdgeWorker state for persistence
 *
 * v4.0: Flat session format - sessions keyed directly by sessionId (no repo nesting)
 * v3.0: Nested format - sessions keyed by [repoId][sessionId]
 */
export interface SerializableEdgeWorkerState {
	// Agent Session state - flat map of sessionId → session (v4.0)
	agentSessions?: Record<string, SerializedCyrusAgentSession>;
	agentSessionEntries?: Record<string, SerializedCyrusAgentSessionEntry[]>;
	// Child to parent agent session mapping
	childToParentAgentSession?: Record<string, string>;
	// Issue to repository mapping (for caching user repository selections)
	// v4.1: string[] (multi-repo). Migration: old Record<string, string> auto-converts.
	issueRepositoryCache?: Record<string, string[]>;
}

/**
 * v3.0 nested state format (for migration purposes)
 */
export interface V3SerializableEdgeWorkerState {
	agentSessions?: Record<string, Record<string, SerializedCyrusAgentSession>>;
	agentSessionEntries?: Record<
		string,
		Record<string, SerializedCyrusAgentSessionEntry[]>
	>;
	childToParentAgentSession?: Record<string, string>;
	issueRepositoryCache?: Record<string, string>;
}

/**
 * Manages persistence of critical mappings to survive restarts
 */
export class PersistenceManager {
	private persistencePath: string;
	private logger: ILogger;
	private tmpFileCounter = 0;

	// Coalescing state for concurrent saveEdgeWorkerState calls. When a save
	// is in flight, additional callers replace the pending snapshot rather
	// than starting their own write; the chained save then runs once with
	// the latest snapshot. This makes "latest snapshot wins" deterministic
	// instead of "whichever write completes last wins" — which previously
	// allowed a stale pre-flip snapshot to persist when two saves raced.
	private inFlightSave: Promise<void> | null = null;
	private pendingSave: {
		state: SerializableEdgeWorkerState;
		promise: Promise<void>;
		resolve: () => void;
		reject: (err: unknown) => void;
	} | null = null;

	constructor(persistencePath?: string, logger?: ILogger) {
		this.persistencePath =
			persistencePath || join(homedir(), ".cyrus", "state");
		this.logger = logger ?? createLogger({ component: "PersistenceManager" });
	}

	/**
	 * Get the full path to the single EdgeWorker state file
	 */
	private getEdgeWorkerStateFilePath(): string {
		return join(this.persistencePath, "edge-worker-state.json");
	}

	/**
	 * Ensure the persistence directory exists
	 */
	private async ensurePersistenceDirectory(): Promise<void> {
		await mkdir(this.persistencePath, { recursive: true });
	}

	/**
	 * Save EdgeWorker state to disk (single file for all repositories).
	 *
	 * Concurrent calls are coalesced: if a save is already in flight, the
	 * incoming snapshot replaces any previously-queued snapshot and shares
	 * the same outcome promise. The chained save runs exactly once, with
	 * the most recent state. This prevents a stale snapshot from racing
	 * a fresher one to disk and "winning" by completing its write last —
	 * the failure mode that previously let a pre-flip Active snapshot
	 * persist over a Complete one when two saves raced.
	 */
	async saveEdgeWorkerState(state: SerializableEdgeWorkerState): Promise<void> {
		// Case 1: no save in flight — write immediately.
		if (!this.inFlightSave) {
			const writePromise = this.writeStateToDisk(state).finally(() => {
				this.inFlightSave = null;
				this.drainPendingSave();
			});
			this.inFlightSave = writePromise;
			return writePromise;
		}

		// Case 2: a save is in flight. Replace any pending snapshot with the
		// newer state; one chained save will run for whoever set pending last.
		if (this.pendingSave) {
			this.pendingSave.state = state;
			return this.pendingSave.promise;
		}

		let resolve!: () => void;
		let reject!: (err: unknown) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.pendingSave = { state, promise, resolve, reject };
		return promise;
	}

	/**
	 * Drain the pending save (if any) after the in-flight save resolves.
	 * Called from the in-flight save's finally().
	 */
	private drainPendingSave(): void {
		const pending = this.pendingSave;
		if (!pending) return;
		this.pendingSave = null;
		const writePromise = this.writeStateToDisk(pending.state).finally(() => {
			this.inFlightSave = null;
			this.drainPendingSave();
		});
		this.inFlightSave = writePromise;
		writePromise.then(pending.resolve, pending.reject);
	}

	/**
	 * Actually serialize and write the state file via a tmp file plus atomic
	 * rename. Internal — callers should go through saveEdgeWorkerState so
	 * concurrent calls are coalesced.
	 *
	 * Why not a plain `writeFile`: that opens the target path with `O_TRUNC`
	 * and writes synchronously. A process killed (SIGKILL, `process.exit`)
	 * between truncate and write completion, or a sibling concurrent
	 * `writeFile` to the same path, leaves an empty or partial file. We
	 * observed this live on a busy VM during a `systemctl restart`: the
	 * shutdown handler's save call raced with an in-flight onStateChange
	 * save, `process.exit(0)` killed the second writer mid-write, and the
	 * restarted process loaded an empty state — silently dropping every
	 * in-flight session and defeating auto-resume.
	 *
	 * POSIX `rename()` is atomic on the same filesystem: readers see either
	 * the old file or the fully-written new one, never a partial. The tmp
	 * file lives in the same directory as the target so the rename never
	 * crosses filesystems and falls back to non-atomic copy+unlink. The
	 * `.tmp.<pid>.<counter>` suffix scopes the tmp file to this process so
	 * multiple cyrus instances (defense-in-depth — they shouldn't coexist)
	 * target distinct tmp paths.
	 */
	private async writeStateToDisk(
		state: SerializableEdgeWorkerState,
	): Promise<void> {
		const stateFile = this.getEdgeWorkerStateFilePath();
		this.tmpFileCounter += 1;
		const tmpFile = `${stateFile}.tmp.${process.pid}.${this.tmpFileCounter}`;
		try {
			await this.ensurePersistenceDirectory();
			const stateData = {
				version: PERSISTENCE_VERSION,
				savedAt: new Date().toISOString(),
				state,
			};
			await writeFile(tmpFile, JSON.stringify(stateData, null, 2), "utf8");
			await rename(tmpFile, stateFile);
		} catch (error) {
			this.logger.error("Failed to save EdgeWorker state:", error);
			// Best-effort cleanup — if the tmp file was created but the rename
			// never ran, leaving it behind would accumulate `.tmp.<pid>` cruft
			// across crashes. Failure to unlink (e.g. tmp file never created)
			// is itself harmless and intentionally swallowed.
			try {
				await unlink(tmpFile);
			} catch {
				// nothing to clean up
			}
			throw error;
		}
	}

	/**
	 * Load EdgeWorker state from disk (single file for all repositories)
	 * Automatically migrates from v2.0 to v3.0 format if needed.
	 */
	async loadEdgeWorkerState(): Promise<SerializableEdgeWorkerState | null> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			// Best-effort cleanup of any `.tmp.<pid>` siblings left behind by a
			// previous SIGKILL between writeFile and rename. Harmless if the
			// directory does not exist or has no orphans.
			await this.cleanupStaleTmpFiles(stateFile);

			if (!existsSync(stateFile)) {
				return null;
			}

			const raw = await readFile(stateFile, "utf8");
			// Defend against a zero-byte file produced by a crash mid-write under
			// the pre-atomic implementation. A `JSON.parse("")` would throw and
			// land in the catch below as "Failed to load EdgeWorker state:
			// SyntaxError" — alarming and ambiguous. Treat empty as "nothing to
			// resume from" and stay silent.
			if (raw.trim().length === 0) {
				return null;
			}

			const stateData = JSON.parse(raw);

			// Validate state structure exists
			if (!stateData.state) {
				this.logger.warn("Invalid state file (missing state), ignoring");
				return null;
			}

			// Handle version migration
			if (stateData.version === "2.0") {
				this.logger.info("Migrating state from v2.0 to v3.0 to v4.0");
				const v3State = this.migrateV2ToV3(stateData.state);
				const migratedState = this.migrateV3ToV4(v3State);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version === "3.0") {
				this.logger.info("Migrating state from v3.0 to v4.0");
				const migratedState = this.migrateV3ToV4(
					stateData.state as V3SerializableEdgeWorkerState,
				);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version !== PERSISTENCE_VERSION) {
				this.logger.warn(
					`Unknown state file version ${stateData.version}, ignoring`,
				);
				return null;
			}

			return stateData.state;
		} catch (error) {
			this.logger.error("Failed to load EdgeWorker state:", error);
			return null;
		}
	}

	/**
	 * Migrate v2.0 state format to v3.0 format
	 *
	 * Changes:
	 * - linearAgentActivitySessionId -> id
	 * - Add externalSessionId (set to original linearAgentActivitySessionId for Linear sessions)
	 * - Add issueContext object with trackerId, issueId, issueIdentifier
	 * - issueId becomes optional (kept for backwards compatibility)
	 * - issue becomes optional
	 */
	private migrateV2ToV3(
		v2State: V3SerializableEdgeWorkerState,
	): V3SerializableEdgeWorkerState {
		const migratedState: V3SerializableEdgeWorkerState = {
			...v2State,
			agentSessions: {},
		};

		// Migrate agent sessions
		if (v2State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v2State.agentSessions,
			)) {
				migratedState.agentSessions![repoId] = {};
				for (const [_sessionId, v2Session] of Object.entries(repoSessions)) {
					const session = v2Session as unknown as V2CyrusAgentSession;
					const migratedSession = this.migrateSessionV2ToV3(session);
					// Use the new id as the key
					migratedState.agentSessions![repoId][migratedSession.id] =
						migratedSession;
				}
			}
		}

		// agentSessionEntries keys need to be updated to use new session IDs
		// Since linearAgentActivitySessionId becomes id, the keys remain the same
		// The entries themselves don't need modification

		return migratedState;
	}

	/**
	 * Migrate v3.0 state format to v4.0 format
	 *
	 * Changes:
	 * - Flatten nested {[repoId]: {[sessionId]: session}} to flat {[sessionId]: session}
	 * - Flatten nested entries similarly
	 */
	private migrateV3ToV4(
		v3State: V3SerializableEdgeWorkerState,
	): SerializableEdgeWorkerState {
		const flatSessions: Record<string, SerializedCyrusAgentSession> = {};
		const flatEntries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Flatten sessions: merge all repo-keyed sessions into a single flat map
		// Preserve the repoId key as a RepositoryContext so migrated sessions
		// know which repository they belong to (instead of defaulting to [])
		if (v3State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v3State.agentSessions,
			)) {
				for (const [sessionId, session] of Object.entries(repoSessions)) {
					if (!session.repositories?.length) {
						session.repositories = [
							{
								repositoryId: repoId,
							},
						];
					}
					flatSessions[sessionId] = session;
				}
			}
		}

		// Flatten entries similarly
		if (v3State.agentSessionEntries) {
			for (const repoEntries of Object.values(v3State.agentSessionEntries)) {
				for (const [sessionId, entries] of Object.entries(repoEntries)) {
					flatEntries[sessionId] = entries;
				}
			}
		}

		// Migrate issueRepositoryCache from old Record<string, string> to Record<string, string[]>
		let migratedCache: Record<string, string[]> | undefined;
		if (v3State.issueRepositoryCache) {
			migratedCache = {};
			for (const [issueId, repoId] of Object.entries(
				v3State.issueRepositoryCache,
			)) {
				migratedCache[issueId] = [repoId];
			}
		}

		return {
			agentSessions: flatSessions,
			agentSessionEntries: flatEntries,
			childToParentAgentSession: v3State.childToParentAgentSession,
			issueRepositoryCache: migratedCache,
		};
	}

	/**
	 * Migrate a single session from v2.0 to v3.0 format
	 */
	private migrateSessionV2ToV3(
		v2Session: V2CyrusAgentSession,
	): SerializedCyrusAgentSession {
		// Build issueContext from v2.0 fields
		const issueContext: IssueContext = {
			trackerId: "linear", // v2.0 only supported Linear
			issueId: v2Session.issueId,
			issueIdentifier: v2Session.issue?.identifier || v2Session.issueId,
		};

		return {
			// New field: rename linearAgentActivitySessionId to id
			id: v2Session.linearAgentActivitySessionId,
			// New field: store the original Linear session ID as externalSessionId
			externalSessionId: v2Session.linearAgentActivitySessionId,
			// Preserved fields
			type: v2Session.type,
			status: v2Session.status,
			context: v2Session.context,
			createdAt: v2Session.createdAt,
			updatedAt: v2Session.updatedAt,
			workspace: v2Session.workspace,
			claudeSessionId: v2Session.claudeSessionId,
			geminiSessionId: v2Session.geminiSessionId,
			metadata: v2Session.metadata,
			// New field: structured issue context
			issueContext,
			// Kept for backwards compatibility (marked as deprecated in interface)
			issueId: v2Session.issueId,
			// Now optional
			issue: v2Session.issue,
			// New field: empty repositories for migrated sessions
			repositories: [],
		} as SerializedCyrusAgentSession;
	}

	/**
	 * Remove any leftover `.tmp.<pid>` siblings of the state file. These can
	 * accumulate when a process is killed between `writeFile(tmpFile, ...)`
	 * and `rename(tmpFile, stateFile)` in `saveEdgeWorkerState`. Best-effort:
	 * any error is swallowed because failure to clean cruft must not block
	 * loading.
	 */
	private async cleanupStaleTmpFiles(stateFile: string): Promise<void> {
		try {
			const dir = dirname(stateFile);
			const baseName = basename(stateFile);
			const tmpPrefix = `${baseName}.tmp.`;
			const entries = await readdir(dir);
			await Promise.all(
				entries
					.filter((name) => name.startsWith(tmpPrefix))
					.map(async (name) => {
						try {
							await unlink(join(dir, name));
						} catch {
							// ignore — best-effort cleanup
						}
					}),
			);
		} catch {
			// directory missing, permission error, etc. — best-effort cleanup
		}
	}

	/**
	 * Check if EdgeWorker state file exists
	 */
	hasStateFile(): boolean {
		return existsSync(this.getEdgeWorkerStateFilePath());
	}

	/**
	 * Delete EdgeWorker state file
	 */
	async deleteStateFile(): Promise<void> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			if (existsSync(stateFile)) {
				await writeFile(stateFile, "", "utf8"); // Clear file instead of deleting
			}
		} catch (error) {
			this.logger.error("Failed to delete EdgeWorker state file:", error);
		}
	}

	/**
	 * Convert Map to Record for serialization
	 */
	static mapToRecord<T>(map: Map<string, T>): Record<string, T> {
		return Object.fromEntries(map.entries());
	}

	/**
	 * Convert Record to Map for deserialization
	 */
	static recordToMap<T>(record: Record<string, T>): Map<string, T> {
		return new Map(Object.entries(record));
	}

	/**
	 * Convert Set to Array for serialization
	 */
	static setToArray<T>(set: Set<T>): T[] {
		return Array.from(set);
	}

	/**
	 * Convert Array to Set for deserialization
	 */
	static arrayToSet<T>(array: T[]): Set<T> {
		return new Set(array);
	}
}
