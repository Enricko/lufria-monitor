# Compact message spacing verification

## Cause and fix

The Markdown renderer emitted a `<br>` for every empty source line, including leading/trailing newlines around extracted tool cards. Those artificial lines plus a second padded bubble caused large empty regions. Blank lines now separate blocks without creating empty rows. Fenced-code whitespace is preserved.

Tool-only messages use their existing disclosure card without an additional padded outer bubble. The live `tool_done` path and legacy Bash conversion share `toolCard()`. Compatibility selectors still style cached tool output HTML. Empty output has a compact explicit label. Markdown `---` renders as a horizontal rule.

## Executed checks

The isolated synthetic fixture at `/tests/claude-agent.html?spacing` reproduced the failure before changes:

- Closed tool bubble heights: 238.97, 147.97, 190.28 px.
- Top insets: 113, 90.25, 67.5 px.
- Paragraph gap: 76.25 px.

After changes:

- Closed tool cards: 38 px on fine-pointer desktop; 46 px on touch with a 44px summary target.
- Top inset: 1 px.
- Paragraph gap: 6.39 px.
- 11/11 spacing assertions passed, including code blank lines/indentation and expandable output.
- Existing single-agent chat harness: 14/14 assertions passed.
- Widths 320/375/390/768/1440: spacing checks passed, no page or chat-container horizontal overflow, composer visible.
- Native summary keyboard activation passed using Enter; touch target and reduced-motion preference exercised.
- JavaScript error/unhandled rejection arrays empty in the harness.

These are tests of real React components with explicitly synthetic message/API/WebSocket fixtures, not evidence of a live model call. No authentication changes or bypasses.

## Deployment

Production TypeScript/Vite build passed; existing >500kB application chunk advisory remains. `git diff --check` clean. Live index/JS/CSS fetched from port 8090 match the production build byte-for-byte. Monitor service remained active without restart.

Changed production files: `frontend/src/pages/Claude.tsx`, `frontend/src/index.css`. Tests: `frontend/tests/claude-spacing-cases.ts` and the existing harness.

Pre-edit snapshot (ephemeral): `/root/.hermes/cache/scratch/monitor-spacing-20261024-163101/`.

Artifacts in this folder include before/after JSON, viewport measurements, chat regression results, keyboard proof and screenshots. No commit/push performed; unrelated pre-existing work preserved.
