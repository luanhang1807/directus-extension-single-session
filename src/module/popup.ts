/**
 * A tiny dependency-free modal. It is mounted straight onto <body>, outside the Vue tree, so it
 * keeps showing across Data Studio route changes and does not depend on internal components.
 * Colours come from the active Directus theme through CSS variables, with sane fallbacks.
 *
 * Interaction is handled in the capture phase on `window`. Directus dialogs (for instance the
 * licence prompt shown on first start) install a focus trap on `document` that cancels every
 * click outside their own container; `window` capture listeners run before those, so the popup
 * stays usable even when it is shown on top of such a dialog.
 */
export interface DialogAction {
	label: string;
	kind: 'primary' | 'secondary';
	/** Throwing (or rejecting) keeps the dialog open and shows `errorLabel`. */
	run: () => Promise<void> | void;
}

export interface DialogOptions {
	title: string;
	body: string;
	hint?: string;
	items?: string[];
	actions: DialogAction[];
	busyLabel: string;
	errorLabel: string;
}

export interface DialogHandle {
	close: () => void;
}

const STYLE_ID = 'directus-single-session-style';
const CSS = `
.dss-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);font-family:var(--theme--fonts--sans--font-family,Inter,system-ui,sans-serif);font-size:14px}
.dss-dialog{box-sizing:border-box;width:min(540px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--theme--background,#fff);color:var(--theme--foreground,#21262e);border-radius:var(--theme--border-radius,6px);box-shadow:0 8px 32px rgba(0,0,0,.28);padding:28px}
.dss-title{margin:0 0 12px;font-size:20px;font-weight:700;line-height:1.3}
.dss-body{margin:0;line-height:1.55}
.dss-hint{margin:10px 0 0;line-height:1.55;color:var(--theme--foreground-subdued,#4f5464)}
.dss-list{margin:16px 0 0;padding:0;list-style:none;border:1px solid var(--theme--border-color-subdued,#e4eaf1);border-radius:var(--theme--border-radius,6px);overflow:hidden}
.dss-list li{display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:13px;background:var(--theme--background-subdued,#f7fafc)}
.dss-list li+li{border-top:1px solid var(--theme--border-color-subdued,#e4eaf1)}
.dss-list li::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--theme--warning,#ffa439)}
.dss-error{margin:14px 0 0;color:var(--theme--danger,#e35169);font-size:13px}
.dss-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:24px}
.dss-btn{min-height:44px;padding:0 20px;border:none;border-radius:var(--theme--border-radius,6px);cursor:pointer;font:inherit;font-weight:600;transition:opacity .15s}
.dss-btn:hover{opacity:.88}
.dss-btn:focus-visible{outline:2px solid var(--theme--primary,#6644ff);outline-offset:2px}
.dss-btn[disabled]{opacity:.55;cursor:default}
.dss-btn-primary{background:var(--theme--primary,#6644ff);color:#fff}
.dss-btn-secondary{background:var(--theme--background-normal,#eef2f7);color:var(--theme--foreground,#21262e)}
`;

/** Events that must not leak to the app while the dialog is open. */
const SHIELDED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'focusin', 'keydown', 'keyup'];

let current: DialogHandle | null = null;

function ensureStyle(): void {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function showDialog(options: DialogOptions): DialogHandle {
	ensureStyle();
	current?.close();

	const overlay = el('div', 'dss-overlay');
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');

	const dialog = el('div', 'dss-dialog');
	dialog.appendChild(el('h2', 'dss-title', options.title));
	dialog.appendChild(el('p', 'dss-body', options.body));

	if (options.hint) dialog.appendChild(el('p', 'dss-hint', options.hint));

	if (options.items && options.items.length > 0) {
		const list = el('ul', 'dss-list');
		for (const item of options.items) list.appendChild(el('li', undefined, item));
		dialog.appendChild(list);
	}

	const error = el('p', 'dss-error');
	error.hidden = true;
	dialog.appendChild(error);

	const actions = el('div', 'dss-actions');
	const buttons = new Map<HTMLButtonElement, DialogAction>();

	for (const action of options.actions) {
		const button = el('button', `dss-btn dss-btn-${action.kind}`, action.label);
		button.type = 'button';
		buttons.set(button, action);
		actions.appendChild(button);
	}

	dialog.appendChild(actions);
	overlay.appendChild(dialog);

	let busy = false;

	async function activate(button: HTMLButtonElement, action: DialogAction): Promise<void> {
		if (busy || button.disabled) return;
		busy = true;

		error.hidden = true;
		for (const other of buttons.keys()) other.disabled = true;
		button.textContent = options.busyLabel;

		try {
			await action.run();
		} catch {
			error.textContent = options.errorLabel;
			error.hidden = false;
			button.textContent = action.label;
			for (const other of buttons.keys()) other.disabled = false;
		} finally {
			busy = false;
		}
	}

	function shield(event: Event): void {
		const target = event.target as Node | null;
		const inside = target !== null && overlay.contains(target);

		if (event.type.startsWith('key')) {
			// Keep app shortcuts and foreign focus traps out of the way while the dialog is open.
			event.stopPropagation();
			return;
		}

		if (!inside) {
			// Clicking the backdrop does nothing, and nothing underneath may react to it either.
			event.stopPropagation();
			event.preventDefault();
			return;
		}

		event.stopPropagation();

		if (event.type === 'click') {
			const button = (target as Element).closest?.('.dss-btn') as HTMLButtonElement | null;
			const action = button ? buttons.get(button) : undefined;
			if (button && action) void activate(button, action);
		}
	}

	for (const type of SHIELDED_EVENTS) window.addEventListener(type, shield, true);

	document.body.appendChild(overlay);
	buttons.keys().next().value?.focus();

	const handle: DialogHandle = {
		close: () => {
			for (const type of SHIELDED_EVENTS) window.removeEventListener(type, shield, true);
			overlay.remove();
			if (current === handle) current = null;
		},
	};

	current = handle;
	return handle;
}
