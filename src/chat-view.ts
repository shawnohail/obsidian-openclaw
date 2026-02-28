import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	WorkspaceLeaf,
	setIcon,
} from "obsidian"
import type OpenClawPlugin from "./main"
import type { ChatMessage } from "./types"
import type { WsConnectionState } from "./ws-gateway-client"

export const VIEW_TYPE_OPENCLAW_CHAT = "openclaw-chat-view"

export class OpenClawChatView extends ItemView {
	private messages: ChatMessage[] = []
	private containerEl_messages!: HTMLElement
	private inputEl!: HTMLTextAreaElement
	private sendBtn!: HTMLButtonElement
	private statusEl!: HTMLElement
	private abortController: AbortController | null = null
	private capturedSelection: string = ""
	private unsubConnectionState: (() => void) | null = null

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: OpenClawPlugin,
	) {
		super(leaf)
	}

	getViewType(): string {
		return VIEW_TYPE_OPENCLAW_CHAT
	}

	getDisplayText(): string {
		return "OpenClaw chat"
	}

	getIcon(): string {
		return "message-circle"
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement
		container.empty()
		container.addClass("openclaw-chat-container")

		// Header
		const header = container.createDiv({ cls: "openclaw-chat-header" })
		const titleRow = header.createDiv({ cls: "openclaw-chat-title-row" })
		titleRow.createEl("span", {
			text: "🦞 OpenClaw",
			cls: "openclaw-chat-title",
		})

		this.statusEl = titleRow.createEl("span", {
			cls: "openclaw-chat-status",
		})
		this.updateStatus("disconnected")

		const newSessionBtn = titleRow.createEl("button", {
			cls: "openclaw-chat-clear-btn",
			attr: { "aria-label": "New session" },
		})
		newSessionBtn.setText("New session")
		newSessionBtn.addEventListener("click", () => {
			void this.newSession()
		})

		// Messages area
		this.containerEl_messages = container.createDiv({
			cls: "openclaw-chat-messages",
		})

		// Input area
		const inputArea = container.createDiv({
			cls: "openclaw-chat-input-area",
		})

		this.inputEl = inputArea.createEl("textarea", {
			cls: "openclaw-chat-input",
			attr: {
				placeholder: "Message OpenClaw…",
				rows: "1",
			},
		})

		this.sendBtn = inputArea.createEl("button", {
			cls: "openclaw-chat-send-btn clickable-icon",
			attr: { "aria-label": "Send" },
		})
		setIcon(this.sendBtn, "send")

		// Event handlers
		this.sendBtn.addEventListener("click", () => {
			void this.handleSend()
		})
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				void this.handleSend()
			}
		})

		// Capture selection continuously via document selectionchange event
		// This fires before the selection is cleared by focus events
		const handleSelectionChange = () => {
			if (!this.plugin.settings.shareSelection) return
			
			const leaves = this.app.workspace.getLeavesOfType("markdown")
			if (leaves.length === 0) return
			
			const leaf = leaves[0]
			if (!leaf) return
			
			const mdView = leaf.view as MarkdownView
			const editor = mdView?.editor
			
			if (editor) {
				const selection = editor.getSelection()
				if (selection) {
					this.capturedSelection = selection
				}
			}
		}
		
		document.addEventListener("selectionchange", handleSelectionChange)
		this.register(() => document.removeEventListener("selectionchange", handleSelectionChange))

		// Subscribe to WebSocket connection state changes
		if (this.plugin.settings.streamingMode === "websocket") {
			this.unsubConnectionState =
				this.plugin.client.onConnectionStateChange((state: WsConnectionState) => {
					this.onWsStateChange(state)
				})
			// Set initial state
			this.onWsStateChange(this.plugin.client.wsConnectionState)
		} else {
			// Check connectivity via HTTP
			void this.checkHealth()
		}

		// Add styles
		this.addStyles()
	}

	async onClose(): Promise<void> {
		this.abortController?.abort()
		if (this.unsubConnectionState) {
			this.unsubConnectionState()
			this.unsubConnectionState = null
		}
	}

	private onWsStateChange(state: WsConnectionState): void {
		switch (state) {
			case "connected":
				this.updateStatus("connected")
				// Load history on first connect
				if (this.messages.length === 0) {
					void this.loadHistory()
				}
				break
			case "connecting":
			case "authenticating":
				this.updateStatus("connecting")
				break
			case "reconnecting":
				this.updateStatus("reconnecting")
				break
			case "pairing_required":
				this.updateStatus("pairing_required")
				break
			case "disconnected":
			default:
				this.updateStatus("disconnected")
				break
		}
	}

	private async checkHealth(): Promise<void> {
		const ok = await this.plugin.client.healthCheck()
		this.updateStatus(ok ? "connected" : "disconnected")
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
		this.statusEl.empty()
		this.statusEl.createEl("span", {
			cls: `openclaw-status-dot openclaw-status-${status}`,
		})
		const labelMap: Record<string, string> = {
			connected: "Connected",
			disconnected: "Disconnected",
			typing: "Thinking…",
			connecting: "Connecting…",
			reconnecting: "Reconnecting…",
			pairing_required: "Pairing required",
		}
		this.statusEl.createEl("span", {
			text: labelMap[status] ?? status,
			cls: "openclaw-status-label",
		})
	}

	/** Content block shape from API */
	private isTextBlock(block: unknown): block is { type?: string; text?: string } {
		return !!block && typeof block === "object" && "text" in block
	}

	/** Extract text content from message content (handles string, object, or array) */
	private extractTextContent(content: unknown): string {
		if (typeof content === "string") return content

		// Handle single content block
		if (content && typeof content === "object" && !Array.isArray(content)) {
			const obj = content as { type?: string; text?: string }
			if (obj.text) return obj.text
			if (obj.type === "text" && obj.text) return obj.text
		}

		// Handle array of content blocks
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: string; text: string } =>
					this.isTextBlock(block) && block.type === "text" && !!block.text)
				.map((block) => block.text)
				.join("\n")
		}

		return ""
	}

	private async loadHistory(): Promise<void> {
		const sessionKey = this.plugin.settings.currentSessionKey
		if (!sessionKey) return

		try {
			const result = await this.plugin.client.chatHistory(sessionKey, 50)
			if (!result) return

			// Handle response: could be array directly or wrapped in .messages
			const messages = Array.isArray(result) ? result : (result.messages || [])
			if (!Array.isArray(messages)) return

			// Render existing messages
			for (const msg of messages as Array<{ role: string; content: unknown }>) {
				if (msg.role === "user") {
					const userMsg: ChatMessage = {
						role: "user",
						content: this.extractTextContent(msg.content),
						id: crypto.randomUUID(),
						timestamp: Date.now(),
					}
					this.messages.push(userMsg)
					this.renderMessage(userMsg)
				} else if (msg.role === "assistant") {
					const assistantMsg: ChatMessage = {
						role: "assistant",
						content: this.extractTextContent(msg.content),
						id: crypto.randomUUID(),
						timestamp: Date.now(),
					}
					this.messages.push(assistantMsg)
					this.renderMessage(assistantMsg)
				}
			}
		} catch (err) {
			console.error("[OpenClaw] Failed to load history:", err)
		}
	}

	private async newSession(): Promise<void> {
		// Clear UI
		this.messages = []
		this.containerEl_messages.empty()

		// Generate new session key
		const agentId = this.plugin.settings.agentId || "main"
		const newKey = `${agentId}:${Date.now()}:${crypto.randomUUID()}`

		// Save to settings
		this.plugin.settings.currentSessionKey = newKey
		await this.plugin.saveSettings()
	}

	private async handleSend(): Promise<void> {
		const text = this.inputEl.value.trim()
		if (!text) return

		this.inputEl.value = ""

		// Build context prefix
		let contextPrefix = ""
		const settings = this.plugin.settings

		if (settings.shareActiveFile || settings.shareSelection) {
			const activeFile = this.app.workspace.getActiveFile()

			if (settings.shareActiveFile && activeFile) {
				contextPrefix += `[Active file: ${activeFile.path}]\n`
			}

			if (settings.shareSelection && this.capturedSelection) {
				contextPrefix += `[Selected text:\n${this.capturedSelection}\n]\n`
			}

			if (contextPrefix) {
				contextPrefix += "\n"
			}
		}

		// Add user message to UI
		const userMsg: ChatMessage = {
			id: this.generateId(),
			role: "user",
			content: text,
			timestamp: Date.now(),
		}
		this.messages.push(userMsg)
		this.renderMessage(userMsg)

		// Clear captured selection after using it
		this.capturedSelection = ""

		// Build conversation messages for the API
		const apiMessages = this.messages
			.filter((m) => m.role !== "system")
			.map((m) => {
				if (m === userMsg && contextPrefix) {
					return { role: m.role, content: contextPrefix + m.content }
				}
				return { role: m.role, content: m.content }
			})

		// Create assistant message placeholder
		const assistantMsg: ChatMessage = {
			id: this.generateId(),
			role: "assistant",
			content: "",
			timestamp: Date.now(),
			streaming: true,
		}
		this.messages.push(assistantMsg)
		const msgEl = this.renderMessage(assistantMsg)
		const contentEl = msgEl.querySelector(
			".openclaw-msg-content",
		) as HTMLElement

		this.updateStatus("typing")
		this.sendBtn.disabled = true

		const streamingMode = this.plugin.settings.streamingMode

		try {
			if (streamingMode !== "off") {
				// Track the last full text for WS delta handling.
				// The gateway sends accumulated text in each delta,
				// so for WS mode we need to replace (not append).
				const isWebSocket = streamingMode === "websocket"

				this.abortController = new AbortController()
				await this.plugin.client.sendMessageStreaming(
					apiMessages,
					(chunk: string) => {
						if (isWebSocket) {
							// WS deltas contain the full accumulated text
							assistantMsg.content = chunk
						} else {
							// SSE deltas are incremental
							assistantMsg.content += chunk
						}
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						)
					},
					() => {
						assistantMsg.streaming = false
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						)
						this.updateStatus("connected")
						this.sendBtn.disabled = false
						this.abortController = null
					},
					(err: Error) => {
						assistantMsg.content = `⚠️ Error: ${err.message}`
						assistantMsg.streaming = false
						this.updateMessageContent(
							contentEl,
							assistantMsg.content,
						)
						this.updateStatus("disconnected")
						this.sendBtn.disabled = false
						this.abortController = null
					},
					this.abortController.signal,
					"obsidian-plugin",
				)
			} else {
				const response = await this.plugin.client.sendMessage(
					apiMessages,
					"obsidian-plugin",
				)
				assistantMsg.content = response
				assistantMsg.streaming = false
				this.updateMessageContent(contentEl, response)
				this.updateStatus("connected")
				this.sendBtn.disabled = false
			}
		} catch (err: unknown) {
			const errorMsg =
				err instanceof Error ? err.message : String(err)
			assistantMsg.content = `⚠️ Error: ${errorMsg}`
			assistantMsg.streaming = false
			this.updateMessageContent(contentEl, assistantMsg.content)
			this.updateStatus("disconnected")
			this.sendBtn.disabled = false
		}
	}

	private renderMessage(msg: ChatMessage): HTMLElement {
		const msgEl = this.containerEl_messages.createDiv({
			cls: `openclaw-msg openclaw-msg-${msg.role}`,
		})

		const avatar = msgEl.createDiv({ cls: "openclaw-msg-avatar" })
		avatar.setText(msg.role === "user" ? "👤" : "🦞")

		const body = msgEl.createDiv({ cls: "openclaw-msg-body" })
		const contentEl = body.createDiv({ cls: "openclaw-msg-content" })

		if (msg.content) {
			this.updateMessageContent(contentEl, msg.content)
		} else if (msg.streaming) {
			contentEl.createEl("span", {
				cls: "openclaw-typing-indicator",
				text: "●●●",
			})
		}

		// Scroll to bottom
		this.containerEl_messages.scrollTop =
			this.containerEl_messages.scrollHeight

		return msgEl
	}

	private updateMessageContent(el: HTMLElement, content: string): void {
		el.empty()
		// Render markdown (plugin required by MarkdownRenderer API)
		void MarkdownRenderer.render(
			this.app,
			content,
			el,
			"",
			// eslint-disable-next-line obsidianmd/no-plugin-as-component -- MarkdownRenderer requires plugin
			this.plugin,
		)
		// Scroll to bottom
		this.containerEl_messages.scrollTop =
			this.containerEl_messages.scrollHeight
	}

	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
	}

	private addStyles(): void {
		// Styles are in styles.css, loaded by Obsidian
	}
}
