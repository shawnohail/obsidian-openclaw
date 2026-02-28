/* eslint-disable obsidianmd/ui/sentence-case -- settings use technical labels and headings */
import { App, Notice, PluginSettingTab, Setting } from "obsidian"
import type OpenClawPlugin from "./main"
import { generateDeviceIdentity } from "./device-identity"

export class OpenClawSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: OpenClawPlugin,
	) {
		super(app, plugin)
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()

		containerEl.createEl("p", {
			text: "Connect Obsidian to your local OpenClaw gateway using WebSocket streaming for real-time responses.",
			cls: "setting-item-description",
		})

		// --- Connection ---
		new Setting(containerEl).setName("Connection").setHeading()

		new Setting(containerEl)
			.setName("Gateway URL")
			.setDesc(
				"Base URL of the OpenClaw gateway.",
			)
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:18789")
					.setValue(this.plugin.settings.gatewayUrl)
					.onChange((value) => {
						this.plugin.settings.gatewayUrl = value
						void this.plugin.saveSettings()
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("Test")
					.setCta()
					.onClick((): void => {
						/* eslint-disable @typescript-eslint/no-misused-promises -- fire-and-forget health check */
						button.setButtonText("Testing…")
						button.setDisabled(true)
						const p = this.plugin.client
							.healthCheck()
							.then((ok) => {
								button.setButtonText(ok ? "✓ Connected" : "✗ Failed")
								button.setDisabled(false)
								setTimeout(() => button.setButtonText("Test"), 2000)
							})
							.catch(() => {
								button.setButtonText("Test")
								button.setDisabled(false)
							})
						void p
						/* eslint-enable @typescript-eslint/no-misused-promises */
					}),
			)

		new Setting(containerEl)
			.setName("Gateway token")
			.setDesc(
				"Authentication token (OPENCLAW_GATEWAY_TOKEN).",
			)
			.addText((text) => {
				text.inputEl.type = "password"
				text.inputEl.addClass("openclaw-setting-input-full")
				return text
					.setPlaceholder("Enter your gateway token")
					.setValue(this.plugin.settings.gatewayToken)
					.onChange((value) => {
						this.plugin.settings.gatewayToken = value
						void this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Agent ID")
			.setDesc(
				"Which OpenClaw agent to chat with (e.g. 'main', 'beta'). Default: main.",
			)
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.agentId)
					.onChange((value) => {
						this.plugin.settings.agentId = value
						void this.plugin.saveSettings()
					}),
			)

		// --- Device Pairing ---
		new Setting(containerEl).setName("Device Pairing").setHeading()

		const identity = this.plugin.settings.deviceIdentity
		const pairingStatus = this.plugin.settings.devicePairingStatus

		// Device ID display
		if (identity) {
			new Setting(containerEl)
				.setName("Device ID")
				.setDesc("Unique identifier for this Obsidian installation.")
				.addText((text) => {
					text.inputEl.addClass("openclaw-setting-device-id")
					return text
						.setValue(identity.deviceId)
						.setDisabled(true)
				})
			.addButton((button) =>
				button.setButtonText("Regenerate").onClick(() => {
					void generateDeviceIdentity().then((identity) => {
						this.plugin.settings.deviceIdentity = identity
						this.plugin.settings.deviceAuthToken = null
						this.plugin.settings.devicePairingStatus = "unpaired"
						return this.plugin.saveSettings()
					}).then(() => {
						this.plugin.client.disconnectWebSocket()
						new Notice("New device identity generated. Re-pair to connect.")
						this.display()
					})
				}),
			)
		}

		// Pairing status
		const statusLabels: Record<string, string> = {
			unpaired: "⚪ Not paired",
			pending: "🟡 Pending approval",
			paired: "🟢 Paired",
		}

		const statusSetting = new Setting(containerEl)
			.setName("Pairing status")
			.setDesc(statusLabels[pairingStatus] ?? "Unknown")

		if (pairingStatus === "unpaired" || pairingStatus === "pending") {
			statusSetting.addButton((button) =>
				button
					.setButtonText(
						pairingStatus === "pending"
							? "Retry Connection"
							: "Pair Device",
					)
					.setCta()
					.onClick(() => {
						button.setButtonText("Connecting…")
						button.setDisabled(true)
						void (async () => {
							if (!this.plugin.settings.deviceIdentity) {
								this.plugin.settings.deviceIdentity =
									await generateDeviceIdentity()
								await this.plugin.saveSettings()
							}
							this.plugin.client.connectWebSocket()
							await new Promise((resolve) =>
								setTimeout(resolve, 3_000),
							)
							const newStatus =
								this.plugin.settings.devicePairingStatus
							if (newStatus === "paired") {
								new Notice("✅ Device paired successfully!")
							} else if (newStatus === "pending") {
								new Notice(
									"⏳ Pairing request sent. Approve on the gateway:\n  openclaw devices approve",
								)
							} else {
								new Notice(
									"Connection attempt completed. Check status.",
								)
							}
							button.setDisabled(false)
							this.display()
						})()
					}),
			)
		}

		if (pairingStatus === "paired") {
			statusSetting.addButton((button) =>
				button
					.setButtonText("Unpair Device")
					.setWarning()
					.onClick(() => {
						this.plugin.settings.deviceAuthToken = null
						this.plugin.settings.devicePairingStatus = "unpaired"
						void this.plugin.saveSettings().then(() => {
							this.plugin.client.disconnectWebSocket()
							new Notice("Device unpaired. You may need to re-pair.")
							this.display()
						})
					}),
			)
		}

		if (pairingStatus === "pending") {
			const pendingNote = containerEl.createDiv({
				cls: "setting-item-description openclaw-setting-description-nested",
			})
			const p = pendingNote.createEl("p")
			p.createSpan({ text: "This device is waiting for approval on the gateway host. Run " })
			p.createEl("code", { text: "openclaw devices approve" })
			p.createSpan({ text: " on the machine running the gateway, or approve in the OpenClaw Control UI under Nodes → Devices." })
		}


		// --- Context ---
		new Setting(containerEl).setName("Context Sharing").setHeading()

		new Setting(containerEl)
			.setName("Share active file path")
			.setDesc(
				"Include the currently open file's path in messages so the agent knows what you're working on.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.shareActiveFile)
					.onChange((value) => {
						this.plugin.settings.shareActiveFile = value
						void this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName("Share selected text")
			.setDesc(
				"Include any text you've selected in the editor as additional context.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.shareSelection)
					.onChange((value) => {
						this.plugin.settings.shareSelection = value
						void this.plugin.saveSettings()
					}),
			)
	}
}
