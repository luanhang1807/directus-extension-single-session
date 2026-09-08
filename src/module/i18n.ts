export interface Messages {
	conflictTitle: string;
	conflictBody: string;
	conflictHint: string;
	kick: string;
	back: string;
	kickedTitle: string;
	kickedBody: string;
	toLogin: string;
	working: string;
	error: string;
	unknown: string;
	on: string;
}

export type MessageKey = keyof Messages;

const messages: Messages = {
	conflictTitle: 'This account is already signed in elsewhere',
	conflictBody: 'This account is currently signed in on {n} other device(s).',
	conflictHint:
		'You can sign the other device out and continue here, or go back to the login page and leave the other session untouched.',
	kick: 'Sign out the other device and continue',
	back: 'Back to login',
	kickedTitle: 'Your session has ended',
	kickedBody: 'This account was just signed in on another device, so this session has been signed out.',
	toLogin: 'Go to login',
	working: 'Working…',
	error: 'Something went wrong, please try again.',
	unknown: 'unknown',
	on: 'on',
};

/**
 * Resolve a message: override from a SINGLE_SESSION_TEXT_* environment variable first, then the
 * built-in wording. `{name}` placeholders are filled from `params` in both cases.
 */
export function t(key: MessageKey, params: Record<string, string | number> = {}, overrides: Record<string, string> = {}): string {
	let text = overrides[key] ?? messages[key];

	for (const [name, value] of Object.entries(params)) {
		text = text.replaceAll(`{${name}}`, String(value));
	}

	return text;
}
