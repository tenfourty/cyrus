/**
 * Bounded-concurrency primitive used by the auto-resume orchestrator to cap
 * how many `resumeAgentSession` calls run in parallel at startup. Avoids
 * adding a runtime dependency for what is effectively a small queue.
 */
export class Semaphore {
	private active = 0;
	private waiters: Array<() => void> = [];

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(
				`Semaphore capacity must be a positive integer, got ${capacity}`,
			);
		}
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.active < this.capacity) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(() => {
				this.active++;
				resolve();
			});
		});
	}

	private release(): void {
		this.active--;
		const next = this.waiters.shift();
		if (next) next();
	}
}
