# プロバイダーの追加方法（Add a provider）

このパネルに新しいサブスク（プロバイダー）を追加するのは 3 ステップです。
すべて `src/fetchers.mjs` と `bundle/client.js` だけで完結し、サーバー側の
契約（`/api/usage` の JSON 形）は変えません。

## 1. fetcher を書く（サーバー側）

`src/fetchers.mjs` に、サービスの使用量を取得して次の形に正規化する関数を追加します:

```js
async function fetchMyService() {
  const base = { id: "myservice", name: "My Service", connected: false };
  const key = process.env.MY_SERVICE_KEY; // 自分で認証情報を決める
  if (!key) return base;                  // 未設定なら未連携扱い（非表示）
  const res = await fetch("https://api.example.com/v1/usage", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { ...base, connected: true, status: "error", error: `HTTP ${res.status}` };
  const j = await res.json();
  return {
    ...base,
    connected: true,
    status: "ok",
    plan: j.plan ?? null,                    // 右上のバッジ（任意）
    account: j.email ?? null,                // アカウント名（任意）
    balance: null,                           // 残高型なら { amount, currency } を返す
    windows: [
      { label: "5-hour window", percent: 42, resetAt: "11/20 09:00", detail: "limit 1,000 / left 580" },
      { label: "Weekly window", percent: 7,  resetAt: "11/24 00:00" },
    ],
  };
}
```

**返り値の契約**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | カードの key。`[a-z0-9-]` 推奨 |
| `name` | string | ✓ | カード見出し |
| `connected` | boolean | ✓ | `false` ならカードごと非表示 |
| `status` | `"ok" \| "error"` | - | `error` のとき `error` 文字列を赤で表示 |
| `plan` | string\|null | - | プランバッジ |
| `account` | string\|null | - | 見出し下の小さなアカウント表示 |
| `balance` | \|null | - | `{ amount: "7.56", currency: "USD" }`。残高型のサービス用 |
| `windows` | array | - | `{ label, percent, resetAt, detail }`。percent は 0-100 |
| `resetCredits` | object | - | 使用量リセット権（後述） |

## 2. fetchAllSubscriptions に登録する

`src/fetchers.mjs` の `fetchAllSubscriptions()` の `Promise.all` 配列に
追加した fetcher を並べます:

```js
const results = await Promise.all([
  fetchGlm(),
  fetchOpencodeGo(),
  fetchCodex(),
  fetchClaude(),
  fetchDeepseek(),
  fetchCommandcode(),
  fetchMyService(),   // ← 追加
  ...
]);
```

配列の並びが**既定のカード順**になります。

## 3. アイコンを差す（ブラウザ側）

`bundle/client.js` の `ICONS`（data URI の 64px PNG）に `myservice` を追加します。
アイコンが無い場合は、カードには自動で頭文字のフォールバックが出るので、
`ICONS` への追加は省略しても動きます:

```js
const ICONS = { ..., myservice: "data:image/png;base64,..." };
```

## 任意: リセット権（Quota reset）を出す

サービスに「使用量リセット権」がある場合は、fetcher の返り値に
`resetCredits` を足すとカードにリセット行が出ます:

```js
return {
  ...,
  resetCredits: { available: 2, expiresAt: "12/23 00:59", eligible: true },
};
```

**消費（リセット実行）まで実装する場合**

1. `src/` に消費用モジュールを追加（例: `my-reset.mjs`）。
2. `src/usage-server.mjs` に `POST /api/myservice/reset` を追加し、
   `/api/glm/reset` と**同じ保護**（`x-sup-reset: 1` ヘッダー必須、
   `isAllowedOrigin` チェック、JSON body）を必ず付けてください。取り消せない操作です。
3. `bundle/client.js` の `ResetRow` に kind を追加し、エンドポイントを叩く。

## 任意: ピーク時間帯（Peak clock）を出す

時間帯で価格が変わるサービスは、`bundle/client.js` の `PEAK_RULES` に
1行追加するだけでピーク時計が出ます:

```js
const PEAK_RULES = {
  myservice: { tz: 480, days: [1, 2, 3, 4, 5], windows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]], ratioOn: "×2", ratioOff: "½" },
};
```

- `tz`: 分単位の UTC オフセット（例: Asia/Shanghai = 480、UTC = 0）
- `days`: ピークが発生する曜日（0=日曜）。省略時は毎日
- `windows`: ゾーン現地時刻の分（`[開始, 終了]`）の配列
- `ratioOn` / `ratioOff`: 表示用の倍率ラベル

## 任意: CLI（usage.mjs）にも出す

`usage.mjs` は独立したファイルなので、必要なら同じ fetcher を import して
出力ブロックを足してください（`--json` は自動で拾われます）。

## 確認

```bash
node verify.mjs    # バンドル構文・モジュール契約の検査
node server.mjs    # サーバー単体起動 → curl http://127.0.0.1:50071/api/usage
```

新しいカードが未連携（credentials 無し）のときは**表示されない**のが正しい挙動です。
認証情報を設定したアカウントだけがカードとして出ます。

## プルリクエスト

汎用化できそうなプロバイダー（公式 API があって誰でも使えるもの）は、
このリポジトリへの PR を歓迎します。個人専用のスクレイピング判定になるものは
フォークでの利用を推奨します。
