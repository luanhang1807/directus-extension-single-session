/**
 * Runtime configuration read from Directus environment variables.
 *
 *  SINGLE_SESSION_POLL_INTERVAL  ms between status polls of an open Data Studio tab   (default 10000)
 *  SINGLE_SESSION_FRESH_TTL      ms a login stays "fresh" (waiting to be acknowledged) (default 600000)
 *  SINGLE_SESSION_LOGIN_URL      where "back to login" / "go to login" send the browser  (default: this
 *                                instance's own login page, e.g. https://directus.example.com/admin/login)
 *
 *  Popup texts (SINGLE_SESSION_TEXT_<KEY>). Unset keys keep the built-in English wording.
 *
 *    CONFLICT_TITLE   CONFLICT_BODY ({n} = number of other devices)   CONFLICT_HINT
 *    KICK_BUTTON      BACK_BUTTON
 *    KICKED_TITLE     KICKED_BODY                                       KICKED_BUTTON
 */
export interface SingleSessionConfig {
	pollInterval: number;
	freshTtl: number;
	loginUrl: string | null;
	/** Text overrides keyed by message id. */
	texts: Record<string, string>;
}

const TEXT_KEYS: Record<string, string> = {
	CONFLICT_TITLE: 'conflictTitle',
	CONFLICT_BODY: 'conflictBody',
	CONFLICT_HINT: 'conflictHint',
	KICK_BUTTON: 'kick',
	BACK_BUTTON: 'back',
	KICKED_TITLE: 'kickedTitle',
	KICKED_BODY: 'kickedBody',
	KICKED_BUTTON: 'toLogin',
};

const TEXT_PREFIX = 'SINGLE_SESSION_TEXT_';

function readNumber(value: unknown, fallback: number, min: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.max(min, Math.floor(parsed));
}

function readString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function readTexts(env: Record<string, unknown>): Record<string, string> {
	const texts: Record<string, string> = {};

	for (const [name, raw] of Object.entries(env)) {
		if (!name.startsWith(TEXT_PREFIX)) continue;

		const value = readString(raw);
		const messageId = TEXT_KEYS[name.slice(TEXT_PREFIX.length)];
		if (!value || !messageId) continue;

		texts[messageId] = value;
	}

	return texts;
}

export function readConfig(env: Record<string, unknown>): SingleSessionConfig {
	return {
		pollInterval: readNumber(env['SINGLE_SESSION_POLL_INTERVAL'], 10_000, 2_000),
		freshTtl: readNumber(env['SINGLE_SESSION_FRESH_TTL'], 10 * 60 * 1000, 10_000),
		loginUrl: readString(env['SINGLE_SESSION_LOGIN_URL']),
		texts: readTexts(env),
	};
}
