# Directus Single Session

Allow **only one active Data Studio session per user**, Sitefinity style.

When a user who is already signed in on device A signs in again on device B, device B gets a blocking dialog:

> **This account is already signed in elsewhere**
> This account is currently signed in on 1 other device(s).
>
> `127.0.0.1 · Chrome on Windows`
>
> **[ Sign out the other device and continue ]** **[ Back to login ]**

- **Sign out the other device and continue** terminates every other session of that user. Device A is signed out immediately and shown a "Your session has ended" notice with a button back to the login page.
- **Back to login** signs device B out again and leaves device A untouched.

Nothing else in Directus changes: no schema changes, no new collections, no permissions to configure.

## Requirements

- Directus **10.10 or newer** (the Data Studio must use session cookies). Tested on Directus 11 and 12.
- The extension ships as a bundle with an API part (hook + endpoint) and an app part (hidden module). The API part reads and deletes rows in `directus_sessions`, so it cannot run in the extension sandbox.

## Installation

### Marketplace

Because the API part is not sandboxed, the Marketplace only lists it when your instance allows non-sandboxed extensions:

```env
MARKETPLACE_TRUST=all
```

Then open **Settings → Marketplace**, search for `directus-extension-single-session` and install it.

### npm

```bash
npm install directus-extension-single-session
```

Restart Directus. The extension is picked up automatically from `node_modules`.

### Manual

Copy this folder (at least `package.json` and `dist/`) to `extensions/directus-extension-single-session/` inside your Directus project and restart Directus.

Nothing needs to be enabled in the module bar; the app part is a hidden module that only starts a background watcher.

## Configuration

All settings are environment variables and all of them are optional.

| Variable | Default | Description |
| --- | --- | --- |
| `SINGLE_SESSION_POLL_INTERVAL` | `10000` | How often (ms) an open Data Studio tab re-checks its session. Hidden tabs do not poll. Minimum `2000`. |
| `SINGLE_SESSION_FRESH_TTL` | `600000` | How long (ms) a brand-new login waits to be acknowledged by a Data Studio tab before it is treated as an ordinary running session. Normally consumed within a second of logging in. |
| `SINGLE_SESSION_LOGIN_URL` | own login page | Where **Back to login** and **Go to login** send the browser, e.g. `https://directus.example.com`. When set, the extension ends the current session through `/auth/logout` before navigating. When unset, the Data Studio's own sign-out flow runs and ends on `/admin/login`. |

### Custom dialog texts

Every string in both dialogs can be replaced with `SINGLE_SESSION_TEXT_<KEY>`. Unset keys keep the built-in English wording.

| KEY | Used for | Default |
| --- | --- | --- |
| `CONFLICT_TITLE` | Title of the concurrent-login dialog | This account is already signed in elsewhere |
| `CONFLICT_BODY` | Body; `{n}` is replaced with the number of other devices | This account is currently signed in on {n} other device(s). |
| `CONFLICT_HINT` | Secondary explanation line | You can sign the other device out and continue here, or go back to the login page and leave the other session untouched. |
| `KICK_BUTTON` | Primary button | Sign out the other device and continue |
| `BACK_BUTTON` | Secondary button | Back to login |
| `KICKED_TITLE` | Title of the dialog shown on the device that was signed out | Your session has ended |
| `KICKED_BODY` | Body of that dialog | This account was just signed in on another device, so this session has been signed out. |
| `KICKED_BUTTON` | Button of that dialog | Go to login |

Example:

```env
SINGLE_SESSION_LOGIN_URL=https://directus.example.com
SINGLE_SESSION_TEXT_BACK_BUTTON=Back to CMS home
SINGLE_SESSION_TEXT_CONFLICT_BODY=This user is already open on {n} other machine(s).
```

## How it works

| Entry | Type | Role |
| --- | --- | --- |
| `single-session-tracker` | hook | Listens to the `auth.jwt` filter and flags each session created by a login as *fresh*. The flag follows the session when Directus rotates the token on refresh. |
| `single-session` | endpoint | `GET /single-session/status`, `POST /single-session/kick`, `POST /single-session/dismiss`. |
| `single-session-watcher` | module (hidden) | Has no pages. Its `preRegisterCheck` runs every time the Data Studio hydrates (right after login and on every page load) and starts the watcher that polls the endpoint and renders the dialogs. |

1. A login inserts a row into `directus_sessions`. The hook marks that session token as *fresh* in the API process memory.
2. As soon as the Data Studio has hydrated, the watcher calls `GET /single-session/status`. The endpoint identifies the caller's session from `accountability.session`, groups it with rotation predecessors (`next_token`, Directus 11+), and counts the other non-expired sessions of the same user. Shares and OAuth-client sessions are ignored. The *fresh* flag is consumed by this first call, so a device that is already working is never prompted when someone else logs in later.
3. If other sessions exist **and** the caller's session is fresh (or the tab just came from the login page), the dialog is shown. The dialog is plain DOM appended to `<body>`, styled with the active theme's CSS variables, and handles input in the `window` capture phase so it stays usable even on top of Directus dialogs that install a focus trap.
4. **Sign out the other device** calls `POST /single-session/kick`, which deletes every `directus_sessions` row of the user except the caller's. Directus validates session cookies against the database on every request, so the other device receives `401` immediately. Its watcher notices that a session that was alive a moment ago is gone and shows the "Your session has ended" dialog.
5. **Back to login** calls `POST /single-session/dismiss` and then either runs the Data Studio's sign-out flow or, when `SINGLE_SESSION_LOGIN_URL` is set, calls `/auth/logout` and navigates to that URL.

### Endpoint reference

All routes require an authenticated session cookie. Static tokens have no session and get `supported: false`.

| Route | Response |
| --- | --- |
| `GET /single-session/status` | `{ authenticated, supported, fresh, conflict, others: [{ ip, user_agent, origin, expires }], config: { pollInterval, loginUrl, texts } }` |
| `POST /single-session/kick` | `{ kicked: <number of sessions deleted> }` |
| `POST /single-session/dismiss` | `{ ok: true }` |

## Limitations

- The *fresh* flag lives in the memory of each API process. Behind a load balancer with several API instances the flag may not be visible to the instance that answers `/status`; the client-side fallback ("this tab just came from the login page") still triggers the dialog for password, LDAP and SSO logins that land on the login page, but an SSO flow that lands directly inside the app could be missed.
- Only rows in `directus_sessions` count. Static tokens create no session and are unaffected. Sessions created through the API with `mode: json` or `mode: cookie` for the same user **do** count as another device and will be terminated by "Sign out the other device".
- This is a prompt-after-login model, like Sitefinity: the second session exists on the server until the user decides. It does not reject the login itself.
- On the device that gets signed out, the Data Studio may hit a `401` on its own request before the watcher polls and redirect to the login page with a "session expired" notice. The extension's dialog is still shown on top when it detects the loss in time.
- Dialog texts are English only (customisable through the `SINGLE_SESSION_TEXT_*` variables).

## Development

```bash
npm install
npm run build       # production build to dist/
npm run dev         # watch build, not minified
npm run typecheck   # tsc --noEmit
npm run validate    # directus-extension validate
```

```
src/
  shared/config.ts          environment variables
  shared/fresh-sessions.ts  in-memory registry of fresh sessions (shared by hook and endpoint)
  hook/index.ts             auth.jwt filter
  endpoint/index.ts         /single-session/*
  module/index.ts           hidden module, starts the watcher from preRegisterCheck
  module/client.ts          polling, conflict / kicked detection, dialog wiring
  module/popup.ts           dependency-free modal
  module/i18n.ts            default texts and override lookup
```

## License

MIT
