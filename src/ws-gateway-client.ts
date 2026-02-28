/**
 * WebSocket client for the OpenClaw Gateway.
 *
 * Implements the gateway's native WebSocket protocol for real-time
 * bidirectional streaming. This avoids CORS issues inherent to
 * fetch()-based SSE streaming in Obsidian's Electron environment.
 *
 * Protocol overview:
 *   1. Client connects to ws://host:port (or wss://)
 *   2. Gateway sends  { event: "connect.challenge", payload: { nonce } }
 *   3. Client responds with a "connect" RPC call (auth + device identity)
 *   4. Gateway replies with hello-ok (or PAIRING_REQUIRED error)
 *   5. Gateway sends periodic "tick" events as keep-alive
 *   6. Client sends RPC requests; gateway sends responses + events
 */

import type { DeviceIdentityData, DeviceAuthToken } from "./device-identity"
import { buildDeviceAuthPayload, signPayload } from "./device-identity"

/** Connection state */
export type WsConnectionState =
	| "disconnected"
	| "connecting"
	| "authenticating"
	| "connected"
	| "reconnecting"
	| "pairing_required";

/** Gateway event frame */
export interface GatewayEvent {
	event: string;
	payload?: unknown;
	seq?: number;
}

/** Gateway request frame */
export interface GatewayRequest {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
}

/** Gateway response frame */
export interface GatewayResponse {
	type: "res";
	id: string;
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: { code?: string; message: string; details?: unknown };
}

/** Chat event payload from the gateway */
export interface ChatEventPayload {
	runId: string;
	sessionKey: string;
	seq: number;
	state: "delta" | "final" | "aborted" | "error";
	message?: {
		role: string;
		content: Array<{ type: string; text?: string }>;
		timestamp: number;
	};
	errorMessage?: string;
}

/** Options for constructing the WS client */
export interface WsGatewayClientOptions {
	/** Base URL (HTTP or WS) of the gateway */
	getUrl: () => string;
	/** Gateway auth token (operator token) */
	getToken: () => string;
	/** Agent ID for session key generation */
	getAgentId: () => string;
	/** Device identity for device auth (keypair + id) */
	getDeviceIdentity: () => DeviceIdentityData | null;
	/** Stored device auth token (from prior successful pairing) */
	getDeviceAuthToken: () => DeviceAuthToken | null;
	/** Called when connection state changes */
	onStateChange?: (state: WsConnectionState) => void;
	/** Called when a chat event arrives */
	onChatEvent?: (event: ChatEventPayload) => void;
	/** Called when the gateway issues a new device token after successful connect */
	onDeviceTokenReceived?: (token: DeviceAuthToken) => void;
	/** Called when pairing is required — device has been added to pending */
	onPairingRequired?: () => void;
	/** Called when connect error occurs (non-pairing) */
	onConnectError?: (err: Error) => void;
}

/** Pending RPC request */
interface PendingRequest {
	resolve: (payload: Record<string, unknown> | undefined) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** Current gateway protocol version */
const PROTOCOL_VERSION = 3

/** Client identification */
const CLIENT_ID = "webchat-ui"
const CLIENT_MODE = "webchat"

/**
 * WebSocket client for the OpenClaw gateway with device auth support.
 *
 * Implements the full device pairing protocol:
 *   - Signs connect challenge nonces with Ed25519 device key
 *   - Handles PAIRING_REQUIRED errors gracefully
 *   - Stores device auth tokens issued by gateway
 */
export class WsGatewayClient {
	private ws: WebSocket | null = null
	private pending = new Map<string, PendingRequest>()
	private state: WsConnectionState = "disconnected"
	private connectNonce: string | null = null
	private connectSent = false
	private connectTimer: ReturnType<typeof setTimeout> | null = null
	private tickTimer: ReturnType<typeof setInterval> | null = null
	private lastTick: number | null = null
	private tickIntervalMs = 30_000
	private backoffMs = 1_000
	private closed = false
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private opts: WsGatewayClientOptions

	constructor(opts: WsGatewayClientOptions) {
		this.opts = opts
	}

	/** Current connection state */
	get connectionState(): WsConnectionState {
		return this.state
	}

	/** Whether the client is connected and authenticated */
	get isConnected(): boolean {
		return this.state === "connected"
	}

	/** Start the WebSocket connection */
	start(): void {
		if (this.closed) return
		this.connect()
	}

	/** Stop the WebSocket connection and clean up */
	stop(): void {
		this.closed = true
		this.clearTimers()
		if (this.ws) {
			this.ws.close(1000, "client stopped")
			this.ws = null
		}
		this.flushPending(new Error("client stopped"))
		this.setState("disconnected")
	}

	/** Restart the connection (stop + start) */
	restart(): void {
		this.closed = false
		if (this.ws) {
			this.ws.close(1000, "client restarting")
			this.ws = null
		}
		this.clearTimers()
		this.flushPending(new Error("client restarting"))
		this.connect()
	}

	/**
	 * Send an RPC request to the gateway.
	 * Returns a promise that resolves with the response payload.
	 */
	async request(
		method: string,
		params: unknown,
		timeoutMs = 30_000,
	): Promise<Record<string, unknown> | undefined> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected")
		}

		const id = crypto.randomUUID()
		const frame: GatewayRequest = { type: "req", id, method, params }

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`))
			}, timeoutMs)

			this.pending.set(id, { resolve, reject, timer })
			this.ws!.send(JSON.stringify(frame))
		})
	}

	/**
	 * Send a chat message and receive streaming deltas via the onChatEvent callback.
	 *
	 * @returns The runId assigned to this chat send
	 */
	async chatSend(
		sessionKey: string,
		message: string,
		options?: {
			thinking?: string;
			timeoutMs?: number;
			attachments?: unknown[];
		},
	): Promise<string> {
		const idempotencyKey = crypto.randomUUID()

		const params: Record<string, unknown> = {
			sessionKey,
			message,
			idempotencyKey,
		}
		if (options?.thinking) params.thinking = options.thinking
		if (options?.timeoutMs) params.timeoutMs = options.timeoutMs
		if (options?.attachments) params.attachments = options.attachments

		const response = await this.request("chat.send", params, 60_000)
		const runId = (response?.runId as string) ?? idempotencyKey
		return runId
	}

	/**
	 * Abort an in-flight chat run.
	 */
	async chatAbort(sessionKey: string, runId?: string): Promise<void> {
		const params: Record<string, unknown> = { sessionKey }
		if (runId) params.runId = runId
		await this.request("chat.abort", params, 10_000)
	}

	/**
	 * Fetch chat history for a session.
	 */
	async chatHistory(
		sessionKey: string,
		limit = 200,
	): Promise<Record<string, unknown> | undefined> {
		return await this.request(
			"chat.history",
			{ sessionKey, limit },
			15_000,
		)
	}

	/**
	 * Remove a paired device from the gateway.
	 */
	async removeDevice(deviceId: string): Promise<boolean> {
		try {
			await this.request("devices.remove", { deviceId }, 10_000)
			return true
		} catch (err) {
			console.error("[OpenClaw WS] Failed to remove device:", err)
			return false
		}
	}

	// ── Private ──────────────────────────────────────────────────

	private setState(state: WsConnectionState): void {
		if (this.state === state) return
		this.state = state
		this.opts.onStateChange?.(state)
	}

	private resolveWsUrl(): string {
		const raw = this.opts.getUrl().replace(/\/+$/, "")
		// Convert http(s) to ws(s) if needed
		if (raw.startsWith("http://"))
			return raw.replace("http://", "ws://")
		if (raw.startsWith("https://"))
			return raw.replace("https://", "wss://")
		if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw
		// Assume ws:// for plain host:port
		return `ws://${raw}`
	}

	private connect(): void {
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}
		this.connectNonce = null
		this.connectSent = false

		const url = this.resolveWsUrl()
		this.setState("connecting")

		try {
			this.ws = new WebSocket(url)
		} catch {
			this.setState("disconnected")
			this.scheduleReconnect()
			return
		}

		this.ws.onopen = () => {
			this.setState("authenticating")
			this.queueConnectTimeout()
		}

		this.ws.onmessage = (event) => {
			this.handleMessage(
				typeof event.data === "string"
					? event.data
					: String(event.data),
			)
		}

		this.ws.onclose = (_event) => {
			this.ws = null
			this.flushPending(new Error("WebSocket closed"))
			if (!this.closed) {
				this.setState("reconnecting")
				this.scheduleReconnect()
			} else {
				this.setState("disconnected")
			}
		}

		this.ws.onerror = () => {
			// onclose will fire after onerror
		}
	}

	private handleMessage(raw: string): void {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			return
		}

		const obj = parsed as Record<string, unknown>

		// Event frame
		if (typeof obj.event === "string") {
			this.handleEvent(obj as unknown as GatewayEvent)
			return
		}

		// Response frame
		if (typeof obj.id === "string" && typeof obj.ok === "boolean") {
			this.handleResponse(obj as unknown as GatewayResponse)
			return
		}
	}

	private handleEvent(evt: GatewayEvent): void {
		// Connect challenge
		if (evt.event === "connect.challenge") {
			const payload = evt.payload as
				| Record<string, unknown>
				| undefined
			const nonce =
				typeof payload?.nonce === "string" ? payload.nonce : null
			if (!nonce) {
				this.ws?.close(3008, "missing nonce in connect challenge")
				return
			}
			this.connectNonce = nonce.trim()
			void this.sendConnect()
			return
		}

		// Tick (keep-alive)
		if (evt.event === "tick") {
			this.lastTick = Date.now()
			return
		}

		// Chat events
		if (evt.event === "chat") {
			const payload = evt.payload as ChatEventPayload | undefined
			if (payload) {
				this.opts.onChatEvent?.(payload)
			}
			return
		}
	}

	private handleResponse(res: GatewayResponse): void {
		const pending = this.pending.get(res.id)
		if (!pending) {
			return
		}

		this.pending.delete(res.id)
		if (pending.timer) clearTimeout(pending.timer)

		if (res.ok) {
			pending.resolve(res.payload)
		} else {
			const err = new Error(
				res.error?.message ?? "unknown gateway error",
			);
			// Attach the error code for upstream handling
			(err as Error & { code?: string }).code = res.error?.code
			pending.reject(err)
		}
	}

	/**
	 * Send the connect RPC with device auth.
	 *
	 * If a device identity is available, signs the challenge nonce
	 * and includes the device field in the connect params. The gateway
	 * uses this to verify the device and issue device tokens.
	 */
	private async sendConnect(): Promise<void> {
		if (this.connectSent) return
		if (!this.connectNonce) return

		this.connectSent = true
		if (this.connectTimer) {
			clearTimeout(this.connectTimer)
			this.connectTimer = null
		}

		const nonce = this.connectNonce
		const token = this.opts.getToken()
		const deviceIdentity = this.opts.getDeviceIdentity()
		const storedDeviceToken = this.opts.getDeviceAuthToken()

		// Resolve the auth token: prefer stored device token over gateway token
		const resolvedToken =
			(!token && storedDeviceToken?.token) || token || undefined

		const role = "operator"
		const scopes = ["operator.read", "operator.write"]

		// Build device field if identity is available
		let device: Record<string, unknown> | undefined
		if (deviceIdentity) {
			const signedAtMs = Date.now()
			const payload = buildDeviceAuthPayload({
				deviceId: deviceIdentity.deviceId,
				clientId: CLIENT_ID,
				clientMode: CLIENT_MODE,
				role,
				scopes,
				signedAtMs,
				token: resolvedToken ?? null,
				nonce,
			})

			try {
				const signature = await signPayload(
					deviceIdentity.privateKey,
					payload,
				)

				device = {
					id: deviceIdentity.deviceId,
					publicKey: deviceIdentity.publicKey,
					signature,
					signedAt: signedAtMs,
					nonce,
				}

			} catch (err) {
				console.error("[OpenClaw WS] Failed to sign device auth:", err)
				// Continue without device auth — fall back to token only
			}
		}

		const auth =
			resolvedToken || undefined
				? {
						token: resolvedToken,
						deviceToken: storedDeviceToken?.token ?? undefined,
					}
				: undefined

		const params: Record<string, unknown> = {
			minProtocol: PROTOCOL_VERSION,
			maxProtocol: PROTOCOL_VERSION,
			client: {
				id: CLIENT_ID,
				displayName: "Obsidian OpenClaw Plugin",
				version: "1.0.0",
				platform: "electron",
				mode: CLIENT_MODE,
			},
			caps: [],
			role,
			scopes,
			auth,
			device,
		}

		try {
			const helloOk = await this.request("connect", params, 15_000)
			this.backoffMs = 1_000

			// Handle device token issued by gateway
			const authInfo = helloOk?.auth as
				| Record<string, unknown>
				| undefined
			if (authInfo?.deviceToken && deviceIdentity) {
				const newToken: DeviceAuthToken = {
					token: authInfo.deviceToken as string,
					role: (authInfo.role as string) ?? role,
					scopes: (authInfo.scopes as string[]) ?? scopes,
					updatedAtMs: Date.now(),
				}
				this.opts.onDeviceTokenReceived?.(newToken)
			}

			// Extract tick interval from policy
			const policy = helloOk?.policy as
				| Record<string, unknown>
				| undefined
			if (
				typeof policy?.tickIntervalMs === "number" &&
				policy.tickIntervalMs > 0
			) {
				this.tickIntervalMs = policy.tickIntervalMs
			}

			this.lastTick = Date.now()
			this.startTickWatch()
			this.setState("connected")
		} catch (err) {
			const errWithCode = err as Error & { code?: string }
			const code = errWithCode.code ?? ""

			// Check if pairing is required
			if (
				code === "PAIRING_REQUIRED" ||
				code === "DEVICE_IDENTITY_REQUIRED" ||
				errWithCode.message
					?.toLowerCase()
					.includes("pairing required")
			) {
				this.setState("pairing_required")
				this.opts.onPairingRequired?.()
				// Don't close the socket immediately — schedule a retry
				// to check if pairing has been approved
				this.ws?.close(1000, "pairing required")
				return
			}

			this.opts.onConnectError?.(
				err instanceof Error ? err : new Error(String(err)),
			)
			this.ws?.close(3008, "connect failed")
		}
	}

	private queueConnectTimeout(): void {
		if (this.connectTimer) clearTimeout(this.connectTimer)
		this.connectTimer = setTimeout(() => {
			if (
				!this.connectSent &&
				this.ws?.readyState === WebSocket.OPEN
			) {
				this.ws?.close(3008, "connect challenge timeout")
			}
		}, 5_000)
	}

	private scheduleReconnect(): void {
		if (this.closed) return
		this.clearTimers()

		const delay = this.backoffMs
		this.backoffMs = Math.min(this.backoffMs * 2, 30_000)

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (!this.closed) this.connect()
		}, delay)
	}

	private startTickWatch(): void {
		if (this.tickTimer) clearInterval(this.tickTimer)
		this.tickTimer = setInterval(() => {
			if (this.closed) return
			if (!this.lastTick) return
			if (Date.now() - this.lastTick > this.tickIntervalMs * 2.5) {
				// Tick timeout — gateway may be unresponsive
				this.ws?.close(4000, "tick timeout")
			}
		}, Math.max(this.tickIntervalMs, 1_000))
	}

	private clearTimers(): void {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer)
			this.connectTimer = null
		}
		if (this.tickTimer) {
			clearInterval(this.tickTimer)
			this.tickTimer = null
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	private flushPending(err: Error): void {
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer)
			p.reject(err)
		}
		this.pending.clear()
	}
}
