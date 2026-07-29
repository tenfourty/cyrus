import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LinearEventTransport } from "../src/LinearEventTransport.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeReply() {
	const reply: any = {
		code: vi.fn().mockReturnThis(),
		header: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
		status: vi.fn().mockReturnThis(),
	};
	return reply;
}

function makeTransport(opts?: { verificationMode?: "proxy" | "direct"; secret?: string }) {
	const post = vi.fn();
	const fastifyServer = { post } as unknown as FastifyInstance;
	const transport = new LinearEventTransport({
		fastifyServer,
		verificationMode: opts?.verificationMode ?? "proxy",
		secret: opts?.secret ?? "test-secret",
	});
	transport.register();
	return { transport, post };
}

/** Find the handler registered for /linear-webhook */
function getLinearWebhookHandler(post: ReturnType<typeof vi.fn>) {
	const calls = post.mock.calls as Array<[string, (req: any, reply: any) => Promise<void>]>;
	const found = calls.find(([path]) => path === "/linear-webhook");
	if (!found) throw new Error("Handler for /linear-webhook not registered");
	return found[1];
}

function makeProxyRequest(body: object = {}) {
	return {
		headers: { authorization: "Bearer test-secret" },
		body,
	};
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("LinearEventTransport — drain gate", () => {
	it("responds 200 and emits event when drainGate is not set", async () => {
		const { transport, post } = makeTransport();
		const handler = getLinearWebhookHandler(post);

		const emitted: unknown[] = [];
		transport.on("event", (ev) => emitted.push(ev));

		const reply = makeReply();
		await handler(makeProxyRequest({ type: "Issue", action: "create" }), reply);

		expect(reply.code).toHaveBeenCalledWith(200);
		expect(emitted).toHaveLength(1);
	});

	it("responds 503 + Retry-After when drainGate returns true", async () => {
		const { transport, post } = makeTransport();
		transport.setDrainGate(() => true);
		const handler = getLinearWebhookHandler(post);

		const emitted: unknown[] = [];
		transport.on("event", (ev) => emitted.push(ev));

		const reply = makeReply();
		await handler(makeProxyRequest({ type: "Issue", action: "create" }), reply);

		expect(reply.code).toHaveBeenCalledWith(503);
		expect(reply.header).toHaveBeenCalledWith("Retry-After", "30");
		expect(emitted).toHaveLength(0);
	});

	it("responds 200 and emits event when drainGate returns false", async () => {
		const { transport, post } = makeTransport();
		transport.setDrainGate(() => false);
		const handler = getLinearWebhookHandler(post);

		const emitted: unknown[] = [];
		transport.on("event", (ev) => emitted.push(ev));

		const reply = makeReply();
		await handler(makeProxyRequest({ type: "Issue", action: "create" }), reply);

		expect(reply.code).toHaveBeenCalledWith(200);
		expect(emitted).toHaveLength(1);
	});

	it("passes the raw payload to the drainGate predicate", async () => {
		const { transport, post } = makeTransport();
		const payloads: unknown[] = [];
		transport.setDrainGate((raw) => {
			payloads.push(raw);
			return false;
		});
		const handler = getLinearWebhookHandler(post);

		const body = { type: "AgentSession", action: "prompted" };
		await handler(makeProxyRequest(body), makeReply());

		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toMatchObject(body);
	});

	it("removing the gate (setDrainGate(null)) restores 200 flow", async () => {
		const { transport, post } = makeTransport();
		transport.setDrainGate(() => true);
		transport.setDrainGate(null);
		const handler = getLinearWebhookHandler(post);

		const emitted: unknown[] = [];
		transport.on("event", (ev) => emitted.push(ev));

		const reply = makeReply();
		await handler(makeProxyRequest({ type: "Issue" }), reply);

		expect(reply.code).toHaveBeenCalledWith(200);
		expect(emitted).toHaveLength(1);
	});

	it("stop-signal payload bypass pattern: drainGate can allow stop signals through", async () => {
		const { transport, post } = makeTransport();
		// Simulate EdgeWorker's drain gate predicate that allows stop signals
		transport.setDrainGate((raw: unknown) => {
			if (!raw || typeof raw !== "object") return true;
			const p = raw as Record<string, unknown>;
			const activity = p.agentActivity as Record<string, unknown> | undefined;
			if (activity?.signal === "stop") return false; // allow stop through
			return true; // block everything else
		});
		const handler = getLinearWebhookHandler(post);

		const emittedStop: unknown[] = [];
		const emittedOther: unknown[] = [];
		transport.on("event", (ev: unknown) => {
			const p = ev as Record<string, unknown>;
			const act = p.agentActivity as Record<string, unknown> | undefined;
			if (act?.signal === "stop") emittedStop.push(ev);
			else emittedOther.push(ev);
		});

		// Non-stop webhook — should be 503
		const normalReply = makeReply();
		await handler(makeProxyRequest({ type: "AgentSession", agentActivity: { signal: null } }), normalReply);
		expect(normalReply.code).toHaveBeenCalledWith(503);

		// Stop webhook — should be 200 and emitted
		const stopReply = makeReply();
		await handler(makeProxyRequest({ type: "AgentSession", agentActivity: { signal: "stop" } }), stopReply);
		expect(stopReply.code).toHaveBeenCalledWith(200);
		expect(emittedStop).toHaveLength(1);
		expect(emittedOther).toHaveLength(0);
	});
});
