import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type OpenClawPlugin from "./main";
import type { ChatMessage } from "./types";
import type { WsConnectionState } from "./ws-gateway-client";

export const VIEW_TYPE_OPENCLAW_CHAT = "openclaw-chat-view";

export class OpenClawChatView extends ItemView {
	private messages: ChatMessage[] = [];
	private containerEl_messages!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private abortController: AbortController | null = null;
	private capturedSelection: string = "";
	private unsubConnectionState: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: OpenClawPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_OPENCLAW_CHAT;
	}

	getDisplayText(): string {
		return "OpenClaw Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("openclaw-chat-container");

		// Header
		const header = container.createDiv({ cls: "openclaw-chat-header" });
		const titleRow = header.createDiv({ cls: "openclaw-chat-title-row" });
		titleRow.createEl("span", {
			text: "🦞 OpenClaw",
			cls: "openclaw-chat-title",
		});

		this.statusEl = titleRow.createEl("span", {
			cls: "openclaw-chat-status",
		});
		this.updateStatus("disconnected");

		const newSessionBtn = titleRow.createEl("button", {
			cls: "openclaw-chat-clear-btn",
			attr: { "aria-label": "New session" },
		});
		newSessionBtn.setText("New Session");
		newSessionBtn.addEventListener("click", () => this.newSession());

		// Messages area
		this.containerEl_messages = container.createDiv({
			cls: "openclaw-chat-messages",
		});

		// Input area
		const inputArea = container.createDiv({
			cls: "openclaw-chat-input-area",
		});

		this.inputEl = inputArea.createEl("textarea", {
			cls: "openclaw-chat-input",
			attr: {
				placeholder: "Message OpenClaw…",
				rows: "1",
			},
		});

		this.sendBtn = inputArea.createEl("button", {
			cls: "openclaw-chat-send-btn clickable-icon",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.sendBtn, "send");

		// Event handlers
		this.sendBtn.addEventListener("click", () => this.handleSend());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.handleSend();
			}
		});

		// Capture selection continuously via document selectionchange event
		// This fires before the selection is cleared by focus events
		const handleSelectionChange = () => {
			if (!this.plugin.settings.shareSelection) return;
			
			const leaves = this.app.workspace.getLeavesOfType("markdown");
			if (leaves.length === 0) return;
			
			const leaf = leaves[0];
			if (!leaf) return;
			
			const mdView = leaf.view as MarkdownView;
			const editor = mdView?.editor;
			
			if (editor) {
				const selection = editor.getSelection();
				if (selection) {
					this.capturedSelection = selection;
				}
			}
		};
		
		document.addEventListener("selectionchange", handleSelectionChange);
		this.register(() => document.removeEventListener("selectionchange", handleSelectionChange));

		// Auto-resize textarea
		this.inputEl.addEventListener("input", () => {
			this.inputEl.style.height = "auto";
			this.inputEl.style.height =
				Math.min(this.inputEl.scrollHeight, 150) + "px";
		});

		// Subscribe to WebSocket connection state changes
		if (this.plugin.settings.streamingMode === "websocket") {
			this.unsubConnectionState =
				this.plugin.client.onConnectionStateChange((state) => {
					this.onWsStateChange(state);
				});
			// Set initial state
			this.onWsStateChange(this.plugin.client.wsConnectionState);
		} else {
			// Check connectivity via HTTP
			this.checkHealth();
		}

		// Add styles
		this.addStyles();
	}

	async onClose(): Promise<void> {
		this.abortController?.abort();
		if (this.unsubConnectionState) {
			this.unsubConnectionState();
			this.unsubConnectionState = null;
		}
	}

	private onWsStateChange(state: WsConnectionState): void {
		switch (state) {
			case "connected":
				this.updateStatus("connected");
				// Load history on first connect
				if (this.messages.length === 0) {
					this.loadHistory();
				}
				break;
			case "connecting":
			case "authenticating":
				this.updateStatus("connecting");
				break;
			case "reconnecting":
				this.updateStatus("reconnecting");
				break;
			case "pairing_required":
				this.updateStatus("pairing_required");
				break;
			case "disconnected":
			default:
				this.updateStatus("disconnected");
				break;
		}
	}

	private async checkHealth(): Promise<void> {
		const ok = await this.plugin.client.healthCheck();
		this.updateStatus(ok ? "connected" : "disconnected");
	}

	private updateStatus(
		status:
			| "connected"
			| "disconnected"
			| "typing"
			| "connecting"
			| "reconnecting"
			| "pairing_required",
	): void {
		this.statusEl.empty();
		this.statusEl.createEl("span", {
			cls: `openclaw-status-dot openclaw-status-${status}`,
		});
		const labelMap: Record<string, string> = {
			connected: "Connected",
			disconnected: "Disconnected",
			typing: "Thinking…",
			connecting: "Connecting…",
			reconnecting: "Reconnecting…",
			pairing_required: "Pairing required",
		};
		this.statusEl.createEl("span", {
			text: labelMap[status] ?? status,
			cls: "openclaw-status-label",
		});
	}

	/** Extract text content from message content (handles string, object, or array) */
	private extractTextContent(content: any): string {
		if (typeof content === "string") return content;
		
		// Handle single content block
		if (content && typeof content === "object" && !Array.isArray(content)) {
			if (content.text) return content.text;
			if (content.type === "text" && content.text) return content.text;
		}
		
		// Handle array of content blocks
		if (Array.isArray(content)) {
			return content
				.filter(block => block.type === "text" && block.text)
				.map(block => block.text)
				.join("\n");
		}
		
		return "";
	}

	private async loadHistory(): Promise<void> {
		const sessionKey = this.plugin.settings.currentSessionKey;
		if (!sessionKey) return;

		try {
			const result = await this.plugin.client.chatHistory(sessionKey, 50);
			if (!result) return;

			// Handle response: could be array directly or wrapped in .messages
			const messages = Array.isArray(result) ? result : (result.messages || []);
			if (!Array.isArray(messages)) return;

			// Render existing messages
			for (const msg of messages) {
				if (msg.role === "user") {
					const userMsg: ChatMessage = { 
						role: "user", 
						content: this.extractTextContent(msg.content), 
						id: crypto.randomUUID(), 
						timestamp: Date.now() 
					};
					this.messages.push(userMsg);
					this.renderMessage(userMsg);
				} else if (msg.role === "assistant") {
					const assistantMsg: ChatMessage = { 
						role: "assistant", 
						content: this.extractTextContent(msg.content), 
						id: crypto.randomUUID(), 
						timestamp: Date.now() 
					};
					this.messages.push(assistantMsg);
					this.renderMessage(assistantMsg);
				}
			}
		} catch (err) {
			console.error("[OpenClaw] Failed to load history:", err);
		}
	}

	private async newSession(): Promise<void> {
		// Clear UI
		this.messages = [];
		this.containerEl_messages.empty();

		// Generate new session key
		const agentId = this.plugin.settings.agentId || "main";
		const newKey = `${agentId}:${Date.now()}:${crypto.randomUUID()}`;

		// Save to settings
		this.plugin.settings.currentSessionKey = newKey;
		await this.plugin.saveSettings();
	}

	private async handleSend(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;

		this.inputEl.value = "";
		this.inputEl.style.height = "auto";

		// Build context prefix
		let contextPrefix = "";
		const settings = this.plugin.settings;

		if (settings.shareActiveFile || settings.shareSelection) {
			const activeFile = this.app.workspace.getActiveFile();

			if (settings.shareActiveFile && activeFile) {
				contextPrefix += `[Active file: ${activeFile.path}]\n`;
			}

			if (settings.shareSelection && this.capturedSelection) {
				contextPrefix += `[Selected text:\n${this.capturedSelection}\n]\n`;
			}

			if (contextPrefix) {
				contextPrefix += "\n";
			}
		}

		// Add user message to UI
		const userMsg: ChatMessage = {
			id: this.generateId(),
			role: "user",
			content: text,
			timestamp: Date.now(),
		};
		this.messages.push(userMsg);
		this.renderMessage(userMsg);

		// Clear captured selection after using it
		this.capturedSelection = "";

		// Build conversation messages for the API
		const apiMessages = this.messages
			.filter((m) => m.role !== "system")
			.map((m) => {
				if (m === userMsg && contextPrefix) {
					return { role: m.role, content: contextPrefix + m.content };
				}
				return { role: m.role, content: m.content };
			});

		// Create assistant message placeholder
		const assistantMsg: ChatMessage = {
			id: this.generateId(),
			role: "assistant",
			content: "",
			timestamp: Date.now(),
			streaming: true,
		};
		this.messages.push(assistantMsg);
		const msgEl = this.renderMessage(assistantMsg);
		const contentEl = msgEl.querySelector(
			".openclaw-msg-content",
		) as HTMLElement;

		this.updateStatus("typing");
		this.sendBtn.disabled = true;

		const streamingMode = this.plugin.settings.streamingMode;

		try {
			if (streamingMode !== "off") {
				// Track the last full text for WS delta handling.
				// The gateway sends accumulated text in each delta,
				// so for WS mode we need to replace (not append).
				const isWebSocket = streamingMode === "websocket";

				this.abortController = new AbortController();
				await this.plugin.client.sendMessageStreaming(
					apiMessages,
					(chunk: string) => {
						if (isWebSocket) {
							// WS deltas contain the full accumulated text
							assistantMsg.content = chunk;
						} else {
							// SSE deltas are incremental
							assistantMsg.content += chunk;
						}
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						);
					},
					() => {
						assistantMsg.streaming = false;
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						);
						this.updateStatus("connected");
						this.sendBtn.disabled = false;
						this.abortController = null;
					},
					(err: Error) => {
						assistantMsg.content = `⚠️ Error: ${err.message}`;
						assistantMsg.streaming = false;
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						);
						this.updateStatus("disconnected");
						this.sendBtn.disabled = false;
						this.abortController = null;
					},
					this.abortController.signal,
					"obsidian-plugin",
				);
			} else {
				const response = await this.plugin.client.sendMessage(
					apiMessages,
					"obsidian-plugin",
				);
				assistantMsg.content = response;
				assistantMsg.streaming = false;
				this.updateMessageContent(contentEl, response);
				this.updateStatus("connected");
				this.sendBtn.disabled = false;
			}
		} catch (err: unknown) {
			const errorMsg =
				err instanceof Error ? err.message : String(err);
			assistantMsg.content = `⚠️ Error: ${errorMsg}`;
			assistantMsg.streaming = false;
			this.updateMessageContent(contentEl, assistantMsg.content);
			this.updateStatus("disconnected");
			this.sendBtn.disabled = false;
		}
	}

	private renderMessage(msg: ChatMessage): HTMLElement {
		const msgEl = this.containerEl_messages.createDiv({
			cls: `openclaw-msg openclaw-msg-${msg.role}`,
		});

		const avatar = msgEl.createDiv({ cls: "openclaw-msg-avatar" });
		avatar.setText(msg.role === "user" ? "👤" : "🦞");

		const body = msgEl.createDiv({ cls: "openclaw-msg-body" });
		const contentEl = body.createDiv({ cls: "openclaw-msg-content" });

		if (msg.content) {
			this.updateMessageContent(contentEl, msg.content);
		} else if (msg.streaming) {
			contentEl.createEl("span", {
				cls: "openclaw-typing-indicator",
				text: "●●●",
			});
		}

		// Scroll to bottom
		this.containerEl_messages.scrollTop =
			this.containerEl_messages.scrollHeight;

		return msgEl;
	}

	private updateMessageContent(el: HTMLElement, content: string): void {
		el.empty();
		// Render markdown
		MarkdownRenderer.render(
			this.app,
			content,
			el,
			"",
			this.plugin,
		);
		// Scroll to bottom
		this.containerEl_messages.scrollTop =
			this.containerEl_messages.scrollHeight;
	}

	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
	}

	private addStyles(): void {
		const styleId = "openclaw-chat-styles";
		if (document.getElementById(styleId)) return;

		const style = document.createElement("style");
		style.id = styleId;
		style.textContent = `
			.openclaw-chat-container {
				display: flex;
				flex-direction: column;
				height: 100%;
				padding: 0;
			}

			.openclaw-chat-header {
				padding: 12px 16px;
				border-bottom: 1px solid var(--background-modifier-border);
				flex-shrink: 0;
			}

			.openclaw-chat-title-row {
				display: flex;
				align-items: center;
				gap: 8px;
			}

			.openclaw-chat-title {
				font-weight: 600;
				font-size: 14px;
				flex-grow: 1;
			}

			.openclaw-chat-status {
				display: flex;
				align-items: center;
				gap: 4px;
				font-size: 11px;
				color: var(--text-muted);
			}

			.openclaw-status-dot {
				width: 6px;
				height: 6px;
				border-radius: 50%;
				display: inline-block;
			}

			.openclaw-status-connected { background: var(--color-green); }
			.openclaw-status-disconnected { background: var(--color-red); }
			.openclaw-status-connecting {
				background: var(--color-yellow);
				animation: openclaw-pulse 1.2s ease-in-out infinite;
			}
			.openclaw-status-reconnecting {
				background: var(--color-orange);
				animation: openclaw-pulse 1.2s ease-in-out infinite;
			}
			.openclaw-status-typing {
				background: var(--color-yellow);
				animation: openclaw-pulse 1s ease-in-out infinite;
			}

			.openclaw-status-pairing_required {
				background: var(--color-orange);
			}

			@keyframes openclaw-pulse {
				0%, 100% { opacity: 1; }
				50% { opacity: 0.4; }
			}

			.openclaw-chat-clear-btn {
				color: var(--text-muted);
			}

			.openclaw-chat-messages {
				flex-grow: 1;
				overflow-y: auto;
				padding: 12px;
				display: flex;
				flex-direction: column;
				gap: 12px;
			}

			.openclaw-msg {
				display: flex;
				gap: 8px;
				max-width: 100%;
			}

			.openclaw-msg-avatar {
				flex-shrink: 0;
				width: 28px;
				height: 28px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 16px;
				border-radius: 50%;
				background: var(--background-modifier-hover);
			}

			.openclaw-msg-body {
				flex-grow: 1;
				min-width: 0;
			}

			.openclaw-msg-content {
				font-size: 13.5px;
				line-height: 1.5;
				word-break: break-word;
				user-select: text;
				-webkit-user-select: text;
				cursor: text;
			}
			
			.openclaw-msg-content * {
				user-select: text;
				-webkit-user-select: text;
			}

			.openclaw-msg-content p:first-child { margin-top: 0; }
			.openclaw-msg-content p:last-child { margin-bottom: 0; }

			.openclaw-msg-user .openclaw-msg-content {
				color: var(--text-normal);
			}

			.openclaw-msg-assistant .openclaw-msg-content {
				color: var(--text-normal);
			}

			.openclaw-typing-indicator {
				color: var(--text-muted);
				animation: openclaw-typing 1.4s infinite;
				letter-spacing: 2px;
			}

			@keyframes openclaw-typing {
				0%, 100% { opacity: 0.3; }
				50% { opacity: 1; }
			}

			.openclaw-chat-input-area {
				padding: 12px;
				border-top: 1px solid var(--background-modifier-border);
				display: flex;
				gap: 8px;
				align-items: flex-end;
				flex-shrink: 0;
			}

			.openclaw-chat-input {
				flex-grow: 1;
				resize: none;
				border: 1px solid var(--background-modifier-border);
				border-radius: 8px;
				padding: 8px 12px;
				font-size: 13px;
				line-height: 1.4;
				background: var(--background-primary);
				color: var(--text-normal);
				font-family: inherit;
				min-height: 36px;
				max-height: 150px;
			}

			.openclaw-chat-input:focus {
				border-color: var(--interactive-accent);
				outline: none;
				box-shadow: 0 0 0 2px var(--background-modifier-border-focus);
			}

			.openclaw-chat-input::placeholder {
				color: var(--text-faint);
			}

			.openclaw-chat-send-btn {
				color: var(--interactive-accent);
				flex-shrink: 0;
				width: 36px;
				height: 36px;
				display: flex;
				align-items: center;
				justify-content: center;
			}

			.openclaw-chat-send-btn:disabled {
				opacity: 0.4;
				cursor: not-allowed;
			}

			/* Code blocks in assistant messages */
			.openclaw-msg-content pre {
				background: var(--background-secondary);
				padding: 8px 12px;
				border-radius: 6px;
				overflow-x: auto;
				font-size: 12px;
			}

			.openclaw-msg-content code {
				font-size: 12px;
			}
		`;
		document.head.appendChild(style);
	}
}
