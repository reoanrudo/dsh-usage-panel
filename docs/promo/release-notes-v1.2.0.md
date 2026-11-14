# dsh-usage-panel v1.2.0

First public release.

## Highlights

- **One popup for all your AI coding subscriptions** in DeepSeek Harness: GLM (Z.AI), opencode go, Codex (ChatGPT), Claude, DeepSeek, Command Code.
- **Spend quota resets from the panel** — GLM coding-plan resets (5-hour / weekly) and Codex reset credits, with a two-step confirm. Claude reset credits shown read-only.
- **Peak-hour clock** for time-of-day-priced models (GLM, DeepSeek): 24h band, current time marker, exact start/end in your local timezone.
- **Drag to reorder** cards; the order persists in localStorage. Header button resets to default.
- **Stale-while-revalidate** — the panel opens instantly on the last snapshot, refreshes underneath. Polling pauses when hidden.
- **Local-only credentials** — tokens stay in the host process; the browser side never sees them. Reset POSTs require a custom header + allow-listed Origin.
- **CLI**: `node usage.mjs` / `node usage.mjs --json`.
- Zero dependencies, Node.js 18+.

## Install

DSH → Plugins → Add plugin → Install a third-party plugin → select this repo's `bundle` folder.

```
dsh plugin --profile web add ./dsh-usage-panel/bundle
```
