import { defineEndpoint } from '@directus/extensions-sdk';
import type { Accountability } from '@directus/types';
import type { Request as ExpressRequest, Response } from 'express';
import { readConfig } from '../shared/config.js';
import { clearFresh, findFresh } from '../shared/fresh-sessions.js';

interface SessionRow {
	token: string;
	user: string | null;
	expires: Date | string;
	ip: string | null;
	user_agent: string | null;
	origin: string | null;
	share?: string | null;
	next_token?: string | null;
	oauth_client?: string | null;
}

interface SessionContext {
	userId: string;
	/** Session token of the request (null for static tokens, which have no session). */
	token: string | null;
	/** Every token that belongs to the caller's own session, including rotation predecessors. */
	chain: Set<string>;
	/** Active sessions of the same user that are NOT the caller's. */
	others: SessionRow[];
}

/** Express request as seen inside Directus: the auth middleware attaches accountability and the raw token. */
type Request = ExpressRequest & {
	accountability?: Accountability | null;
	token?: string | null;
};

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Routes (all relative to /single-session):
 *
 *  GET  /status   - is the caller logged in elsewhere, and is its own session brand new?
 *  POST /kick     - terminate every other session of the caller's user
 *  POST /dismiss  - acknowledge the prompt without kicking (caller will log itself out)
 */
export default defineEndpoint({
	id: 'single-session',
	handler: (router, { database, env, logger }) => {
		const config = readConfig(env as Record<string, unknown>);
		const publicConfig = {
			pollInterval: config.pollInterval,
			loginUrl: config.loginUrl,
			texts: config.texts,
		};

		const wrap = (handler: Handler) => (req: Request, res: Response) => {
			handler(req, res).catch((error: unknown) => {
				logger.error(error, '[single-session] request failed');
				if (!res.headersSent) res.status(500).json({ errors: [{ message: 'Single session check failed' }] });
			});
		};

		router.get(
			'/status',
			wrap(async (req, res) => {
				const ctx = await loadContext(req);

				if (!ctx) {
					res.json({ authenticated: false });
					return;
				}

				if (!ctx.token) {
					res.json({
						authenticated: true,
						supported: false,
						fresh: false,
						conflict: false,
						others: [],
						config: publicConfig,
					});

					return;
				}

				// "Fresh" means no status check has been made for this session yet. It is consumed right
				// here so that an already running device is never prompted when a *later* login shows up.
				const fresh = findFresh(ctx.chain, config.freshTtl) !== undefined;
				clearFresh(ctx.chain);

				res.json({
					authenticated: true,
					supported: true,
					fresh,
					conflict: ctx.others.length > 0,
					others: describeOthers(ctx.others),
					config: publicConfig,
				});
			}),
		);

		router.post(
			'/kick',
			wrap(async (req, res) => {
				const ctx = await loadContext(req);

				if (!ctx || !ctx.token) {
					res.status(401).json({ errors: [{ message: 'A session is required' }] });
					return;
				}

				const kicked = await database('directus_sessions')
					.where('user', ctx.userId)
					.whereNotIn('token', [...ctx.chain])
					.delete();

				clearFresh(ctx.chain);
				logger.info(`[single-session] user ${ctx.userId} terminated ${kicked} other session(s)`);

				res.json({ kicked });
			}),
		);

		router.post(
			'/dismiss',
			wrap(async (req, res) => {
				const ctx = await loadContext(req);
				if (ctx) clearFresh(ctx.chain);
				res.json({ ok: true });
			}),
		);

		async function loadContext(req: Request): Promise<SessionContext | null> {
			const userId = req.accountability?.user;
			if (!userId) return null;

			const token = currentSessionToken(req);
			if (!token) return { userId, token: null, chain: new Set(), others: [] };

			const rows = await database<SessionRow>('directus_sessions')
				.select('*')
				.where('user', userId)
				.andWhere('expires', '>=', new Date());

			const chain = resolveChain(token, rows);
			const others = rows.filter((row) => !chain.has(row.token) && !row.share && !row.oauth_client);

			return { userId, token, chain, others };
		}
	},
});

/**
 * Directus >= 11 keeps the previous session row alive for a short grace period after a refresh
 * and links it to the new one through `next_token`. All rows on that chain are the caller's own
 * session and must never be treated as a concurrent login.
 */
function resolveChain(token: string, rows: SessionRow[]): Set<string> {
	const chain = new Set<string>([token]);
	let grew = true;

	while (grew) {
		grew = false;

		for (const row of rows) {
			const next = row.next_token ?? null;
			if (!next) continue;

			if (chain.has(row.token) && !chain.has(next)) {
				chain.add(next);
				grew = true;
			}

			if (chain.has(next) && !chain.has(row.token)) {
				chain.add(row.token);
				grew = true;
			}
		}
	}

	return chain;
}

function currentSessionToken(req: Request): string | null {
	const fromAccountability = req.accountability?.session;
	if (typeof fromAccountability === 'string' && fromAccountability) return fromAccountability;

	// Older hosts do not expose the session on accountability; read the (already verified) JWT.
	const raw = req.token;
	if (typeof raw !== 'string') return null;

	const parts = raw.split('.');
	if (parts.length !== 3) return null;

	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
		return typeof payload['session'] === 'string' ? (payload['session'] as string) : null;
	} catch {
		return null;
	}
}

/** Collapse rotation chains of other sessions so each device shows up once. */
function describeOthers(rows: SessionRow[]) {
	const tokens = new Set(rows.map((row) => row.token));

	return rows
		.filter((row) => !(row.next_token && tokens.has(row.next_token)))
		.sort((a, b) => new Date(b.expires).getTime() - new Date(a.expires).getTime())
		.map((row) => ({
			ip: row.ip,
			user_agent: row.user_agent,
			origin: row.origin,
			expires: new Date(row.expires).toISOString(),
		}));
}
