/**
 * In-process registry of "fresh" sessions.
 *
 * A session is fresh from the moment a login creates it until the Data Studio that owns it has
 * acknowledged the concurrent-login prompt (kick or dismiss). The hook entry writes to it, the
 * endpoint entry reads from it. Both entries live in the same bundle, but the map is parked on a
 * global symbol anyway so it survives any module duplication during bundling.
 *
 * Note: this is per API process. With several horizontally scaled API instances the prompt is
 * additionally triggered by the client-side "came from the login page" heuristic, see README.
 */
export interface FreshEntry {
	user: string | null;
	createdAt: number;
}

const STORE_KEY = Symbol.for('directus-extension-single-session:fresh-sessions');

function store(): Map<string, FreshEntry> {
	const globalRef = globalThis as unknown as Record<symbol, Map<string, FreshEntry> | undefined>;
	let map = globalRef[STORE_KEY];

	if (!map) {
		map = new Map<string, FreshEntry>();
		globalRef[STORE_KEY] = map;
	}

	return map;
}

export function markFresh(token: string, user: string | null): void {
	store().set(token, { user, createdAt: Date.now() });
}

/** Session tokens rotate on refresh; carry the fresh flag over to the new token. */
export function propagateFresh(fromToken: string, toToken: string): void {
	const entry = store().get(fromToken);
	if (entry) store().set(toToken, entry);
}

export function findFresh(tokens: Iterable<string>, ttlMs: number): FreshEntry | undefined {
	const now = Date.now();

	for (const token of tokens) {
		const entry = store().get(token);
		if (!entry) continue;

		if (now - entry.createdAt > ttlMs) {
			store().delete(token);
			continue;
		}

		return entry;
	}

	return undefined;
}

export function clearFresh(tokens: Iterable<string>): void {
	for (const token of tokens) store().delete(token);
}

export function purgeExpired(ttlMs: number): void {
	const now = Date.now();

	for (const [token, entry] of store()) {
		if (now - entry.createdAt > ttlMs) store().delete(token);
	}
}
