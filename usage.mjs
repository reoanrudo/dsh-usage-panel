#!/usr/bin/env node
// GLM (Z.AI) と opencode go の usage を一画面で表示する DSH プラグイン。
//
// 使い方:
//   node usage.mjs            # 両方を表示
//   node usage.mjs glm        # GLM のみ
//   node usage.mjs opencode   # opencode go のみ
//   node usage.mjs --json     # JSON で出力
//
// 依存: Node.js 18+ のみ（外部パッケージ不要）。
//
// GLM の API キーは次の順で探す:
//   1. 環境変数 ZAI_API_KEY / Z_AI_API_KEY
//   2. ~/.config/opencode/opencode.json の mcp.zai-mcp-server.environment.Z_AI_API_KEY
//      もしくは mcp.web-search-prime.headers.Authorization の Bearer トークン
//
// opencode go の usage は `opencode stats --json` の集計を使う（公開のアカウント残量 API は無いため、
// 「このマシンで記録された利用量（トークン・コスト・モデル別）」として表示する）。

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const target = args.find((a) => !a.startsWith("--")) ?? "all";

// ---------- GLM (Z.AI) ----------

// 候補キーを順に返す。失効したキーがあっても次の候補で取得できるようにする。
async function zaiKeyCandidates() {
  const keys = [];
  if (process.env.ZAI_API_KEY) keys.push(process.env.ZAI_API_KEY);
  if (process.env.Z_AI_API_KEY) keys.push(process.env.Z_AI_API_KEY);
  try {
    const cfg = JSON.parse(
      await readFile(join(homedir(), ".config", "opencode", "opencode.json"), "utf8"),
    );
    const mcp = cfg.mcp ?? {};
    const env = mcp["zai-mcp-server"]?.environment?.Z_AI_API_KEY;
    if (env) keys.push(env);
    const auth = mcp["web-search-prime"]?.headers?.Authorization;
    if (auth) keys.push(auth.replace(/^Bearer\s+/i, "").trim());
  } catch {
    /* 設定が無い場合は環境変数のみ */
  }
  return [...new Set(keys)];
}

const LIMIT_LABEL = {
  TOKENS_LIMIT: "トークン",
  TIME_LIMIT: "MCP呼び出し（時間）",
};

function unitLabel(unit) {
  // Z.AI の unit: 3=時間, 5=月, 6=週 相当
  return { 3: "時間", 5: "月", 6: "週" }[unit] ?? `unit${unit}`;
}

function fmtReset(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
}

async function fetchGlm() {
  const keys = await zaiKeyCandidates();
  if (!keys.length) return { ok: false, error: "Z.AI API キーが見つかりません（ZAI_API_KEY を設定してください）" };

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
  if (!body) return { ok: false, error: `${lastError}（全候補キーで失敗。キーの失効を確認してください）` };
  const limits = (body.data?.limits ?? []).map((l) => ({
    type: l.type,
    label: LIMIT_LABEL[l.type] ?? l.type,
    window: `${l.number}${unitLabel(l.unit)}`,
    percentage: l.percentage ?? null,
    usage: l.usage ?? null,
    currentValue: l.currentValue ?? null,
    remaining: l.remaining ?? null,
    resetAt: fmtReset(l.nextResetTime),
    details: (l.usageDetails ?? []).map((d) => ({ model: d.modelCode, usage: d.usage })),
  }));
  return { ok: true, level: body.data?.level ?? null, limits };
}

// ---------- opencode go ----------

function sumModels(models) {
  return models.reduce(
    (acc, m) => {
      acc.input += m.inputTokens ?? 0;
      acc.output += m.outputTokens ?? 0;
      acc.cacheRead += m.cacheRead ?? 0;
      acc.cacheWrite += m.cacheWrite ?? 0;
      acc.cost += m.cost ?? 0;
      acc.calls += m.calls ?? 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 },
  );
}

async function fetchOpencodeGo() {
  let stdout;
  try {
    ({ stdout } = await execFileP("opencode", ["stats", "--days", "7", "--models", "--cost", "--json"], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    return { ok: false, error: `opencode stats 実行に失敗: ${e.message.split("\n")[0]}` };
  }
  const stats = JSON.parse(stdout);
  // 実出力: models[] = { model: { id, providerID }, steps, tokens: {input,output,cache:{read,write}}, cost }
  const models = (stats.models ?? []).map((m) => ({
    provider: m.model?.providerID ?? "-",
    model: m.model?.id ?? "-",
    inputTokens: m.tokens?.input ?? 0,
    outputTokens: m.tokens?.output ?? 0,
    cacheRead: m.tokens?.cache?.read ?? 0,
    cacheWrite: m.tokens?.cache?.write ?? 0,
    cost: m.cost ?? 0,
    calls: m.steps ?? 0,
  }));
  // opencode go のプロバイダ ID だけに絞る
  const goModels = models.filter((m) => m.provider === "opencode-go");
  return {
    ok: true,
    range: "過去7日",
    sessions: stats.sessions ?? 0,
    totals: sumModels(goModels),
    models: goModels,
    note: "opencode go の残量 API は公開されていないため、このマシンでの記録値です。",
  };
}

// ---------- 表示 ----------

const fmtN = (n) => Number(n ?? 0).toLocaleString("en-US");
const fmtUsd = (n) => `$${Number(n ?? 0).toFixed(4)}`;

function renderGlm(g) {
  const out = ["■ GLM（Z.AI）" + (g.level ? `  プラン: ${g.level}` : "")];
  if (!g.ok) return [...out, `  ✗ ${g.error}`].join("\n");
  for (const l of g.limits) {
    const pct = l.percentage != null ? `${l.percentage}%` : "-";
    const warn = l.percentage >= 90 ? " ⚠️ 上限間近" : "";
    out.push(`  ${l.label}（${l.window}）: ${pct} 使用${warn}  リセット: ${l.resetAt}`);
    if (l.usage != null) out.push(`      上限 ${fmtN(l.usage)} / 残 ${fmtN(l.remaining)}`);
    for (const d of l.details) out.push(`      - ${d.model}: ${fmtN(d.usage)}`);
  }
  return out.join("\n");
}

function renderOpencode(o) {
  const out = ["■ opencode go（" + o.range + "）"];
  if (!o.ok) return [...out, `  ✗ ${o.error}`].join("\n");
  const t = o.totals;
  out.push(`  セッション ${fmtN(o.sessions)} / 呼び出し ${fmtN(t.calls)}`);
  out.push(`  入力 ${fmtN(t.input)} / 出力 ${fmtN(t.output)} / キャッシュ読 ${fmtN(t.cacheRead)}`);
  out.push(`  コスト ${fmtUsd(t.cost)}`);
  if (o.models.length) {
    out.push("  モデル別:");
    for (const m of o.models) {
      out.push(`    - ${m.model}: 入力 ${fmtN(m.inputTokens)} / 出力 ${fmtN(m.outputTokens)} / ${fmtUsd(m.cost)}`);
    }
  }
  out.push(`  ※ ${o.note}`);
  return out.join("\n");
}

async function main() {
  const result = {};
  if (target === "all" || target === "glm") result.glm = await fetchGlm();
  if (target === "all" || target === "opencode") result.opencode = await fetchOpencodeGo();

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const blocks = [];
  if (result.glm) blocks.push(renderGlm(result.glm));
  if (result.opencode) blocks.push(renderOpencode(result.opencode));
  console.log(blocks.join("\n\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
