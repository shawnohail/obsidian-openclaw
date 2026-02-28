import { Plugin, WorkspaceLeaf } from "obsidian";
import { OpenClawChatView, VIEW_TYPE_OPENCLAW_CHAT } from "./chat-view";
import { GatewayClient } from "./gateway-client";
import { OpenClawSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS, type OpenClawSettings } from "./types";
import { generateDeviceIdentity, validateDeviceIdentity } from "./device-identity";

export default class OpenClawPlugin extends Plugin {
	settings!: OpenClawSettings;
	client!: GatewayClient;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Migrate legacy enableStreaming boolean to streamingMode
		if (
			this.settings.streamingMode === undefined ||
			this.settings.streamingMode === null
		) {
			this.settings.streamingMode = this.settings.enableStreaming
				? "websocket"
				: "off";
			await this.saveSettings();
		}

		// Ensure device identity exists
		await this.ensureDeviceIdentity();

		this.client = new GatewayClient(() => this.settings);

		// Wire up settings persistence for device token updates
		this.client.onSettingsChanged = async () => {
			await this.saveSettings();
		};

		// Register the chat sidebar view
		this.registerView(VIEW_TYPE_OPENCLAW_CHAT, (leaf: WorkspaceLeaf) => {
			return new OpenClawChatView(leaf, this);
		});

		// Ribbon icon to open the chat
		this.addRibbonIcon("message-circle", "Open OpenClaw Chat", () => {
			this.activateView();
		});

		// Command to toggle the chat panel
		this.addCommand({
			id: "open-openclaw-chat",
			name: "Open chat",
			callback: () => {
				this.activateView();
			},
		});

		// Command to send selection to chat
		this.addCommand({
			id: "send-selection-to-openclaw",
			name: "Send selection to OpenClaw",
			editorCallback: (editor) => {
				const selection = editor.getSelection();
				if (selection) {
					this.activateView().then(() => {
						// The view will pick up the selection via context sharing
					});
				}
			},
		});

		// Settings tab
		this.addSettingTab(new OpenClawSettingTab(this.app, this));

		// Auto-connect WebSocket if that's the configured mode
		if (this.settings.streamingMode === "websocket") {
			// Delay slightly to let Obsidian finish loading
			setTimeout(() => {
				this.client.connectWebSocket();
			}, 1_000);
		}
	}

	onunload(): void {
		// Clean up WebSocket connection
		this.client?.disconnectWebSocket();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Ensure a device identity exists in settings.
	 * Generates one on first run, validates on subsequent loads.
	 */
	async ensureDeviceIdentity(): Promise<void> {
		if (!this.settings.deviceIdentity) {
			this.settings.deviceIdentity = await generateDeviceIdentity();
			await this.saveSettings();
		} else {
			// Validate existing identity (re-derive deviceId if needed)
			const validated = await validateDeviceIdentity(
				this.settings.deviceIdentity,
			);
			if (validated.deviceId !== this.settings.deviceIdentity.deviceId) {
				this.settings.deviceIdentity = validated;
				await this.saveSettings();
			}
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_OPENCLAW_CHAT);

		if (leaves.length > 0) {
			// View already exists, reveal it
			leaf = leaves[0]!;
		} else {
			// Create the view in the right sidebar
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_OPENCLAW_CHAT,
					active: true,
				});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}
