import type { DeviceIdentityData, DeviceAuthToken, DevicePairingStatus } from "./device-identity";

/** Chat message displayed in the sidebar */
export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	/** True while streaming is in progress */
	streaming?: boolean;
}

/** Streaming transport mode */
export type StreamingMode = "websocket" | "http-sse" | "off";

/** Plugin settings persisted to data.json */
export interface OpenClawSettings {
	/** Gateway base URL (HTTP) */
	gatewayUrl: string;
	/** Auth token for the gateway */
	gatewayToken: string;
	/** Target agent id */
	agentId: string;
	/** Send active file path as context with each message */
	shareActiveFile: boolean;
	/** Send selected text as context */
	shareSelection: boolean;
	/**
	 * Use SSE streaming for responses (legacy boolean).
	 * Kept for migration — prefer `streamingMode`.
	 */
	enableStreaming: boolean;
	/**
	 * Streaming transport mode.
	 * - "websocket" — persistent WS connection (recommended, no CORS issues)
	 * - "http-sse"  — fetch-based SSE (may hit CORS in some setups)
	 * - "off"       — non-streaming request/response via requestUrl()
	 */
	streamingMode: StreamingMode;

	// ── Device Pairing ───────────────────────────────────────────

	/** Persistent Ed25519 device identity (keypair + id) */
	deviceIdentity: DeviceIdentityData | null;
	/** Device auth token issued by gateway after pairing */
	deviceAuthToken: DeviceAuthToken | null;
	/** Current pairing status */
	devicePairingStatus: DevicePairingStatus;
	/** Active session key for the current conversation */
	currentSessionKey?: string;
}

export const DEFAULT_SETTINGS: OpenClawSettings = {
	gatewayUrl: "http://localhost:18789",
	gatewayToken: "",
	agentId: "main",
	shareActiveFile: true,
	shareSelection: true,
	enableStreaming: true,
	streamingMode: "websocket",
	deviceIdentity: null,
	deviceAuthToken: null,
	devicePairingStatus: "unpaired",
	currentSessionKey: undefined,
};

/** OpenAI-compatible chat completion response */
export interface ChatCompletionResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: {
			role: string;
			content: string;
		};
		finish_reason: string;
	}>;
}

/** SSE streaming delta */
export interface ChatCompletionChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
		};
		finish_reason: string | null;
	}>;
}
