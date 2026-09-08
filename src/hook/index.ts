import { defineHook } from '@directus/extensions-sdk';
import { readConfig } from '../shared/config.js';
import { markFresh, propagateFresh, purgeExpired } from '../shared/fresh-sessions.js';

/**
 * Marks every newly created Data Studio session as "fresh" so the endpoint can tell a brand new
 * login apart from an already running one. `auth.jwt` fires for both logins and refreshes and
 * carries the session token in the JWT payload (session mode only, which is what the Data Studio
 * uses). On refresh the token rotates, so the flag is carried over from the previous token.
 */
export default defineHook(({ filter }, { env, logger }) => {
	const config = readConfig(env as Record<string, unknown>);

	filter('auth.jwt', (payload, meta, context) => {
		const claims = (payload ?? {}) as Record<string, unknown>;
		const session = typeof claims['session'] === 'string' ? (claims['session'] as string) : null;

		if (!session) return payload;

		if (meta['type'] === 'login') {
			const user =
				typeof meta['user'] === 'string'
					? (meta['user'] as string)
					: typeof claims['id'] === 'string'
						? (claims['id'] as string)
						: null;

			markFresh(session, user);
			logger.debug(`[single-session] new session for user ${user ?? 'unknown'}`);
		} else if (meta['type'] === 'refresh') {
			const previous = context.accountability?.session;
			if (previous && previous !== session) propagateFresh(previous, session);
		}

		return payload;
	});

	const timer = setInterval(() => purgeExpired(config.freshTtl), Math.min(config.freshTtl, 60_000));
	timer.unref?.();
});
