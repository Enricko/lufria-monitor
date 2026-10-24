# Provider-aware model picker and Settings

## Delivered

- Replaced native model select with a searchable, viewport-bounded dialog, collapsible provider groups, exact selected provider/model indicator, refresh and Manage providers.
- Preserved duplicate raw model IDs under different providers and exact identifiers including `default` and `claude`.
- Model changes apply to the next message in the same Claude Code conversation, not a second engine.
- Added AI Providers in Settings: add/edit, enabled state, optional password-only API key input, blank-edit preservation, per-provider/global refresh, errors and last refresh status, confirmed deletion. Keys are never returned by the public catalog.
- Added authenticated/same-origin provider CRUD routes and private atomic provider/cache persistence. Discovery refresh replaces successful snapshots (including empty results), retains last-good on failure, and does not follow redirects.
- Added canonical session binding hydration before Send, persisted backend model/provider binding, generation guards for late responses, and explicit native reset.
- Hardened chat WebSocket origin checks, refused silently sending an old credential to a different provider origin, and scrubbed the selected key from streamed CLI output.

## Verification

Backend unittest suite: **18/18 passed**, including CRUD, discovery cache/error semantics, exact routing, saved-session resume, key leakage prevention, changed-origin key protection, and cross-origin chat rejection. Starlette TestClient emits its existing httpx deprecation advisory; dependencies were not changed.

Real React browser fixtures (all explicitly synthetic API/WebSocket data, never live command results):

- Model picker: 17/17 checks passed.
- Provider Settings: 17/17 cases passed, including readback/discovery changes, single-provider scope and post-write focus.
- Chat: 15/15 checks passed.
- Message spacing: 11/11 checks passed.
- Binding-race scenarios: 33/33 checks passed across restore, canonical detail, manual selection, request ordering, restore error/retry and manual choice during restore.
- Responsive picker/Settings exercised at 320/375/390/768/1440px; long-list internal scroll, visible footer/search, no horizontal overflow, keyboard navigation/Escape and focus checks. Captured fixture error arrays empty.

Application TypeScript/Vite build passed. Vite retains a >500kB application chunk-size advisory. `git diff --check` clean.

## Activated production

The service was restarted after verifying no active Monitor descendant terminal/agent processes. New service PID recorded in `deployment.json`; service is active.

Live index/JS/CSS were read from port8090 and compared byte-for-byte to the release. Provider API routes were verified in the running OpenAPI schema, and unauthenticated provider/catalog requests returned401. Public domain browser loaded `/assets/index-DmSUEPQv.js` and `/assets/index-CsnKGAIz.css`.

Initialized discovery as the service user through the actual provider registry, then constructed a fresh registry and compared the persisted catalog. File mode0600 verified. Latest successful inventory: Binav47, Lufria59, OMO17, total123 provider/model pairs (79 distinct raw IDs). Earlier probe had a different Binav inventory; router catalogs can change and the refresh button fetches the current snapshot. See `persisted-discovery.json`.

Live authenticated chat and browser CRUD were not exercised because the public dashboard requires the owner's passkey. Auth was not bypassed and no session token was fabricated. CRUD/routing paths were exercised in isolated app tests; real external discovery was exercised with existing credential resolvers without exposing keys.

No commit/push performed. Existing dirty/untracked work and `.env` were preserved. Pre-edit source/dist snapshot: `/root/.hermes/cache/scratch/monitor-providers-20261024-164342/` (ephemeral).

## Re-run browser checks

Start a temporary loopback-only Vite server on a free port, then open:

- `/tests/claude-agent.html?picker` → `window.__picker`
- `/tests/provider-settings.html` → `window.providerSettingsTests`
- `/tests/claude-agent.html?test&restore&legacy` → `window.__qa`
- `/tests/claude-agent.html?spacing` → `window.__spacing`
- `/tests/claude-agent.html?binding-race=restore` (also canonical/manual/ordering/error/restore-manual) → `window.__bindingRaces`

Bring the browser tab to the foreground before awaiting asynchronous fixtures to avoid background timer throttling. These harness files are not production entry points. Stop the temporary server after QA.
