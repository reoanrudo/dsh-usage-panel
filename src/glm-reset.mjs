// Z.AI Coding Plan の「使用量リセット権」API。
//
// ZCode デスクトップアプリが使っているのと同じエンドポイントを呼ぶ:
//   GET  /api/v1/coding-plan/reset/status   -> 残っているリセット権（5時間枠・週枠）
//   POST /api/v1/coding-plan/reset/use      -> 1回消費してリセットする
//   POST /api/v1/coding-plan/reset/history/read
//
// 認証は ZCode が保存している2トークン（src/zcode-credentials.mjs）。
// 失敗時は Error を投げ、呼び出し側がパネルに表示する。

import { randomUUID } from "node:crypto";
import { loadZcodeResetCredentials } from "./zcode-credentials.mjs";

const BASE = "https://zcode.z.ai/api/v1/coding-plan/reset";
const TIMEOUT_MS = 15_000;
const TARGET_TYPE = "PERSONAL";

/** リセットの種類。API の reset_type とそのまま一致する。 */
export const RESET_TYPES = ["FIVE_HOUR", "WEEK"];

function authHeaders({ zcodeJwt, zaiAccessToken }) {
  return {
    Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
    "X-Bigmodel-Authorization": zaiAccessToken,
    "Bigmodel-Target-Type": TARGET_TYPE,
  };
}

async function requestJson(path, init, credentials) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(credentials), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* JSON でない応答は下で扱う */
  }
  const code = typeof body?.code === "number" ? body.code : null;
  if (code !== null && code !== 0) {
    const msg = body?.msg ? `: ${body.msg}` : "";
    throw new Error(`coding-plan reset API error ${code}${msg}`);
  }
  if (!res.ok) throw new Error(`coding-plan reset API HTTP ${res.status}`);
  if (!body || typeof body !== "object") throw new Error("coding-plan reset API returned an invalid response");
  return body;
}

const toExpireList = (value) =>
  Array.isArray(value)
    ? value
        .map((item) => Number(item?.expire_at))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b)
    : [];

/**
 * 残っているリセット権を取得する。
 * ZCode の認証情報が無い場合は null（未連携扱い）。
 *
 * @returns {Promise<{
 *   fiveHour: number[], week: number[],
 *   latestFiveHourUsedAt: number|null, latestWeekUsedAt: number|null,
 *   hasUnreadHistory: boolean,
 * } | null>}
 */
export async function fetchCodingPlanResetStatus(env = process.env) {
  const credentials = await loadZcodeResetCredentials(env);
  if (!credentials) return null;
  const body = await requestJson("/status", { method: "GET" }, credentials);
  const data = body.data ?? {};
  return {
    fiveHour: toExpireList(data.available_five_hour_resets),
    week: toExpireList(data.available_week_resets),
    latestFiveHourUsedAt: Number(data.latest_five_hour_reset_history?.used_at) || null,
    latestWeekUsedAt: Number(data.latest_week_reset_history?.used_at) || null,
    hasUnreadHistory: data.has_unread_history === true,
  };
}

/**
 * リセット権を1回消費して、指定した枠をリセットする。
 * ※ 取り消し不可。呼び出し側は事前にユーザー確認を取ること。
 *
 * @param {"FIVE_HOUR"|"WEEK"} type
 * @param {{ idempotencyKey?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ used: true, type: string, idempotencyKey: string }>}
 */
export async function useCodingPlanReset(type, options = {}) {
  if (!RESET_TYPES.includes(type)) throw new Error(`unknown reset type: ${type}`);
  const env = options.env ?? process.env;
  const credentials = await loadZcodeResetCredentials(env);
  if (!credentials) throw new Error("ZCode credentials not found (log in to ZCode first)");
  const idempotencyKey = (options.idempotencyKey ?? randomUUID()).trim();
  if (!idempotencyKey || idempotencyKey.length > 64) throw new Error("invalid idempotency key");
  const body = await requestJson(
    "/use",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: idempotencyKey, reset_type: type }),
    },
    credentials,
  );
  if (body.data?.used !== true) throw new Error("coding-plan reset API did not confirm the reset");
  return { used: true, type, idempotencyKey };
}
