import { EventEmitter } from "node:events";
import {
	LinearWebhookClient,
	type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { IAgentEventTransport, TranslationContext } from "cyrus-core";
import { createLogger, type ILogger, ipMatchesAllowlist } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { LinearMessageTranslator } from "./LinearMessageTranslator.js";
import type {
	LinearEventTransportConfig,
	LinearEventTransportEvents,
} from "./types.js";

export declare interface LinearEventTransport {
	on<K extends keyof LinearEventTransportEvents>(
		event: K,
		listener: LinearEventTransportEvents[K],
	): this;
	emit<K extends keyof LinearEventTransportEvents>(
		event: K,
		...args: Parameters<LinearEventTransportEvents[K]>
	): boolean;
}

/**
 * LinearEventTransport - Handles Linear webhook event delivery
 *
 * This class implements IAgentEventTransport to provide a platform-agnostic
 * interface for handling Linear webhooks with Linear-specific verification.
 *
 * It registers a POST /linear-webhook endpoint with a Fastify server, plus
 * a POST /webhook alias retained for backward compatibility (deprecated).
 * Incoming webhooks are verified using either:
 * 1. "direct" mode: Verifies Linear's webhook signature
 * 2. "proxy" mode: Verifies Bearer token authentication
 *
 * The class emits "event" events with AgentEvent (LinearWebhookPayload) data.
 */
export class LinearEventTransport
	extends EventEmitter
	implements IAgentEventTransport
{
	private config: LinearEventTransportConfig;
	private linearWebhookClient: LinearWebhookClient | null = null;
	private logger: ILogger;
	private messageTranslator: LinearMessageTranslator;
	private translationContext: TranslationContext;
	/** Optional predicate: returns true when the webhook should be rejected with 503. */
	private drainGate: ((raw: unknown) => boolean) | null = null;

	constructor(
		config: LinearEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "LinearEventTransport" });
		this.messageTranslator = new LinearMessageTranslator();
		this.translationContext = translationContext ?? {};

		// Initialize Linear webhook client for direct mode
		if (config.verificationMode === "direct") {
			this.linearWebhookClient = new LinearWebhookClient(config.secret);
		}
	}

	/**
	 * Set the translation context for message translation.
	 * This allows setting Linear API tokens and other context after construction.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Set a drain gate predicate.  When set, the handler calls this function
	 * with the raw (unparsed) webhook body **before** emitting any event.  If the
	 * predicate returns `true` the request is rejected with HTTP 503 + a
	 * `Retry-After: 30` header so Linear will redeliver after restart.
	 *
	 * The predicate receives the raw body so the caller (EdgeWorker) can inspect
	 * the payload and allow stop-signal webhooks through even during drain.
	 *
	 * Pass `null` to remove the gate.
	 */
	setDrainGate(predicate: ((raw: unknown) => boolean) | null): void {
		this.drainGate = predicate;
	}

	/**
	 * Register the /linear-webhook endpoint (plus the deprecated /webhook alias)
	 * with the Fastify server.
	 */
	register(): void {
		const handler = async (
			request: FastifyRequest,
			reply: FastifyReply,
		): Promise<void> => {
			try {
				// Verify based on mode
				if (this.config.verificationMode === "direct") {
					await this.handleDirectWebhook(request, reply);
				} else {
					await this.handleProxyWebhook(request, reply);
				}
			} catch (error) {
				const err = new Error("Webhook error");
				if (error instanceof Error) {
					err.cause = error;
				}
				this.logger.error("Webhook error", err);
				this.emit("error", err);
				reply.code(500).send({ error: "Internal server error" });
			}
		};

		this.config.fastifyServer.post("/linear-webhook", handler);

		// Deprecated alias — retained so existing Linear webhook configurations
		// continue to deliver while users migrate to /linear-webhook.
		let deprecationWarned = false;
		this.config.fastifyServer.post(
			"/webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!deprecationWarned) {
					deprecationWarned = true;
					this.logger.warn(
						"POST /webhook is deprecated; update your Linear webhook URL to use /linear-webhook",
					);
				}
				await handler(request, reply);
			},
		);

		this.logger.info(
			`Registered POST /linear-webhook endpoint (${this.config.verificationMode} mode); POST /webhook retained as deprecated alias`,
		);
	}

	/**
	 * Check the drain gate and reply with 503 if the webhook should be rejected.
	 * Returns `true` when the caller should abort processing.
	 */
	private checkDrainGate(body: unknown, reply: FastifyReply): boolean {
		if (this.drainGate?.(body)) {
			this.logger.info("[LinearEventTransport] Rejecting webhook during drain");
			reply.code(503).header("Retry-After", "30").send({ error: "draining" });
			return true;
		}
		return false;
	}

	/**
	 * Handle webhook in direct mode using Linear's signature verification
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.linearWebhookClient) {
			reply.code(500).send({ error: "Linear webhook client not initialized" });
			return;
		}

		// Validate source IP against Linear's known webhook IPs
		if (
			this.config.ipAllowlist &&
			this.config.ipAllowlist.length > 0 &&
			!ipMatchesAllowlist(request.ip, this.config.ipAllowlist)
		) {
			this.logger.warn(
				`Rejected Linear webhook from unauthorized IP: ${request.ip}`,
			);
			reply.code(403).send({ error: "Forbidden: unauthorized source IP" });
			return;
		}

		// Get Linear signature from headers
		const signature = request.headers["linear-signature"] as string;
		if (!signature) {
			reply.code(401).send({ error: "Missing linear-signature header" });
			return;
		}

		try {
			// Use the raw body bytes that SharedApplicationServer stashed on the request
			// so signature verification uses the exact payload Linear signed, rather than
			// a re-serialized version that may differ in key order or whitespace.
			const rawBody = (request as FastifyRequest & { rawBody: string }).rawBody;
			const bodyBuffer = rawBody
				? Buffer.from(rawBody)
				: Buffer.from(JSON.stringify(request.body));
			const isValid = this.linearWebhookClient.verify(bodyBuffer, signature);

			if (!isValid) {
				reply.code(401).send({ error: "Invalid webhook signature" });
				return;
			}

			const payload = request.body as LinearWebhookPayload;

			// Check drain gate AFTER signature verification (so we don't 503 bad actors)
			if (this.checkDrainGate(payload, reply)) return;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Direct webhook verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Direct webhook verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Handle webhook in proxy mode using Bearer token authentication
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		// Get Authorization header
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		// Verify Bearer token
		const expectedAuth = `Bearer ${this.config.secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			const payload = request.body as LinearWebhookPayload;

			// Check drain gate AFTER auth so we don't 503 unauthenticated callers
			if (this.checkDrainGate(payload, reply)) return;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Proxy webhook processing failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Proxy webhook processing failed", err);
			reply.code(500).send({ error: "Failed to process webhook" });
		}
	}

	/**
	 * Translate and emit an internal message from a webhook payload.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(payload: LinearWebhookPayload): void {
		const result = this.messageTranslator.translate(
			payload,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}
}
