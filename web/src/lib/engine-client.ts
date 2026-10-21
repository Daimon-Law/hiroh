// Loads Hiroh's WebAssembly module once and wraps its file transfer calls.

import type { RelayConfig } from './relay-config'

type EngineModule = typeof import('../wasm/pkg/hiroh_wasm.js')
type Listener = (payload: string | null) => void

const listeners = new Map<string, Set<Listener>>()
let loading: Promise<EngineModule> | null = null

/**
 * Listen for a transfer event: "send-started", "send-progress",
 * "send-done" or "receive-progress". Returns an unsubscribe function.
 */
export function onEngineEvent(name: string, listener: Listener): () => void {
	let set = listeners.get(name)
	if (!set) {
		set = new Set()
		listeners.set(name, set)
	}
	set.add(listener)
	return () => {
		set.delete(listener)
		if (set.size === 0) listeners.delete(name)
	}
}

async function load(): Promise<EngineModule> {
	const engine = await import('../wasm/pkg/hiroh_wasm.js')
	await engine.default()
	engine.files_on_event((name: string, payload?: string | null) => {
		for (const listener of listeners.get(name) ?? []) listener(payload ?? null)
	})
	return engine
}

/** The engine module, loaded on first use. A failed load is retried next time. */
export function loadEngine(): Promise<EngineModule> {
	loading ??= load().catch((error) => {
		loading = null
		throw error
	})
	return loading
}

const relayJson = (relay?: RelayConfig) =>
	relay ? JSON.stringify(relay) : undefined

/** Serve files until stopped. Returns the ticket the receiver needs. */
export async function shareFiles(
	names: string[],
	contents: Uint8Array[],
	relay?: RelayConfig
): Promise<string> {
	const engine = await loadEngine()
	return engine.files_share(names, contents, relayJson(relay))
}

export async function stopSharing(): Promise<void> {
	;(await loadEngine()).files_stop()
}

/** The names and sizes a ticket offers. Read from the ticket itself. */
export async function listFiles(
	ticket: string
): Promise<{ name: string; size: number }[]> {
	const engine = await loadEngine()
	return JSON.parse(engine.files_list(ticket))
}

/** Download everything a ticket offers into memory. */
export async function receiveFiles(
	ticket: string,
	relay?: RelayConfig
): Promise<{ fileNames: string[]; bytesList: Uint8Array[] }> {
	const engine = await loadEngine()
	const result = (await engine.files_receive(ticket, relayJson(relay))) as {
		names: string[]
		data: Uint8Array[]
	}
	return { fileNames: result.names, bytesList: result.data }
}

/** Hand bytes to the browser as a file download. */
export function saveToDevice(bytes: Uint8Array, fileName: string): void {
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
	const link = Object.assign(document.createElement('a'), {
		href: url,
		download: fileName,
	})
	link.style.display = 'none'
	document.body.append(link)
	link.click()
	link.remove()
	// Some browsers start the download after this returns; free it later.
	setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Transfer progress from the engine: "done:total" in bytes. */
export function readProgress(
	payload: string
): { done: number; total: number } | null {
	const parts = payload.split(':')
	if (parts.length !== 2) return null
	const [done, total] = parts.map(Number)
	if (!Number.isFinite(done) || !Number.isFinite(total)) return null
	return { done: done as number, total: total as number }
}
