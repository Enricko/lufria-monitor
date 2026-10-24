# Claude Code single-agent UI verification

## Implemented scope

- Removed All / Claude Code / 9Router source tabs and per-source colors.
- Added a searchable unified session list and a single Claude Code workspace header.
- Preserved dynamic model selection; model catalog still uses `/api/router/models` as infrastructure.
- All active chat traffic uses `/ws/claude`. Historical router sessions remain readable and deletable through their existing APIs but cannot send messages.
- Old `chat.engine=router` browser preference is ignored; no old router WebSocket is opened.
- Restored actual session model on selection and refresh.
- Prevented `system/init` from enabling the composer while a turn is running.
- Replaced fixed mobile header subtraction with viewport-height flex layout.
- Added 44px primary touch targets, safe-area composer padding, search labels, keyboard session selection, and focused/Escape-dismissable usage dialog.

## Executed verification

Production `npm run build`: passed (TypeScript + Vite). Vite retains its application chunk-size advisory (>500kB), not a build failure.

`git diff --check`: clean.

The local component harness first reproduced the legacy provider tabs, two chat sockets, restored router engine, incorrect session model, and premature composer unlocking. After changes, **14/14 assertions passed**. See `regression.json`.

The real Claude and Shell React components were rendered in a loopback Vite server with explicit test API/WebSocket fixtures. Viewports **320, 375, 390, 768, 1440px** passed page overflow, composer visibility, 44px send target, focused usage dialog, and Escape dismissal checks. A 390x500 resized viewport kept the composer visible. Reduced-motion media preference was exercised. Captured JavaScript error/unhandled rejection arrays were empty. See `responsive-final.json` and the PNGs. These fixtures are not live model or backend response evidence.

The live service's index, JavaScript and CSS were fetched from `http://127.0.0.1:8090` and compared byte-for-byte with the production build. Service remained active. No service restart was needed, preserving terminal processes.

Live authenticated chat was not exercised: the public dashboard requires the owner's passkey, and no saved browser login was available. Authentication was not changed or bypassed. Existing backend chat integration was not modified.

## Re-run

From `frontend/`, start a temporary development server bound to loopback:

```sh
npm run dev -- --host 127.0.0.1 --port 8897 --strictPort
```

Open `/tests/claude-agent.html?test&restore&legacy` and read `window.__qa` for the assertions. Open `/tests/claude-agent.html?shell` for full-layout responsive checks. Harness files are not imported by the production entry point and are not part of Vite's built assets. Stop the temporary dev server after QA.

## Source and deployment

Files changed: `frontend/src/pages/Claude.tsx`, `frontend/src/components/Shell.tsx`, `frontend/src/index.css`; isolated regression harness in `frontend/tests/`.

Pre-edit source/dist snapshot: `/root/.hermes/cache/scratch/monitor-ui-20261024-160937/` (ephemeral recovery copy).

Existing unrelated dirty/untracked files were preserved. No commit/push or authentication changes were made.
