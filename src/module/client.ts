import { t, type MessageKey } from './i18n';
import { showDialog } from './popup';

interface OtherSession {
	ip: string | null;
	user_agent: string | null;
	origin: string | null;
	expires: string;
}

interface StatusResponse {
	authenticated: boolean;
	supported?: boolean;
	fresh?: boolean;
	conflict?: boolean;
	others?: OtherSession[];
	config?: {
		pollInterval?: number;
		loginUrl?: string | null;
		texts?: Record<string, string>;
	};
}

interface FetchResult {
	ok: boolean;
	status: number;
	data: unknown;
}

const state = {
	pollTimer: null as number | null,
	pollInterval: 10_000,
	/** Custom destination for "back to login" / "go to login"; null = this instance's own login page. */
	loginUrl: null as string | null,
	/** Text overrides from SINGLE_SESSION_TEXT_* env vars. */
	texts: {} as Record<string, string>,
	/** The status endpoint confirmed a live session at least once since the last (re)hydrate. */
	confirmed: false,
	lastConfirmedAt: 0,
	promptOpen: false,
	listenersInstalled: false,
};

/**
 * Called by the module's `preRegisterCheck`, which the Data Studio runs every time it hydrates:
 * right after a login and on every full page load with a valid session.
 */
export function onHydrated(): void {
	installListeners();
	stopPolling();

	state.confirmed = false;
	state.lastConfirmedAt = 0;

	// `hydrate()` runs before the router leaves the login page, so the URL still says where we came from.
	const cameFromLogin = isLoginPage();

	void runCheck({ clientFresh: cameFromLogin }).finally(schedulePoll);
}

async function runCheck(options: { clientFresh: boolean }): Promise<void> {
	if (state.promptOpen) return;

	let result: FetchResult;

	try {
		result = await request('GET', '/status');
	} catch {
		return; // network hiccup, try again on the next tick
	}

	if (result.status === 401 || result.status === 403) {
		handleSessionLost();
		return;
	}

	if (!result.ok || !result.data || typeof result.data !== 'object') return;

	const status = result.data as StatusResponse;

	if (!status.authenticated) {
		handleSessionLost();
		return;
	}

	state.confirmed = true;
	state.lastConfirmedAt = Date.now();

	if (status.config?.pollInterval) state.pollInterval = Math.max(2_000, status.config.pollInterval);
	if (status.config) state.loginUrl = status.config.loginUrl ?? null;
	if (status.config?.texts) state.texts = status.config.texts;

	if (status.supported && status.conflict && (status.fresh || options.clientFresh)) {
		promptConflict(status.others ?? []);
	}
}

/** The API stopped recognising our session: either we were kicked, or the user simply signed out. */
function handleSessionLost(): void {
	stopPolling();

	if (!state.confirmed) return;
	state.confirmed = false;

	// Only claim "kicked" when the session was verified alive a moment ago. A tab that was hidden
	// for days and whose session merely expired gets the regular "session expired" notice instead.
	const recentlyAlive = Date.now() - state.lastConfirmedAt < state.pollInterval * 3 + 30_000;
	if (!recentlyAlive || isVoluntaryLogout()) return;

	// Give the app a moment to navigate to /logout or /login?reason=SIGN_OUT if this was a manual sign-out.
	window.setTimeout(() => {
		if (isVoluntaryLogout()) return;
		promptKicked();
	}, 1_500);
}

function text(key: MessageKey, params?: Record<string, string | number>): string {
	return t(key, params, state.texts);
}

function promptConflict(others: OtherSession[]): void {
	state.promptOpen = true;

	const handle = showDialog({
		title: text('conflictTitle'),
		body: text('conflictBody', { n: Math.max(1, others.length) }),
		hint: text('conflictHint'),
		items: others.map(describeSession),
		busyLabel: text('working'),
		errorLabel: text('error'),
		actions: [
			{
				label: text('kick'),
				kind: 'primary',
				run: async () => {
					const result = await request('POST', '/kick');
					if (!result.ok) throw new Error(`kick failed with ${result.status}`);

					state.promptOpen = false;
					handle.close();
				},
			},
			{
				label: text('back'),
				kind: 'secondary',
				run: async () => {
					await request('POST', '/dismiss').catch(() => undefined);
					stopPolling();

					if (state.loginUrl) {
						// Custom destination: end this session ourselves, then leave.
						await signOut();
						window.location.assign(state.loginUrl);
						return;
					}

					// Default: let the Data Studio run its own sign-out flow, which ends on its login page.
					window.location.assign(`${rootPath()}admin/logout`);
				},
			},
		],
	});
}

function promptKicked(): void {
	state.promptOpen = true;

	const handle = showDialog({
		title: text('kickedTitle'),
		body: text('kickedBody'),
		busyLabel: text('working'),
		errorLabel: text('error'),
		actions: [
			{
				label: text('toLogin'),
				kind: 'primary',
				run: () => {
					state.promptOpen = false;
					handle.close();

					if (state.loginUrl) {
						window.location.assign(state.loginUrl);
						return;
					}

					if (!isLoginPage()) window.location.assign(`${rootPath()}admin/login?reason=SESSION_EXPIRED`);
				},
			},
		],
	});
}

/** Terminate the current session server-side (clears the session cookie). Errors are ignored: the
 *  session may already be gone, and the browser is about to navigate away anyway. */
async function signOut(): Promise<void> {
	try {
		await fetch(`${rootPath()}auth/logout`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'session' }),
		});
	} catch {
		// ignore
	}
}

function schedulePoll(): void {
	stopPolling();
	if (!state.confirmed) return;
	state.pollTimer = window.setTimeout(tick, state.pollInterval);
}

async function tick(): Promise<void> {
	state.pollTimer = null;

	// Do not hammer the API from background tabs; a visibility change triggers an immediate check.
	if (document.visibilityState !== 'hidden') {
		await runCheck({ clientFresh: false });
	}

	schedulePoll();
}

function stopPolling(): void {
	if (state.pollTimer !== null) {
		window.clearTimeout(state.pollTimer);
		state.pollTimer = null;
	}
}

function installListeners(): void {
	if (state.listenersInstalled) return;
	state.listenersInstalled = true;

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && state.confirmed && !state.promptOpen) {
			void runCheck({ clientFresh: false }).finally(schedulePoll);
		}
	});
}

async function request(method: 'GET' | 'POST', path: string): Promise<FetchResult> {
	const response = await fetch(`${rootPath()}single-session${path}`, {
		method,
		credentials: 'include',
		cache: 'no-store',
		headers: { Accept: 'application/json' },
	});

	let data: unknown = null;

	try {
		data = await response.json();
	} catch {
		// non-JSON body (e.g. proxy error page)
	}

	return { ok: response.ok, status: response.status, data };
}

/** Public root of this Directus instance, e.g. "/" or "/directus/" when served under a sub path. */
function rootPath(): string {
	const path = window.location.pathname;
	const index = path.indexOf('/admin');
	return index >= 0 ? path.slice(0, index + 1) : '/';
}

function isLoginPage(): boolean {
	return /\/admin\/login\/?$/.test(window.location.pathname);
}

function isVoluntaryLogout(): boolean {
	return /\/admin\/logout\/?$/.test(window.location.pathname) || /[?&]reason=SIGN_OUT(&|$)/.test(window.location.search);
}

function describeSession(session: OtherSession): string {
	return [session.ip || text('unknown'), describeUserAgent(session.user_agent)].join(' · ');
}

function describeUserAgent(userAgent: string | null): string {
	if (!userAgent) return text('unknown');

	const browser = /Edg\//.test(userAgent)
		? 'Edge'
		: /OPR\//.test(userAgent)
			? 'Opera'
			: /Firefox\//.test(userAgent)
				? 'Firefox'
				: /Chrome\//.test(userAgent)
					? 'Chrome'
					: /Safari\//.test(userAgent)
						? 'Safari'
						: null;

	const os = /Windows/.test(userAgent)
		? 'Windows'
		: /Android/.test(userAgent)
			? 'Android'
			: /iPhone|iPad/.test(userAgent)
				? 'iOS'
				: /Mac OS/.test(userAgent)
					? 'macOS'
					: /Linux/.test(userAgent)
						? 'Linux'
						: null;

	if (!browser && !os) return userAgent.length > 60 ? `${userAgent.slice(0, 57)}…` : userAgent;
	if (browser && os) return `${browser} ${text('on')} ${os}`;
	return browser ?? os ?? text('unknown');
}
