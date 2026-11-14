// 使用量APIの本体。server.mjs（CLI）と bundle/index.js（DSHホスト側）の両方から使う。
// 127.0.0.1 のみで待ち受け、45秒キャッシュする。
//
// エンドポイント:
//   GET  /api/usage      ... 全サブスクの使用量（GLM にはリセット権の残数も含む）
//   POST /api/glm/reset  ... GLM の使用量リセット権を1回消費する（取り消し不可）
//   POST /api/codex/reset ... Codex(ChatGPT) の使用量リセット権を1回消費する（取り消し不可）
//
// リセットは破壊的なので、ブラウザからの呼び出しは
//   - 許可した Origin（DSHデスクトップの dsh-app://app / ローカルHTTP）だけ
//   - 独自ヘッダー x-sup-reset: 1 を必須（= 単純なクロスサイトPOSTを不可にする）
// としている。

import { createServer } from "node:http";
import { fetchAllSubscriptions } from "./fetchers.mjs";
import { RESET_TYPES, useCodingPlanReset } from "./glm-reset.mjs";
import { consumeCodexResetCredit } from "./fetchers.mjs";

const CACHE_MS = 20_000; // この間はキャッシュをそのまま返す（force時は無視）
const STALE_MS = 10 * 60_000; // これを超えた古いデータは使わない
let cache = null;
let cachedAt = 0;
let refreshing = null;

/** 全サブスクを取得してキャッシュを更新する（単一フライト） */
function refresh() {
  if (!refreshing) {
    refreshing = fetchAllSubscriptions()
      .then((d) => {
        cache = d;
        cachedAt = Date.now();
        return d;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * Stale-While-Revalidate:
 *  - 新しければキャッシュを返す
 *  - 古くなっていても前回値を即返し、裏で更新を開始する（パネルの体感速度向上）
 *  - 前回値が無い場合のみ取得を待つ
 */
async function getUsage(force) {
  const age = cache ? Date.now() - cachedAt : Infinity;
  if (!force && cache && age < CACHE_MS) return cache;
  if (cache && !force) {
    if (age >= STALE_MS || !refreshing) refresh().catch(() => {});
    return cache;
  }
  return refresh();
}

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const ALLOWED_ORIGINS = new Set(["dsh-app://app"]);

/** 書き込みを許可する Origin か。Origin 無し（CLI/curl）は許可する。 */
function isAllowedOrigin(origin) {
  if (origin == null || origin === "") return true;
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
}

function corsHeaders(origin) {
  if (origin && isAllowedOrigin(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-sup-reset",
      Vary: "Origin",
    };
  }
  return {};
}

function sendJson(res, status, body, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/** 破壊的操作: リセット権を1回消費する。 */
async function handleReset(req, res, origin) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" }, origin);
  if (!isAllowedOrigin(origin)) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, origin);
  if (req.headers["x-sup-reset"] !== "1") return sendJson(res, 403, { ok: false, error: "missing x-sup-reset header" }, origin);
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    return sendJson(res, 415, { ok: false, error: "content-type must be application/json" }, origin);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }, origin);
  }
  const type = body?.type;
  if (!RESET_TYPES.includes(type)) {
    return sendJson(res, 400, { ok: false, error: `type must be one of ${RESET_TYPES.join(", ")}` }, origin);
  }
  try {
    const result = await useCodingPlanReset(type, { idempotencyKey: body?.idempotencyKey });
    // 消費後は古い使用率を返さない（次の /api/usage で取り直す）
    cache = null;
    cachedAt = 0;
    refresh().catch(() => {});
    return sendJson(res, 200, { ok: true, ...result }, origin);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: String(e?.message ?? e) }, origin);
  }
}

/** 破壊的操作: Codex のリセット権を1回消費する。GLM と同じ防御（Origin / x-sup-reset / JSON）。 */
async function handleCodexReset(req, res, origin) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" }, origin);
  if (!isAllowedOrigin(origin)) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, origin);
  if (req.headers["x-sup-reset"] !== "1") return sendJson(res, 403, { ok: false, error: "missing x-sup-reset header" }, origin);
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    return sendJson(res, 415, { ok: false, error: "content-type must be application/json" }, origin);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }, origin);
  }
  try {
    const result = await consumeCodexResetCredit(typeof body?.creditId === "string" ? body.creditId : undefined);
    if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error || result.outcome || "consume failed" }, origin);
    cache = null;
    cachedAt = 0;
    refresh().catch(() => {});
    return sendJson(res, 200, { ok: true, outcome: result.outcome ?? "ok" }, origin);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: String(e?.message ?? e) }, origin);
  }
}

export function createUsageServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;

    if (req.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, origin);
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }

    if (url.pathname === "/api/glm/reset") {
      await handleReset(req, res, origin);
      return;
    }

    if (url.pathname === "/api/codex/reset") {
      await handleCodexReset(req, res, origin);
      return;
    }

    if (url.pathname === "/api/usage") {
      if (!isAllowedOrigin(origin)) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, origin);
      try {
        const data = await getUsage(url.searchParams.has("refresh"));
        sendJson(res, 200, data, origin);
      } catch (e) {
        sendJson(res, 500, { error: String(e?.message ?? e) }, origin);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

/**
 * サーバーを起動する。ポートが既に使われている場合は null を返す
 * （既存のサーバーが同じAPIを返すため、パネルはそのまま動く）。
 * @returns {Promise<import("node:http").Server|null>}
 */
export function startUsageServer(port = 50071, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createUsageServer();
    server.once("error", () => resolve(null));
    server.listen(port, host, () => {
      // 起動直後の初回リクエストを待たせないよう、裏で先に温めておく
      refresh().catch(() => {});
      resolve(server);
    });
  });
}
