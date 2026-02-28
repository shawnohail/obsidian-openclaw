import { requestUrl } from "obsidian"
import type {
	OpenClawSettings,
	ChatCompletionResponse,
	StreamingMode,
} from "./types"
import type { DeviceAuthToken } from "./device-identity"
import {
	WsGatewayClient,
	type WsConnectionState,
	type ChatEventPayload,
} from "./ws-gateway-client"

/**
 * OpenClaw Gateway client.
 *
 * Supports three transport modes for chat:
 *   1. **WebSocket** (recommended) — persistent WS connection using the
 *      gateway's native JSON-RPC protocol. No CORS issues.
 *   2. **HTTP SSE** — fetch()-based Server-Sent Events against the
 *      OpenAI-compatible /v1/chat/completions endpoint.
 *   3. **Off** — single request/response via Obsidian's requestUrl().
 */
export class GatewayClient {
	private wsClient: WsGatewayClient | null = null
	private chatEventListeners = new Map<
		string,
		{
			onChunk: (text: string) => void;
			onDone: () => void;
			onError: (err: Error) => void;
		}
	>()
	private connectionStateListeners: Array<
		(state: WsConnectionState) => void
	> = []
	private pairingRequiredListeners: Array<() => void> = []

	/** Callback to persist settings changes (device token, pairing status) */
	onSettingsChanged: (() => Promise<void>) | null = null

	constructor(private getSettings: () => OpenClawSettings) {}

	private get baseUrl(): string {
		return this.getSettings().gatewayUrl.replace(/\/+$/, "")
	}

	private get token(): string {
		return this.getSettings().gatewayToken
	}

	private get agentId(): string {
		return this.getSettings().agentId || "main"
	}

	private get streamingMode(): StreamingMode {
		return this.getSettings().streamingMode ?? "websocket"
	}

	// ── WebSocket lifecycle ──────────────────────────────────────

	/**
	 * Initialize and connect the WebSocket client.
	 * Safe to call multiple times — will restart if settings changed.
	 */
	connectWebSocket(): void {
		if (this.wsClient) {
			this.wsClient.restart()
			return
		}

		this.wsClient = new WsGatewayClient({
			getUrl: () => this.baseUrl,
			getToken: () => this.token,
			getAgentId: () => this.agentId,
			getDeviceIdentity: () => this.getSettings().deviceIdentity,
			getDeviceAuthToken: () => this.getSettings().deviceAuthToken,
			onStateChange: (state) => {
				for (const listener of this.connectionStateListeners) {
					listener(state)
				}
			},
			onChatEvent: (event) => this.handleChatEvent(event),
			onDeviceTokenReceived: (token) => {
				this.handleDeviceTokenReceived(token)
			},
			onPairingRequired: () => {
				const settings = this.getSettings()
				settings.devicePairingStatus = "pending"
				void this.onSettingsChanged?.()
				for (const listener of this.pairingRequiredListeners) {
					listener()
				}
			},
			onConnectError: (err) => {
				console.error("[OpenClaw] Connect error:", err)
			},
		})

		void this.wsClient.start()
	}

	/** Disconnect the WebSocket client. */
	disconnectWebSocket(): void {
		if (this.wsClient) {
			this.wsClient.stop()
			this.wsClient = null
		}
	}

	/** Current WebSocket connection state */
	get wsConnectionState(): WsConnectionState {
		return this.wsClient?.connectionState ?? "disconnected"
	}

	/** Register a listener for WebSocket connection state changes */
	onConnectionStateChange(
		listener: (state: WsConnectionState) => void,
	): () => void {
		this.connectionStateListeners.push(listener)
		return () => {
			this.connectionStateListeners =
				this.connectionStateListeners.filter((l) => l !== listener)
		}
	}

	/** Register a listener for pairing required events */
	onPairingRequired(listener: () => void): () => void {
		this.pairingRequiredListeners.push(listener)
		return () => {
			this.pairingRequiredListeners =
				this.pairingRequiredListeners.filter((l) => l !== listener)
		}
	}

	/** Handle device token received from gateway after successful pairing */
	private handleDeviceTokenReceived(token: DeviceAuthToken): void {
		const settings = this.getSettings()
		settings.deviceAuthToken = token
		settings.devicePairingStatus = "paired"
		void this.onSettingsChanged?.()
	}

	// ── Health check ─────────────────────────────────────────────

	/** Check gateway health (always uses HTTP) */
	async healthCheck(): Promise<boolean> {
		// If WebSocket is connected, that's a good health signal
		if (
			this.streamingMode === "websocket" &&
			this.wsClient?.isConnected
		) {
			return true
		}

		try {
			const res = await requestUrl({
				url: `${this.baseUrl}/health`,
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
				},
			})
			return res.status === 200
		} catch {
			return false
		}
	}


	/** Fetch chat history for a session via WebSocket */
	async chatHistory(
		sessionKey: string,
		limit = 50,
	): Promise<Record<string, unknown> | undefined> {
		if (!this.wsClient?.isConnected) return undefined
		return this.wsClient.chatHistory(sessionKey, limit)
	}

	/** Remove a paired device from the gateway */
	async removeDevice(deviceId: string): Promise<boolean> {
		// Use WebSocket RPC if connected
		if (this.wsClient?.isConnected) {
			return await this.wsClient.removeDevice(deviceId)
		}
		
		// Fallback: not supported without WebSocket
		console.error("[OpenClaw] Device removal requires WebSocket connection")
		return false
	}

	// ── Non-streaming (HTTP) ─────────────────────────────────────

	/**
	 * Send a chat message (non-streaming).
	 * Returns the full assistant response.
	 */
	async sendMessage(
		messages: Array<{ role: string; content: string }>,
		sessionUser?: string,
	): Promise<string> {
		const body: Record<string, unknown> = {
			model: `openclaw:${this.agentId}`,
			messages,
			stream: false,
		}
		if (sessionUser) {
			body.user = sessionUser
		}

		const res = await requestUrl({
			url: `${this.baseUrl}/v1/chat/completions`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify(body),
		})

		const data = res.json as ChatCompletionResponse
		return data.choices?.[0]?.message?.content ?? ""
	}

	// ── Streaming (WebSocket) ─────────────────────────────────────

	/**
	 * Send a chat message with streaming via WebSocket.
	 */
	async sendMessageStreaming(
		messages: Array<{ role: string; content: string }>,
		onChunk: (text: string) => void,
		onDone: () => void,
		onError: (err: Error) => void,
		signal?: AbortSignal,
		sessionUser?: string,
	): Promise<void> {
		if (!this.wsClient?.isConnected) {
			// Auto-connect if not connected
			this.connectWebSocket()

			// Wait briefly for connection
			const connected = await this.waitForConnection(5_000)
			if (!connected) {
				onError(
					new Error(
						"WebSocket not connected. Check gateway URL and token.",
					),
				)
				return
			}
		}

		// Build the user message from conversation
		const lastUserMessage = this.extractLastUserMessage(messages)
		if (!lastUserMessage) {
			onError(new Error("No user message found in conversation"))
			return
		}

		// Build session key
		const sessionKey = this.resolveSessionKey(sessionUser)

		try {
			const runId = await this.wsClient!.chatSend(
				sessionKey,
				lastUserMessage,
			)

			// Register event handler for this run
			this.chatEventListeners.set(runId, {
				onChunk,
				onDone: () => {
					this.chatEventListeners.delete(runId)
					onDone()
				},
				onError: (err) => {
					this.chatEventListeners.delete(runId)
					onError(err)
				},
			})

			// Handle abort signal
			if (signal) {
				const abortHandler = () => {
					this.chatEventListeners.delete(runId)
					this.wsClient
						?.chatAbort(sessionKey, runId)
						.catch(() => {})
					onDone()
				}

				if (signal.aborted) {
					abortHandler()
					return
				}
				signal.addEventListener("abort", abortHandler, {
					once: true,
				})
			}
		} catch (err: unknown) {
			onError(err instanceof Error ? err : new Error(String(err)))
		}
	}

	/** Handle incoming chat events from WebSocket */
	private handleChatEvent(event: ChatEventPayload): void {
		const listener = this.chatEventListeners.get(event.runId)
		if (!listener) return

		switch (event.state) {
			case "delta": {
				const text = this.extractTextFromChatMessage(event.message)
				if (text !== null) {
					listener.onChunk(text)
				}
				break
			}
			case "final": {
				const text = this.extractTextFromChatMessage(event.message)
				if (text !== null) {
					listener.onChunk(text)
				}
				listener.onDone()
				break
			}
			case "error": {
				listener.onError(
					new Error(
						event.errorMessage ?? "Unknown gateway error",
					),
				)
				break
			}
			case "aborted": {
				listener.onDone()
				break
			}
		}
	}

	/**
	 * Extract text content from a gateway chat message.
	 * Gateway messages use: { content: [{ type: "text", text: "..." }] }
	 */
	private extractTextFromChatMessage(
		message?: ChatEventPayload["message"],
	): string | null {
		if (!message?.content) return null
		const parts = message.content
			.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text!)
		return parts.length > 0 ? parts.join("") : null
	}

	/**
	 * Extract the last user message text from an OpenAI-style messages array.
	 */
	private extractLastUserMessage(
		messages: Array<{ role: string; content: string }>,
	): string | null {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]!.role === "user") {
				return messages[i]!.content
			}
		}
		return null
	}

	/**
	 * Resolve a session key for WebSocket chat.
	 * Uses the persisted currentSessionKey if available; otherwise generates
	 * a new unique key, persists it, and returns it.
	 */
	private resolveSessionKey(_sessionUser?: string): string {
		const settings = this.getSettings()
		if (settings.currentSessionKey) {
			return settings.currentSessionKey
		}
		const key = `${this.agentId}:${Date.now()}:${crypto.randomUUID()}`
		settings.currentSessionKey = key
		void this.onSettingsChanged?.()
		return key
	}

	/** Wait for WebSocket connection up to timeoutMs */
	private waitForConnection(timeoutMs: number): Promise<boolean> {
		if (this.wsClient?.isConnected) return Promise.resolve(true)

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				unsub()
				resolve(false)
			}, timeoutMs)

			const unsub = this.onConnectionStateChange((state) => {
				if (state === "connected") {
					clearTimeout(timeout)
					unsub()
					resolve(true)
				} else if (state === "disconnected") {
					clearTimeout(timeout)
					unsub()
					resolve(false)
				}
			})
		})
	}
}
