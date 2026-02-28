/**
 * Device identity management for OpenClaw gateway device pairing.
 *
 * Each plugin installation has a unique Ed25519 keypair that identifies it.
 * The deviceId is the SHA-256 hex fingerprint of the raw 32-byte public key.
 * The gateway uses this to track paired devices and issue device tokens.
 */

import * as ed from "@noble/ed25519"

// ── Helpers ──────────────────────────────────────────────────────

/** Base64url encode bytes (no padding) */
function base64UrlEncode(bytes: Uint8Array): string {
	let binary = ""
	for (const b of bytes) binary += String.fromCharCode(b)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/** Base64url decode to bytes */
function base64UrlDecode(str: string): Uint8Array {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4)
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/** Hex encode bytes */
function hexEncode(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

/** SHA-256 hash via Web Crypto */
async function sha256Hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer)
	return hexEncode(new Uint8Array(hash))
}

// ── Device Identity Types ────────────────────────────────────────

/** Serialized device identity (stored in plugin settings) */
export interface DeviceIdentityData {
	version: 1;
	deviceId: string;
	/** Base64url-encoded raw 32-byte public key */
	publicKey: string;
	/** Base64url-encoded raw 32-byte private key (secret seed) */
	privateKey: string;
	createdAtMs: number;
}

/** Device auth token issued by gateway after successful pairing */
export interface DeviceAuthToken {
	token: string;
	role: string;
	scopes: string[];
	updatedAtMs: number;
}

/** Pairing status */
export type DevicePairingStatus = "unpaired" | "pending" | "paired";

// ── Key Generation ───────────────────────────────────────────────

/**
 * Generate a new Ed25519 device identity.
 * Returns serializable data suitable for plugin settings.
 */
export async function generateDeviceIdentity(): Promise<DeviceIdentityData> {
	// noble/ed25519 v2: randomSecretKey() returns 32-byte seed
	const privateKeyBytes = ed.utils.randomSecretKey()
	const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes)
	const deviceId = await sha256Hex(publicKeyBytes)

	return {
		version: 1,
		deviceId,
		publicKey: base64UrlEncode(publicKeyBytes),
		privateKey: base64UrlEncode(privateKeyBytes),
		createdAtMs: Date.now(),
	}
}

/**
 * Validate and optionally repair a stored identity.
 * Re-derives the deviceId from the public key to ensure consistency.
 */
export async function validateDeviceIdentity(
	data: DeviceIdentityData,
): Promise<DeviceIdentityData> {
	const pubBytes = base64UrlDecode(data.publicKey)
	const derivedId = await sha256Hex(pubBytes)

	if (derivedId !== data.deviceId) {
		console.warn(
			"[OpenClaw] Device ID mismatch — re-derived from public key",
		)
		return { ...data, deviceId: derivedId }
	}

	return data
}

// ── Signing ──────────────────────────────────────────────────────

/**
 * Build the device auth payload string that gets signed during WS connect.
 *
 * Format: v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
 */
export function buildDeviceAuthPayload(params: {
	deviceId: string;
	clientId: string;
	clientMode: string;
	role: string;
	scopes: string[];
	signedAtMs: number;
	token: string | null;
	nonce: string;
}): string {
	const scopes = params.scopes.join(",")
	const token = params.token ?? ""
	return [
		"v2",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce,
	].join("|")
}

/**
 * Sign a payload string with the device's Ed25519 private key.
 * Returns base64url-encoded signature.
 */
export async function signPayload(
	privateKeyBase64Url: string,
	payload: string,
): Promise<string> {
	const privateKeyBytes = base64UrlDecode(privateKeyBase64Url)
	const messageBytes = new TextEncoder().encode(payload)
	const signature = await ed.signAsync(messageBytes, privateKeyBytes)
	return base64UrlEncode(signature)
}
