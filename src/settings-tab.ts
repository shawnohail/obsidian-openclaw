import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OpenClawPlugin from "./main";
import type { StreamingMode } from "./types";
import { generateDeviceIdentity } from "./device-identity";

export class OpenClawSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: OpenClawPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "OpenClaw Settings" });

		containerEl.createEl("p", {
			text: "Connect Obsidian to your local OpenClaw gateway using WebSocket streaming for real-time responses.",
			cls: "setting-item-description",
		});

		// --- Connection ---
		containerEl.createEl("h3", { text: "Connection" });

		new Setting(containerEl)
			.setName("Gateway URL")
			.setDesc(
				"Base URL of the OpenClaw gateway.",
			)
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:18789")
					.setValue(this.plugin.settings.gatewayUrl)
					.onChange(async (value) => {
						this.plugin.settings.gatewayUrl = value;
						await this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("Test")
					.setCta()
					.onClick(async () => {
						button.setButtonText("Testing…");
						button.setDisabled(true);
						const ok = await this.plugin.client.healthCheck();
						button.setButtonText(ok ? "✓ Connected" : "✗ Failed");
						button.setDisabled(false);
						setTimeout(() => button.setButtonText("Test"), 2000);
					}),
			);

		new Setting(containerEl)
			.setName("Gateway token")
			.setDesc(
				"Authentication token (OPENCLAW_GATEWAY_TOKEN).",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				return text
					.setPlaceholder("Enter your gateway token")
					.setValue(this.plugin.settings.gatewayToken)
					.onChange(async (value) => {
						this.plugin.settings.gatewayToken = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Agent ID")
			.setDesc(
				"Which OpenClaw agent to chat with (e.g. 'main', 'beta'). Default: main.",
			)
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.agentId)
					.onChange(async (value) => {
						this.plugin.settings.agentId = value;
						await this.plugin.saveSettings();
					}),
			);

		// --- Device Pairing ---
		containerEl.createEl("h3", { text: "Device Pairing" });

		const identity = this.plugin.settings.deviceIdentity;
		const pairingStatus = this.plugin.settings.devicePairingStatus;

		// Device ID display
		if (identity) {
			new Setting(containerEl)
				.setName("Device ID")
				.setDesc("Unique identifier for this Obsidian installation.")
				.addText((text) => {
					text.inputEl.style.width = "100%";
					text.inputEl.style.fontFamily = "monospace";
					text.inputEl.style.fontSize = "11px";
					return text
						.setValue(identity.deviceId)
						.setDisabled(true);
				})
			.addButton((button) =>
				button.setButtonText("Regenerate").onClick(async () => {
					this.plugin.settings.deviceIdentity = await generateDeviceIdentity();
					this.plugin.settings.deviceAuthToken = null;
					this.plugin.settings.devicePairingStatus = "unpaired";
					await this.plugin.saveSettings();
					this.plugin.client.disconnectWebSocket();
					new Notice("New device identity generated. Re-pair to connect.");
					this.display();
				}),
			);
		}

		// Pairing status
		const statusLabels: Record<string, string> = {
			unpaired: "⚪ Not paired",
			pending: "🟡 Pending approval",
			paired: "🟢 Paired",
		};

		const statusSetting = new Setting(containerEl)
			.setName("Pairing status")
			.setDesc(statusLabels[pairingStatus] ?? "Unknown");

		if (pairingStatus === "unpaired" || pairingStatus === "pending") {
			statusSetting.addButton((button) =>
				button
					.setButtonText(
						pairingStatus === "pending"
							? "Retry Connection"
							: "Pair Device",
					)
					.setCta()
					.onClick(async () => {
						button.setButtonText("Connecting…");
						button.setDisabled(true);

						// Ensure identity exists
						if (!this.plugin.settings.deviceIdentity) {
							this.plugin.settings.deviceIdentity =
								await generateDeviceIdentity();
							await this.plugin.saveSettings();
						}

						// Trigger WebSocket reconnect — the connect flow
						// will send the device identity and the gateway
						// will add it to pending if not already paired.
						this.plugin.client.connectWebSocket();

						// Wait a few seconds for result
						await new Promise((resolve) =>
							setTimeout(resolve, 3_000),
						);

						const newStatus =
							this.plugin.settings.devicePairingStatus;
						if (newStatus === "paired") {
							new Notice("✅ Device paired successfully!");
						} else if (newStatus === "pending") {
							new Notice(
								"⏳ Pairing request sent. Approve on the gateway:\n  openclaw devices approve",
							);
						} else {
							new Notice(
								"Connection attempt completed. Check status.",
							);
						}

						button.setDisabled(false);
						this.display(); // Refresh UI
					}),
			);
		}

		if (pairingStatus === "paired") {
			statusSetting.addButton((button) =>
				button
					.setButtonText("Unpair Device")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.deviceAuthToken = null;
						this.plugin.settings.devicePairingStatus = "unpaired";
						await this.plugin.saveSettings();

						// Disconnect and reconnect without device token
						this.plugin.client.disconnectWebSocket();
						new Notice("Device unpaired. You may need to re-pair.");
						this.display();
					}),
			);
		}

		if (pairingStatus === "pending") {
			const pendingNote = containerEl.createDiv({
				cls: "setting-item-description",
			});
			pendingNote.style.marginTop = "-4px";
			pendingNote.style.paddingLeft = "18px";
			pendingNote.innerHTML = `
				<p style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
					This device is waiting for approval on the gateway host.<br>
					Run <code>openclaw devices approve</code> on the machine running the gateway,<br>
					or approve in the OpenClaw Control UI under Nodes → Devices.
				</p>
			`;
		}


		// --- Context ---
		containerEl.createEl("h3", { text: "Context Sharing" });

		new Setting(containerEl)
			.setName("Share active file path")
			.setDesc(
				"Include the currently open file's path in messages so the agent knows what you're working on.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.shareActiveFile)
					.onChange(async (value) => {
						this.plugin.settings.shareActiveFile = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Share selected text")
			.setDesc(
				"Include any text you've selected in the editor as additional context.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.shareSelection)
					.onChange(async (value) => {
						this.plugin.settings.shareSelection = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
