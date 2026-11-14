// 各サブスクの使用量を正規化して返す共有モジュール。
// パネル（サーバー側）と CLI の両方から使う。Node.js 18+ のみ依存。
//
// 返り値の形（サブスク1件）:
//   { id, name, plan, connected, status: "ok"|"error", error?, windows: [{label, percent, resetAt, detail?}], notes?: [] }
//
// 連携していない（認証情報が無い）サブスクは connected:false で返し、UI 側で表示しない。

import { execFile } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fetchCodingPlanResetStatus } from "./glm-reset.mjs";

const execFileP = promisify(execFile);
const HOME = homedir();
const TZ = "Asia/Tokyo";
const fmtCompact = (ms) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
};
const fmtReset = (ms) => (ms ? fmtCompact(ms) : null);
const fmtIso = (iso) => (iso ? fmtReset(Date.parse(iso)) : null);

// ---------- 認証情報の読み込み ----------

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function opencodeConfig() {
  return readJson(join(HOME, ".config", "opencode", "opencode.json"));
}

// 候補の Z.AI キーを順に返す（失効したキーがあっても次で取れるように）
async function zaiKeys() {
  const keys = [];
  if (process.env.ZAI_API_KEY) keys.push(process.env.ZAI_API_KEY);
  if (process.env.Z_AI_API_KEY) keys.push(process.env.Z_AI_API_KEY);
  const cfg = await opencodeConfig();
  const mcp = cfg?.mcp ?? {};
  const env = mcp["zai-mcp-server"]?.environment?.Z_AI_API_KEY;
  if (env) keys.push(env);
  const auth = mcp["web-search-prime"]?.headers?.Authorization;
  if (auth) keys.push(auth.replace(/^Bearer\s+/i, "").trim());
  return [...new Set(keys)];
}

async function codexAccount() {
  const a = await readJson(join(HOME, ".dsh", "plugins", "subscriptions", "auth.json"));
  const acc = a?.codex?.accounts ? Object.values(a.codex.accounts)[0] : null;
  return acc ?? null;
}

async function claudeAccount() {
  const a = await readJson(join(HOME, ".dsh", "plugins", "subscriptions", "auth.json"));
  const acc = a?.claude?.accounts ? Object.values(a.claude.accounts)[0] : null;
  return acc ?? null;
}

async function deepseekBalance() {
  const snap = await readJson(join(HOME, ".dsh", "dsh-usage", "provider-snapshots.json"));
  const providers = snap?.providers ?? {};
  // dsh-usage 0.4.14 以降はキーが "deepseek"、旧版は "deepseek-official"。両方に対応する。
  return providers["deepseek-official"] ?? providers["deepseek"] ?? null;
}

// ---------- GLM（Z.AI） ----------

const ZAI_LABEL = { TOKENS_LIMIT: "Tokens", TIME_LIMIT: "MCP calls" };
const ZAI_UNIT = { 3: "h", 5: "mo", 6: "wk" };

/**
 * ZCode の coding-plan リセット権を、パネル表示用の要約にする。
 * count = 残り回数、expiresAt = そのうち最も早い失効時刻。
 */
function resetSummary(status) {
  if (!status) return null;
  const shape = (list) => ({ count: list.length, expiresAt: list[0] ? fmtReset(list[0]) : null });
  return { fiveHour: shape(status.fiveHour), week: shape(status.week) };
}

async function fetchGlm() {
  const base = { id: "glm", name: "GLM（Z.AI）", connected: false };
  // リセット権は ZCode の認証情報から取る。使用量APIとは並行して取りに行く。
  const resetPromise = fetchCodingPlanResetStatus().catch(() => null);
  const keys = await zaiKeys();
  if (!keys.length) {
    const reset = resetSummary(await resetPromise);
    if (!reset) return base;
    return { ...base, reset, connected: true, status: "ok", plan: null, windows: [] };
  }
  let body = null;
  let lastError = "取得失敗";
  for (const key of keys) {
    const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
      headers: { Authorization: `Bearer ${key}`, "Accept-Language": "en-US" },
    });
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const b = await res.json();
    if (b.success) {
      body = b;
      break;
    }
    lastError = b.msg ?? lastError;
  }
  const reset = resetSummary(await resetPromise);
  const withReset = reset ? { reset } : {};
  if (!body) return { ...base, ...withReset, connected: true, status: "error", error: `${lastError} (all keys failed)` };
  const windows = (body.data?.limits ?? []).map((l) => ({
    label: `${ZAI_LABEL[l.type] ?? l.type} (${l.number}${ZAI_UNIT[l.unit] ?? ""})`,
    percent: l.percentage ?? null,
    resetAt: fmtReset(l.nextResetTime),
    detail: l.usage != null ? `limit ${l.usage.toLocaleString("en-US")} / left ${(l.remaining ?? 0).toLocaleString("en-US")}` : null,
  }));
  return {
    ...base,
    ...withReset,
    connected: true,
    status: "ok",
    plan: body.data?.level ?? null,
    windows,
  };
}

// ---------- opencode go ----------
// 本物の使用量API: GET https://opencode.ai/zen/go/v1/usage
// （CloudflareのWAFがあるためブラウザ風ヘッダー必須）

const OC_GO_LABEL = { rolling: "5-hour window", weekly: "Weekly window", monthly: "Monthly window" };

async function fetchOpencodeGoUsage(key) {
  const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://opencode.ai/",
      Origin: "https://opencode.ai",
    },
  });
  if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
  const j = await res.json();
  const u = j.usage ?? {};
  const windows = ["rolling", "weekly", "monthly"]
    .map((k) =>
      u[k] && {
        label: OC_GO_LABEL[k] ?? k,
        percent: u[k].percent ?? null,
        resetAt: fmtIso(u[k].resetsAt),
        detail: u[k].status && u[k].status !== "ok" ? `状態: ${u[k].status}` : null,
      },
    )
    .filter(Boolean);
  return windows;
}

// opencode stats は重い（大容量DBを走査する）ため、DSHホストプロセス内での
// 再実行を抑えるために長めにキャッシュする。これがUIフリーズの主原因だった。
const OC_STATS_TTL = 10 * 60_000;
let ocStatsCache = null;
let ocStatsAt = 0;

async function getOcStats() {
  if (ocStatsCache && Date.now() - ocStatsAt < OC_STATS_TTL) return ocStatsCache;
  const { stdout } = await execFileP("opencode", ["stats", "--days", "7", "--models", "--cost", "--json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  ocStatsCache = JSON.parse(stdout);
  ocStatsAt = Date.now();
  return ocStatsCache;
}

async function fetchOpencodeGo() {
  const base = { id: "opencode-go", name: "opencode go", connected: false };
  // 認証情報（account.json の API キー）で連携を判定する
  const acc = await readJson(join(HOME, ".local", "share", "opencode", "account.json"));
  const goAcc = Object.values(acc?.accounts ?? {}).find((a) => a.serviceID === "opencode-go");
  const key = goAcc?.credential?.key;
  if (!key) return base;

  let windows = null;
  try {
    windows = await fetchOpencodeGoUsage(key);
  } catch {
    windows = null; // APIが取れない場合はローカル統計のみ表示
  }

  let stats = null;
  try {
    stats = await getOcStats();
  } catch {
    stats = null;
  }

  if (!windows && !stats) {
    return { ...base, connected: true, status: "error", error: "usage API・opencode stats の両方に失敗しました" };
  }

  const goModels = stats ? (stats.models ?? []).filter((m) => m.model?.providerID === "opencode-go") : [];
  const sum = (f) => goModels.reduce((s, m) => s + (f(m) ?? 0), 0);

  return {
    ...base,
    connected: true,
    status: "ok",
    plan: null,
    windows: windows ?? [],
    summary: stats
      ? {
          range: "Last 7 days",
          sessions: stats.sessions ?? 0,
          input: sum((m) => m.tokens?.input),
          output: sum((m) => m.tokens?.output),
          cost: sum((m) => m.cost),
        }
      : null,
    notes: windows ? [] : ["usage API に到達できなかったため、ローカル記録のみ表示しています。"],
  };
}

// ---------- Codex ----------

async function fetchCodex() {
  const base = { id: "codex", name: "Codex（ChatGPT）", connected: false };
  const acc = await codexAccount();
  if (!acc?.accessToken) return base;
  const headers = {
    Authorization: `Bearer ${acc.accessToken}`,
    "User-Agent": "Mozilla/5.0",
  };
  if (acc.accountId) headers["ChatGPT-Account-Id"] = acc.accountId;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!res.ok) return { ...base, connected: true, status: "error", error: `HTTP ${res.status}` };
  const j = await res.json();
  // window の長さ（秒）からラベルを決める: 604800=週間, 18000=5時間
  const labelFor = (win) =>
    win?.limit_window_seconds === 604800 ? "Weekly window" : win?.limit_window_seconds === 18000 ? "5-hour window" : "Window";
  const w = (win) =>
    win && {
      label: labelFor(win),
      percent: win.used_percent ?? null,
      resetAt: win.reset_at ? fmtReset(win.reset_at * 1000) : null,
    };
  const windows = [j.rate_limit?.primary_window, j.rate_limit?.secondary_window]
    .filter(Boolean)
    .map(w)
    // 5時間枠を上に表示する（他サブスクと同じ並び順）
    .sort((a, b) => a.label.localeCompare(b.label));
  // usage 応答に rate_limit_reset_credits が無い版があるため、専用エンドポイントの一覧からも補完する。
  // （2026-11 時点の wham/usage は残数を返さず、rate-limit-reset-credits だけが返す）
  let resetDetail = null;
  try {
    resetDetail = await fetchCodexResetCredits();
  } catch {
    resetDetail = null;
  }
  const resetCredits = codexResetCredits(j)
    ?? (resetDetail === null ? null : { available: resetDetail.length, applicable: resetDetail.length });
  return {
    ...base,
    connected: true,
    status: "ok",
    plan: j.plan_type ?? acc.planType ?? null,
    account: j.email ?? acc.emailAddress ?? null,
    windows,
    ...(resetCredits === null ? {} : { resetCredits }),
    ...(resetDetail === null ? {} : { resetCreditsDetail: resetDetail }),
  };
}

/**
 * Codex の「使用量リセット権」の残数。
 * chatgpt.com の usage 応答 `rate_limit_reset_credits.available_count` が根拠。
 * 未提供（フィールド無し）なら null（UI はリセット行を出さない）。
 * @param {{rate_limit_reset_credits?: {available_count?: number, applicable_available_count?: number}}} j
 * @returns {{available: number, applicable: number} | null}
 */
export function codexResetCredits(j) {
  const raw = j?.rate_limit_reset_credits;
  if (!raw || typeof raw !== "object") return null;
  const available = Number(raw.available_count);
  if (!Number.isFinite(available)) return null;
  const applicableRaw = Number(raw.applicable_available_count);
  return {
    available,
    applicable: Number.isFinite(applicableRaw) ? applicableRaw : available,
  };
}

// ---------- Codex: 使用量リセット権 ----------
// chatgpt.com の非公開API（codex CLI 本体が使う経路）:
//   GET  /backend-api/wham/rate-limit-reset-credits            ... 保有リセット権の一覧
//   POST /backend-api/wham/rate-limit-reset-credits/consume    ... 1回消費（取り消し不可）
// 消費は破壊的なので、サーバーAPIは明示的な POST + 独自ヘッダでのみ呼ばれる。

/** 有効なリセット権だけを抽出する（純関数）。 */
export function pickUsableCredits(payload) {
  const list = Array.isArray(payload?.credits) ? payload.credits : [];
  return list
    .filter((c) => c && c.status === "available" && typeof c.id === "string")
    .map((c) => ({
      id: c.id,
      title: c.title ?? null,
      expiresAt: c.expires_at ? fmtIso(c.expires_at) : null,
      expiresAtRaw: c.expires_at ?? null,
    }))
    // 期限が近い順（UI は先頭の有効期限を出す）
    .sort((a, b) => (a.expiresAtRaw ? Date.parse(a.expiresAtRaw) : Infinity) - (b.expiresAtRaw ? Date.parse(b.expiresAtRaw) : Infinity));
}

async function codexHeaders() {
  const acc = await codexAccount();
  if (!acc?.accessToken) return null;
  const headers = { Authorization: `Bearer ${acc.accessToken}`, "User-Agent": "Mozilla/5.0" };
  if (acc.accountId) headers["ChatGPT-Account-Id"] = acc.accountId;
  return headers;
}

/** Codex の保有リセット権一覧を取得する。 */
export async function fetchCodexResetCredits() {
  const headers = await codexHeaders();
  if (headers === null) return null;
  const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pickUsableCredits(await res.json());
}

/**
 * Codex の使用量リセット権を1回消費する（取り消し不可）。
 * @param {string} [creditId] 省略時は先頭の利用可能な権
 * @returns {Promise<{ok: boolean, outcome?: string, error?: string}>}
 */
export async function consumeCodexResetCredit(creditId) {
  const headers = await codexHeaders();
  if (headers === null) return { ok: false, error: "Codex の認証情報がありません" };
  const credits = await fetchCodexResetCredits();
  if (!credits || credits.length === 0) return { ok: false, error: "利用可能なリセット権がありません" };
  const target = creditId ? credits.find((c) => c.id === creditId) : credits[0];
  if (!target) return { ok: false, error: "指定のリセット権が見つかりません" };

  const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ creditId: target.id, idempotencyKey: randomUUID() }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    return { ok: false, error: (body && (body.detail || body.error || body.message)) || `HTTP ${res.status}` };
  }
  const outcome = body?.outcome ?? "ok";
  return { ok: outcome === "ok" || outcome === "reset" || outcome === undefined, outcome };
}

// ---------- Claude ----------

// Claude の OAuth トークンは約8時間で失効する。401時に refresh_token で更新して
// auth.json へ保存し、1回だけ再試行する（パネルを自己修復させる）。
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

// ---------- Claude: 使用量リセット権（cedar_ember） ----------
//
// Claude Code の「使用量リセット権」は usage API の cedar_ember ブロックで返る。
// 取得は ?cedar_ember=1&skip_spend=1 の付いたリクエストで、Anthropic は
// 「1アカウントあたり1時間に1回」に制限している（連打すると 429 + Retry-After 約50分）。
// そのため結果をファイルにキャッシュし、30秒ポーリングからは叩かない。
//
// surface 判定は User-Agent で行われるため claude-cli/<version> (external, cli) が必須
// （UA が違うと eligible:false / ineligible_reason:"surface" になる）。
const CLAUDE_RESET_CACHE = join(HOME, ".dsh", "dsh-usage", "claude-reset-credits.json");
const CLAUDE_RESET_TTL = 60 * 60_000;
const CLAUDE_RESET_UA_FALLBACK = "2.1.308";
let claudeCliVersionCache = null;

async function claudeCliVersion() {
  if (claudeCliVersionCache) return claudeCliVersionCache;
  try {
    const { stdout } = await execFileP("claude", ["--version"], { timeout: 5000, maxBuffer: 1 << 20 });
    claudeCliVersionCache = /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? CLAUDE_RESET_UA_FALLBACK;
  } catch {
    claudeCliVersionCache = CLAUDE_RESET_UA_FALLBACK;
  }
  return claudeCliVersionCache;
}

/**
 * cedar_ember ブロックを表示用に正規化する（純関数）。
 * grants[].resets_left が残数、grants[].ends_at が有効期限。
 * 期限切れ・paused・usable_now:false は除外する。
 */
export function claudeResetCredits(cedar, now = Date.now()) {
  if (!cedar || typeof cedar !== "object") return null;
  const grants = Array.isArray(cedar.grants) ? cedar.grants : [];
  const live = grants.filter((g) =>
    g && typeof g.id === "string" && g.paused !== true && g.usable_now !== false
    && (!g.ends_at || Date.parse(g.ends_at) > now));
  const available = live.reduce((sum, g) => sum + (Number.isFinite(Number(g.resets_left)) ? Number(g.resets_left) : 1), 0);
  const expiry = live.map((g) => g.ends_at).filter((v) => typeof v === "string" && v !== "").sort()[0] ?? null;
  return {
    available,
    expiresAt: fmtIso(expiry),
    eligible: cedar.eligible !== false,
    reason: cedar.eligible === false ? (cedar.ineligible_reason ?? null) : null,
  };
}

async function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}

/** Claude の使用量リセット権を返す（1時間キャッシュ）。取得できなければ前回値 / null。 */
async function fetchClaudeResetCredits(acc) {
  const cached = await readJson(CLAUDE_RESET_CACHE);
  // data が null でも「失敗の記録」として at を見る（429 中の連打を防ぐ）。
  if (cached && Number.isFinite(cached.at) && Date.now() - cached.at < CLAUDE_RESET_TTL) return cached.data ?? null;
  try {
    const version = await claudeCliVersion();
    const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", {
      headers: {
        Authorization: "Bearer " + acc.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
        accept: "application/json",
        "User-Agent": "claude-cli/" + version + " (external, cli)",
      },
    });
    if (!res.ok) {
      // 429 は「1時間待て」の合図。他の失敗も10分は再試行しない（成功値があれば保持）。
      const at = Date.now();
      await writeJsonAtomic(CLAUDE_RESET_CACHE, { at: at - (res.status === 429 ? 0 : CLAUDE_RESET_TTL - 10 * 60_000), data: cached?.data ?? null }).catch(() => {});
      return cached?.data ?? null;
    }
    const info = claudeResetCredits((await res.json())?.cedar_ember);
    if (info) await writeJsonAtomic(CLAUDE_RESET_CACHE, { at: Date.now(), data: info }).catch(() => {});
    return info ?? cached?.data ?? null;
  } catch {
    return cached?.data ?? null;
  }
}

async function refreshClaudeToken(acc) {
  if (!acc?.refreshToken) return null;
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.0.0" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: acc.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j?.access_token) return null;
  acc.accessToken = j.access_token;
  if (j.refresh_token) acc.refreshToken = j.refresh_token;
  acc.expiresAt = j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : acc.expiresAt;
  // 保存（atomic write）。失敗してもメモリ上の新トークンで今回の取得は継続する。
  try {
    const path = join(HOME, ".dsh", "plugins", "subscriptions", "auth.json");
    const all = JSON.parse(await readFile(path, "utf8"));
    const key = Object.keys(all?.claude?.accounts ?? {})[0];
    if (key) {
      all.claude.accounts[key] = { ...all.claude.accounts[key], ...acc };
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(all, null, 2) + "\n");
      await rename(tmp, path);
    }
  } catch { /* 保存失敗は無視（次回401で再試行） */ }
  return acc;
}

// Claude の usage API は 429 を返しやすい。成功値は 2 分キャッシュし、
// 429 / 5xx のときは指数バックオフ（最大10分）で叩く頻度を落とし、
// 失敗時は「前回の成功値」を注記付きで返す（パネルをエラーで埋めない）。
const CLAUDE_TTL = 2 * 60_000;
const CLAUDE_CACHE_FILE = join(HOME, ".dsh", "glm-opencode-usage-cache", "claude.json");

/** ディスクに保存した前回成功値を読む（プロセス再起動をまたいで表示を保つ）。 */
async function readClaudeDiskCache() {
  const j = await readJson(CLAUDE_CACHE_FILE);
  if (!j || typeof j.at !== "number" || !j.result) return null;
  return { at: j.at, result: j.result };
}

async function writeClaudeDiskCache(at, result) {
  try {
    await mkdir(dirname(CLAUDE_CACHE_FILE), { recursive: true });
    await writeFile(CLAUDE_CACHE_FILE, JSON.stringify({ at, result }), "utf8");
  } catch { /* 保存失敗は無視 */ }
}
let claudeCache = null;      // 最後に成功した結果
let claudeCacheAt = 0;
let claudeBackoffUntil = 0;  // この時刻までは API を叩かない
let claudeBackoffMs = 0;

async function fetchClaude() {
  const base = { id: "claude", name: "Claude", connected: false };
  let acc = await claudeAccount();
  if (!acc?.accessToken) return base;
  const callUsage = async (a) => {
    const version = await claudeCliVersion();
    return fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: "Bearer " + a.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/" + version + " (external, cli)",
      },
    });
  };
  // 期限切れ間近なら先に更新
  if (acc.expiresAt && acc.expiresAt < Date.now() + 60_000) {
    acc = (await refreshClaudeToken(acc)) ?? acc;
  }
  if (claudeCache === null) {
    const disk = await readClaudeDiskCache();
    if (disk !== null) { claudeCache = disk.result; claudeCacheAt = disk.at; }
  }
  const now = Date.now();
  // 成功キャッシュが新しい / バックオフ中なら API を叩かない
  if (claudeCache && now - claudeCacheAt < CLAUDE_TTL) return claudeCache;
  if (now < claudeBackoffUntil) return claudeCache ?? { ...base, connected: true, status: "error", error: "レート制限中（しばらく待機）" };

  let res = await callUsage(acc);
  if (res.status === 401) {
    // 401 なら refresh_token で更新して1回だけ再試行
    const refreshed = await refreshClaudeToken(acc);
    if (refreshed) res = await callUsage(refreshed);
  }
  if (res.status === 429 || res.status >= 500) {
    // 429/5xx: バックオフを伸ばし、前回値があればそれを返す
    claudeBackoffMs = Math.min(claudeBackoffMs === 0 ? 60_000 : claudeBackoffMs * 2, 10 * 60_000);
    claudeBackoffUntil = Date.now() + claudeBackoffMs;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) claudeBackoffUntil = Date.now() + Math.min(retryAfter * 1000, 10 * 60_000);
    if (claudeCache) {
      return {
        ...claudeCache,
        notes: [`レート制限中のため前回値（${fmtReset(claudeCacheAt)}）`, ...(claudeCache.notes ?? []).filter((n) => !n.startsWith("レート制限中"))],
      };
    }
    return { ...base, connected: true, status: "error", error: `HTTP ${res.status}（レート制限中・しばらく待機）` };
  }
  if (!res.ok) return { ...base, connected: true, status: "error", error: `HTTP ${res.status}` };
  const j = await res.json();
  const w = (label, win) =>
    win && {
      label,
      percent: win.utilization ?? null,
      resetAt: fmtIso(win.resets_at),
    };
  const windows = [w("5-hour window", j.five_hour), w("Weekly window", j.seven_day)].filter(Boolean);
  // 使用量リセット権（cedar_ember）。取得できなくても使用量表示は壊さない。
  const resetCredits = await fetchClaudeResetCredits(acc);
  const result = {
    ...base,
    connected: true,
    status: "ok",
    plan: null,
    account: acc.emailAddress ?? null,
    windows,
    ...(resetCredits === null ? {} : { resetCredits }),
  };
  claudeCache = result;
  claudeCacheAt = Date.now();
  await writeClaudeDiskCache(claudeCacheAt, result);
  claudeBackoffMs = 0;
  claudeBackoffUntil = 0;
  return result;
}

// ---------- DeepSeek（残高） ----------

async function fetchDeepseek() {
  const base = { id: "deepseek", name: "DeepSeek", connected: false };
  const p = await deepseekBalance();
  if (!p?.balance) return base;
  return {
    ...base,
    connected: true,
    status: "ok",
    plan: null,
    balance: { amount: p.balance.totalBalance, currency: p.balance.currency },
    windows: [],
    notes: [`Balance snapshot: ${fmtReset(p.balance.updatedAt)}`],
  };
}

// ---------- 全体 ----------

/** 全サブスクを並列に取得する。連携していないものは connected:false で返る。 */
// ---------- Command Code (GOAT) ----------
// 公式API: GET https://api.commandcode.ai/alpha/billing/credits（Bearer = CLI/API共通キー）
//   → windowLimits.fiveHour / weekly（used/cap/resetAt, USD建て）+ credits.monthlyCredits
// GET /alpha/usage/summary → 請求期間のトークン/コスト実績
// キーは process.env か ~/.dsh/.env の COMMANDCODE_API_KEY。
// 取得失敗時は DSHローカル台帳(usage-ledger)の集計にフォールバックする。
const CC_PROVIDERS = ["commandcode", "commandcode-anthropic"];

function ccLocalDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

function aggregateCommandcode(ledger, dayFilter) {
  let input = 0, output = 0, calls = 0, cost = 0;
  const days = ledger?.days ?? {};
  for (const [day, provs] of Object.entries(days)) {
    if (dayFilter != null && day !== dayFilter) continue;
    for (const p of CC_PROVIDERS) {
      for (const m of Object.values(provs?.[p] ?? {})) {
        input += m.inputTokens ?? 0;
        output += m.outputTokens ?? 0;
        calls += m.calls ?? 0;
        cost += m.cost ?? 0;
      }
    }
  }
  return { input, output, calls, cost };
}

async function commandCodeKey() {
  const env = process.env.COMMANDCODE_API_KEY?.trim();
  if (env) return env;
  const text = await readFile(join(HOME, ".dsh", ".env"), "utf8").catch(() => "");
  const m = /^\s*COMMANDCODE_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** ローカル台帳だけの旧表示（APIが使えないときのフォールバック） */
async function commandcodeFromLedger(base) {
  const ledger = await readJson(join(HOME, ".dsh", "dsh-usage", "usage-ledger.json"));
  const today = aggregateCommandcode(ledger, ccLocalDateKey());
  const total = aggregateCommandcode(ledger, null);
  const tok = (v) => v.toLocaleString("en-US");
  return {
    ...base,
    connected: true,
    status: "ok",
    plan: "GOAT",
    windows: [
      { label: "今日の使用 (DSHローカル集計)", percent: null, detail: `${tok(today.calls)} calls / ${tok(today.input + today.output)} tokens` },
      { label: "合計の使用 (DSHローカル集計)", percent: null, detail: `${tok(total.calls)} calls / ${tok(total.input + total.output)} tokens` },
    ],
    notes: ["使用量APIを取得できませんでした（ローカル集計を表示）", "公式の内訳は Studio (commandcode.ai/studio) で確認できます"],
  };
}

export async function fetchCommandcode() {
  const base = { id: "commandcode", name: "Command Code", connected: false };
  const key = await commandCodeKey();
  if (!key) {
    return { ...base, connected: true, status: "error", error: "COMMANDCODE_API_KEY が未設定です" };
  }
  const auth = { Authorization: `Bearer ${key}`, "Accept-Language": "en-US" };
  const usd2 = (n) => `$${Number(n ?? 0).toFixed(2)}`;
  const pct = (w) => {
    const used = Number(w?.used);
    const cap = Number(w?.cap);
    return Number.isFinite(used) && Number.isFinite(cap) && cap > 0 ? Math.round((used / cap) * 1000) / 10 : null;
  };

  let credits = null;
  try {
    const res = await fetch("https://api.commandcode.ai/alpha/billing/credits", { headers: auth });
    if (res.ok) credits = await res.json();
  } catch {
    /* フォールバックへ */
  }
  if (!credits) return commandcodeFromLedger(base);

  const wl = credits.windowLimits ?? {};
  const windows = [];
  const pushWindow = (label, w) => {
    if (!w) return;
    const used = Number(w.used ?? 0);
    windows.push({
      label,
      percent: pct(w),
      // 未使用の枠は resetAt:0 で返るため、時刻は出さない（窓は使い始めから回り出す）
      resetAt: Number(w.resetAt) > 0 ? fmtReset(w.resetAt) : null,
      detail: used > 0 ? `${usd2(w.used)} / ${usd2(w.cap)}` : `未使用 · 上限 ${usd2(w.cap)}`,
    });
  };
  pushWindow("5-hour window", wl.fiveHour);
  pushWindow("Weekly window", wl.weekly);

  let plan = "GOAT";
  let periodEnd = null;
  try {
    const res = await fetch("https://api.commandcode.ai/alpha/billing/subscriptions", { headers: auth });
    if (res.ok) {
      const j = await res.json();
      periodEnd = j?.data?.currentPeriodEnd ?? null;
      const planId = j?.data?.planId;
      if (typeof planId === "string") plan = planId.replace(/^individual-/, "").replace(/^team-/, "").toUpperCase();
    }
  } catch {
    /* plan は既定値 */
  }

  let summary;
  try {
    const res = await fetch("https://api.commandcode.ai/alpha/usage/summary", { headers: auth });
    if (res.ok) {
      const u = await res.json();
      if (Number.isFinite(Number(u?.totalTokensIn))) {
        summary = {
          range: "請求期間",
          input: Number(u.totalTokensIn),
          output: Number(u.totalTokensOut ?? 0),
          cost: Number(u.totalCost ?? 0),
        };
      }
    }
  } catch {
    /* summary は任意 */
  }

  // 月次クレジット: 分母 = 残高 + 今期の使用額、リセット = 契約期間の終了日
  const remaining = Number(credits.credits?.monthlyCredits);
  if (Number.isFinite(remaining)) {
    const spent = Number(summary?.cost ?? 0);
    const total = remaining + spent;
    windows.push({
      label: "Monthly credits",
      percent: total > 0 ? Math.round((spent / total) * 1000) / 10 : null,
      resetAt: periodEnd ? fmtIso(periodEnd) : null,
      detail: `${usd2(spent)} / ${usd2(total)} · 残り ${usd2(remaining)}`,
    });
  }

  return {
    ...base,
    connected: true,
    status: "ok",
    plan,
    windows,
    ...(summary ? { summary } : {}),
  };
}

export async function fetchAllSubscriptions() {
  const results = await Promise.all([
    fetchGlm(),
    fetchOpencodeGo(),
    fetchCodex(),
    fetchClaude(),
    fetchDeepseek(),
    fetchCommandcode(),
  ].map((p) =>
    p.catch((e) => ({ connected: true, status: "error", error: String(e?.message ?? e) })),
  ));
  return {
    generatedAt: fmtCompact(Date.now()),
    subscriptions: results,
  };
}
