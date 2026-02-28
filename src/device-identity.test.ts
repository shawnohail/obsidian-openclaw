import { describe, it, expect } from 'vitest'
import {
	generateDeviceIdentity,
	validateDeviceIdentity,
	buildDeviceAuthPayload,
	signPayload,
} from './device-identity'

describe('device-identity', () => {
	describe('generateDeviceIdentity', () => {
		it('should generate a valid device identity', async () => {
			const identity = await generateDeviceIdentity()

			expect(identity).toHaveProperty('deviceId')
			expect(identity).toHaveProperty('publicKey')
			expect(identity).toHaveProperty('privateKey')

			// Device ID should be a 64-char hex string (SHA-256)
			expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/)

			// Keys should be base64url-encoded (Ed25519 32-byte keys)
			expect(identity.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(identity.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
		})

		it('should generate unique identities', async () => {
			const id1 = await generateDeviceIdentity()
			const id2 = await generateDeviceIdentity()

			expect(id1.deviceId).not.toBe(id2.deviceId)
			expect(id1.publicKey).not.toBe(id2.publicKey)
			expect(id1.privateKey).not.toBe(id2.privateKey)
		})
	})

	describe('validateDeviceIdentity', () => {
		it('should return identity unchanged when deviceId matches derived', async () => {
			const identity = await generateDeviceIdentity()
			const validated = await validateDeviceIdentity(identity)

			expect(validated).toEqual(identity)
			expect(validated.deviceId).toBe(identity.deviceId)
		})

		it('should return repaired identity when deviceId does not match derived', async () => {
			const identity = await generateDeviceIdentity()
			const tampered = { ...identity, deviceId: '0'.repeat(64) }

			const validated = await validateDeviceIdentity(tampered)

			expect(validated.deviceId).toBe(identity.deviceId)
			expect(validated.deviceId).not.toBe(tampered.deviceId)
			expect(validated.publicKey).toBe(identity.publicKey)
			expect(validated.privateKey).toBe(identity.privateKey)
			expect(validated.createdAtMs).toBe(identity.createdAtMs)
		})
	})

	describe('buildDeviceAuthPayload', () => {
		it('should build a valid auth payload', () => {
			const payload = buildDeviceAuthPayload({
				deviceId: 'test-device-id',
				clientId: 'test-client',
				clientMode: 'webchat',
				role: 'operator',
				scopes: ['operator.write'],
				signedAtMs: 1234567890000,
				token: 'test-token',
				nonce: 'test-nonce',
			})

			expect(payload).toContain('test-device-id')
			expect(payload).toContain('test-client')
			expect(payload).toContain('webchat')
			expect(payload).toContain('operator')
			expect(payload).toContain('operator.write')
			expect(payload).toContain('1234567890000')
			expect(payload).toContain('test-token')
			expect(payload).toContain('test-nonce')
		})

		it('should handle null token', () => {
			const payload = buildDeviceAuthPayload({
				deviceId: 'test-device-id',
				clientId: 'test-client',
				clientMode: 'webchat',
				role: 'operator',
				scopes: ['operator.write'],
				signedAtMs: 1234567890000,
				token: null,
				nonce: 'test-nonce',
			})

			expect(payload).not.toContain('test-token')
			expect(payload).toContain('test-device-id')
		})

		it('should preserve scope order', () => {
			const payload1 = buildDeviceAuthPayload({
				deviceId: 'test-device-id',
				clientId: 'test-client',
				clientMode: 'webchat',
				role: 'operator',
				scopes: ['scope-b', 'scope-a'],
				signedAtMs: 1234567890000,
				token: 'test-token',
				nonce: 'test-nonce',
			})

			const payload2 = buildDeviceAuthPayload({
				deviceId: 'test-device-id',
				clientId: 'test-client',
				clientMode: 'webchat',
				role: 'operator',
				scopes: ['scope-a', 'scope-b'],
				signedAtMs: 1234567890000,
				token: 'test-token',
				nonce: 'test-nonce',
			})

			// Scopes are not sorted, order matters
			expect(payload1).not.toBe(payload2)
			expect(payload1).toContain('scope-b,scope-a')
			expect(payload2).toContain('scope-a,scope-b')
		})
	})

	describe('signPayload', () => {
		it('should sign a payload with Ed25519', async () => {
			const identity = await generateDeviceIdentity()
			const payload = 'test payload'

			const signature = await signPayload(identity.privateKey, payload)

			// Ed25519 signature should be base64url-encoded (64-byte signature)
			expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
		})

		it('should produce consistent signatures', async () => {
			const identity = await generateDeviceIdentity()
			const payload = 'test payload'

			const sig1 = await signPayload(identity.privateKey, payload)
			const sig2 = await signPayload(identity.privateKey, payload)

			expect(sig1).toBe(sig2)
		})

		it('should produce different signatures for different payloads', async () => {
			const identity = await generateDeviceIdentity()

			const sig1 = await signPayload(identity.privateKey, 'payload 1')
			const sig2 = await signPayload(identity.privateKey, 'payload 2')

			expect(sig1).not.toBe(sig2)
		})
	})
})
