import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/auto-resume/Semaphore.js";

describe("Semaphore", () => {
	it("runs tasks immediately when below capacity", async () => {
		const sem = new Semaphore(2);
		const order: string[] = [];

		const a = sem.run(async () => {
			order.push("a-start");
			await new Promise((r) => setTimeout(r, 10));
			order.push("a-end");
			return "a";
		});

		const b = sem.run(async () => {
			order.push("b-start");
			await new Promise((r) => setTimeout(r, 10));
			order.push("b-end");
			return "b";
		});

		await Promise.all([a, b]);

		// Both should start before either ends
		expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
		expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
	});

	it("caps concurrency at the configured limit", async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;

		const tasks = Array.from({ length: 6 }, () =>
			sem.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			}),
		);

		await Promise.all(tasks);

		expect(peak).toBe(2);
		expect(active).toBe(0);
	});

	it("returns the task's resolved value", async () => {
		const sem = new Semaphore(1);
		const result = await sem.run(async () => 42);
		expect(result).toBe(42);
	});

	it("propagates task errors and continues with the queue", async () => {
		const sem = new Semaphore(1);

		const failing = sem.run(async () => {
			throw new Error("boom");
		});

		const after = sem.run(async () => "ok");

		await expect(failing).rejects.toThrow("boom");
		await expect(after).resolves.toBe("ok");
	});
});
