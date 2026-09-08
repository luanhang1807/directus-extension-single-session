import { defineModule } from '@directus/extensions-sdk';
import { onHydrated } from './client';

/**
 * This module has no pages of its own. It exists so its `preRegisterCheck` runs every time the
 * Data Studio hydrates (after a login and on every full page load), which is where the
 * concurrent-session watcher is (re)started.
 */
export default defineModule({
	id: 'single-session',
	name: 'Single session',
	icon: 'devices',
	hidden: true,
	routes: [],
	preRegisterCheck: () => {
		try {
			onHydrated();
		} catch (error) {
			// eslint-disable-next-line no-console
			console.warn('[single-session] failed to start the session watcher', error);
		}

		return true;
	},
});
