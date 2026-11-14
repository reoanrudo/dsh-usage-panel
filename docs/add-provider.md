# Adding a provider

Adding a new subscription (provider) to this panel takes three steps. Everything
lives in `src/fetchers.mjs` and `bundle/client.js` — the server contract (the
JSON shape served at `/api/usage`) does not change.

## 1. Write a fetcher (server side)

Add a function to `src/fetchers.mjs` that fetches the service's usage and
normalizes it into this shape:

```js
async function fetchMyService() {
  const base = { id: "myservice", name: "My Service", connected: false };
  const key = process.env.MY_SERVICE_KEY; // choose your own credential source
  if (!key) return base;                  // no credentials = not connected (hidden)
  const res = await fetch("https://api.example.com/v1/usage", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { ...base, connected: true, status: "error", error: `HTTP ${res.status}` };
  const j = await res.json();
  return {
    ...base,
    connected: true,
    status: "ok",
    plan: j.plan ?? null,                    // badge on the card header (optional)
    account: j.email ?? null,                // small account line (optional)
    balance: null,                           // balance-type: { amount, currency }
    windows: [
      { label: "5-hour window", percent: 42, resetAt: "11/20 09:00", detail: "limit 1,000 / left 580" },
      { label: "Weekly window", percent: 7,  resetAt: "11/24 00:00" },
    ],
  };
}
```

**Return contract**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | ✓ | Card key. Prefer `[a-z0-9-]` |
| `name` | string | ✓ | Card title |
| `connected` | boolean | ✓ | `false` hides the card entirely |
| `status` | `"ok" \| "error"` | – | `error` shows the `error` string in red |
| `plan` | string\|null | – | Plan badge |
| `account` | string\|null | – | Small account line under the title |
| `balance` | object\|null | – | `{ amount: "7.56", currency: "USD" }` for balance-type services |
| `windows` | array | – | `{ label, percent, resetAt, detail }`; `percent` is 0–100 |
| `resetCredits` | object | – | Quota-reset credits (see below) |

A fetcher that throws is caught by the server and shown as an `error` card, so
you can fail loudly — but returning `connected: false` when credentials are
missing is friendlier: the card simply disappears.

## 2. Register it in fetchAllSubscriptions

Append your fetcher to the `Promise.all` array in `fetchAllSubscriptions()`:

```js
const results = await Promise.all([
  fetchGlm(),
  fetchOpencodeGo(),
  fetchCodex(),
  fetchClaude(),
  fetchDeepseek(),
  fetchCommandcode(),
  fetchMyService(),   // ← add
  ...
]);
```

The array order is the **default card order**.

## 3. Add an icon (browser side)

`ICONS` in `bundle/client.js` maps service ids to data-URI icons (64px PNGs).
Adding `myservice` is optional — cards without an icon get an automatic
letter fallback:

```js
const ICONS = { ..., myservice: "data:image/png;base64,..." };
```

## Optional: quota resets

If the service grants usage-reset credits, add `resetCredits` to the fetcher's
return value and the card grows a reset row:

```js
return {
  ...,
  resetCredits: { available: 2, expiresAt: "12/23 00:59", eligible: true },
};
```

**Spending resets (the actual reset call)**

1. Add a consume module under `src/` (e.g. `my-reset.mjs`).
2. Add `POST /api/myservice/reset` to `src/usage-server.mjs` with **the same
   protections** as `/api/glm/reset`: mandatory `x-sup-reset: 1` header,
   `isAllowedOrigin` check, JSON body. Resets are irreversible — do not skip these.
3. Extend `ResetRow` in `bundle/client.js` with a new kind and wire the endpoint.

## Optional: peak-hour clock

For time-of-day-priced services, one line in `PEAK_RULES` (`bundle/client.js`)
adds the full peak clock — band, current-time marker, and next-window countdown:

```js
const PEAK_RULES = {
  myservice: { tz: 480, days: [1, 2, 3, 4, 5], windows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]], ratioOn: "×2", ratioOff: "½" },
};
```

- `tz`: UTC offset in **minutes** (Asia/Shanghai = 480, UTC = 0)
- `days`: weekdays with peaks (0 = Sunday); omit for every day
- `windows`: [start, end] in **zone-local minutes**
- `ratioOn` / `ratioOff`: display labels for the multipliers

## Optional: CLI

`usage.mjs` is standalone; import the same fetcher there and add an output
block (`--json` picks up anything returned automatically).

## Verify

```bash
node verify.mjs    # bundle syntax / module contract checks
node server.mjs    # standalone server → curl http://127.0.0.1:50071/api/usage
```

A card with no credentials should **not appear** — that is the correct behavior.
Only services whose credentials resolve show up as cards.

## Pull requests

Providers with an official API that anyone can use are very welcome as PRs.
For judgment calls that only make sense for your own scraping setup, prefer a
fork.
