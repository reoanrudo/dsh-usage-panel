// Client half: 使用量ポップオーバー。
//
// なぜ main ページではなくポップアップなのか:
//   DSH は main スロットを entryKey で差し替えるため、ページ型パネルを開くと会話ビューが
//   アンマウントされ、戻る時に再マウントされる（「別ページへ移る時の遅さ」の正体）。
//   shell.overlay のポップアップなら会話ビューを保持したまま重ねられ、開閉は即時。
//
// 起動: サイドバー下部の「使用量」ボタン（ボタンの少し上に表示）。
// 閉じる: 同じボタン / × / Escape。
// データ: 使用量サーバー（127.0.0.1:50071、Host側が自動起動）。
//   localStorage の前回値を開いた瞬間に表示し、裏で更新（Stale-While-Revalidate）。
//   閉じている間はポーリングしない。内容が変わらなければ再描画しない。

window.__ModuleLoader__.load({
  id: "@dsh-community/dsh-usage-panel",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState, useCallback, useRef } = React;
    const startTransition = React.startTransition ?? null;

    const NS = "@dsh-community/dsh-usage-panel";
    const API = "http://127.0.0.1:50071/api/usage";
    const RESET_API = "http://127.0.0.1:50071/api/glm/reset";
    const CODEX_RESET_API = "http://127.0.0.1:50071/api/codex/reset";
    const POLL_MS = 30_000;
    const STYLE_ID = "sup-usage-style";
    const CACHE_KEY = "sup-usage-cache-v1";

    const L = {
      en: {
        panel: "Usage", title: "Usage", refresh: "Refresh", close: "Close",
        updated: "Updated", error: "Error", loading: "Loading…", reset: "Resets", plan: "Plan",
        account: "Account", balance: "Balance", statInput: "Input", statOutput: "Output",
        statCost: "Cost", services: "services", none: "No connected subscriptions.",
        peak: "Peak", offPeak: "Off-peak", peakNextRange: "next peak", peakEndsIn: "ends in", peakStartsIn: "starts in",
        serverDown: "Usage server is not running. Reload the DSH app (it starts the server), or run: node server.mjs",
        quotaReset: "Quota reset", fiveHour: "5-hour quota", weekly: "Weekly quota", resetCredits: "Usage resets",
        left: "left", noneLeft: "none left", resetBtn: "Reset", confirm: "Use 1 reset?",
        useNow: "Use reset", cancel: "Cancel", resetting: "Resetting…", resetDone: "Reset applied",
        resetFailed: "Reset failed", expires: "expires", irreversible: "This cannot be undone.",
        resetNoGrant: "No reset credits granted to this account", resetUnavailable: "Reset credits are not available for this account",
        reorderHint: "Drag to reorder", orderReset: "Reset order",
      },
      ja: {
        panel: "使用量", title: "使用量", refresh: "更新", close: "閉じる",
        updated: "更新", error: "エラー", loading: "読み込み中…", reset: "リセット", plan: "プラン",
        account: "アカウント", balance: "残高", statInput: "入力", statOutput: "出力",
        statCost: "コスト", services: "件", none: "連携しているサブスクがありません。",
        peak: "ピーク", offPeak: "オフピーク", peakNextRange: "次回ピーク", peakEndsIn: "終了まで", peakStartsIn: "開始まで",
        serverDown: "使用量サーバーが停止中です。DSHを再起動すると自動で立ち上がります（または `node server.mjs`）",
        quotaReset: "使用量リセット", fiveHour: "5時間枠", weekly: "週枠", resetCredits: "使用量リセット権",
        left: "回", noneLeft: "残りなし", resetBtn: "リセット", confirm: "リセット権を1回使いますか？",
        useNow: "リセットする", cancel: "キャンセル", resetting: "リセット中…", resetDone: "リセットしました",
        resetFailed: "リセットに失敗", expires: "有効期限", irreversible: "この操作は取り消せません。",
        resetNoGrant: "このアカウントにはリセット権が付与されていません", resetUnavailable: "このアカウントではリセット権を利用できません",
        reorderHint: "ドラッグで並べ替え", orderReset: "並び順をリセット",
      },
    };
    // UI は英語固定（ユーザー指定）。日本語文言は L.ja に残している。
    const lang = "en";
    const t = (k) => L[lang][k] ?? k;

    // 各アプリの実アイコン（data URI、ビルド時注入）
    const ICONS = {"commandcode":"data:image/png;base64,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","glm":"data:image/png;base64,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","opencode-go":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABdElEQVR42u3bMW6DMBQG4N8hgEAMFVKI6FKClI5V1IzNXSL1Ahm6VLlDh1ygUu4CY3oE0hNEXViobHdKd0KQ6/I/ifHZ8OnxbEsgbpNEY8AxwsCDAAQgAAEIQAACEIAAQ41x1wHedjvks5mRm6+OR7xsNmYBHpdL3M/nRgBu4tj8K/DdNMbK9xpzswkSgABcBnsLrTWajo3K8zwIIewEqOsaz+s1yqJAluetcj+rCk+rFd73e0RRZG8FlEXx+0BtoywKaK3ZAwhAAAIQwFqAuywzkvsnlkEhBB4WCyTTKRzHaZUrpUSapr1ugnoHAADf9xEEwUUAvu/bXQHnzdD5uiSPTZAABCAAAQhAAAIQgAAEsPMsoJSClLJ1npQSSin7j8PJZIKx42DU8jSopEQcx3Yfh8MwxOt222kM13XtrgDP89gECUAAAvxfANdgk7vG3J1XgY/DAV+nE0x9Jtd5peI/Q+wBBCAAAQhAAAIQgAAEGGT8ABW7X4/ISSYiAAAAAElFTkSuQmCC","codex":"data:image/png;base64,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","claude":"data:image/png;base64,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","deepseek":"data:image/png;base64,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"};

    const CSS = `
      .sup-root { box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Helvetica Neue", sans-serif;
        -webkit-font-smoothing: antialiased; color: var(--text); font-size: 12px; line-height: 1.4;
        --bg:#F5F5F7; --card:#FFFFFF; --text:#1d1d1f; --text2:rgba(60,60,67,.62); --text3:rgba(60,60,67,.36);
        --line:rgba(0,0,0,.08); --blue:#007AFF; --orange:#FF9500; --red:#FF3B30;
        --green:#34C759;
        --peaktrack:rgba(52,199,89,.22);
        --track:rgba(120,120,128,.2); --pill:rgba(120,120,128,.14); --tile:#FFFFFF; --tileline:rgba(0,0,0,.07); }
      .sup-root, .sup-root * { box-sizing: border-box; }
      .sup-root p { margin: 0; }
      @media (prefers-color-scheme: dark) { .sup-root {
        --bg:#1c1c1e; --card:#2c2c2e; --text:#f5f5f7; --text2:rgba(235,235,245,.62); --text3:rgba(235,235,245,.36);
        --line:rgba(255,255,255,.1); --blue:#0A84FF; --orange:#FF9F0A; --red:#FF453A;
        --green:#30D158; --peaktrack:rgba(48,209,88,.30);
        --track:rgba(120,120,128,.34); --pill:rgba(120,120,128,.26); --tile:#3a3a3c; --tileline:rgba(255,255,255,.14); } }

      /* ポップオーバー（サイドバー下部ボタンの上に出す） */
      .sup-pop { position:absolute; left:16px; bottom:58px; width:min(320px, calc(100vw - 32px));
        max-height:calc(100vh - 70px); /* 全カードが見えることを優先。溢れたらスクロール */
        display:flex; flex-direction:column; overflow:hidden;
        background:var(--card); border:1px solid var(--line); border-radius:14px;
        box-shadow:0 18px 50px rgba(0,0,0,.26), 0 2px 6px rgba(0,0,0,.10);
        animation:supin .12s ease-out; }
      @keyframes supin { from { opacity:0; transform:translateY(5px) scale(.995); } to { opacity:1; transform:none; } }
      @media (prefers-reduced-motion: reduce) { .sup-pop { animation:none; } }

      .sup-pop-head { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 12px;
        border-bottom:1px solid var(--line); flex:none; }
      .sup-pop-title { font-size:12.5px; font-weight:650; letter-spacing:-.01em; }
      .sup-pop-sub { font-size:10px; color:var(--text2); }
      .sup-spacer { flex:1; }
      .sup-btn { appearance:none; width:22px; height:22px; padding:0; border-radius:50%; border:1px solid var(--line);
        background:transparent; color:var(--text2); cursor:pointer; display:flex; align-items:center;
        justify-content:center; transition:background .15s ease; flex:none; }
      .sup-btn:hover { background:var(--pill); color:var(--text); }
      .sup-btn svg { display:block; }
      .sup-spin { animation:supspin .8s linear infinite; }
      @keyframes supspin { to { transform:rotate(360deg); } }

      .sup-pop-body { padding:2px 0; overflow:auto; }
      .sup-banner { margin:8px 12px; padding:8px 10px; border-radius:9px; background:rgba(255,59,48,.1);
        color:var(--red); font-size:11px; }
      .sup-empty { color:var(--text2); margin:12px 14px; }

      .sup-svc { padding:7px 11px; }
      .sup-svc + .sup-svc { border-top:1px solid var(--line); }
      /* ドラッグ並べ替え */
      .sup-svc-drag { cursor:grab; color:var(--text3); flex:none; width:14px; height:22px;
        display:flex; align-items:center; justify-content:center; border:0; background:transparent;
        padding:0; margin-left:-3px; }
      .sup-svc-drag:active { cursor:grabbing; }
      .sup-svc-drag svg { pointer-events:none; }
      .sup-svc.dragging { opacity:.45; background:var(--tile); }
      .sup-svc.drag-over-top { box-shadow:inset 0 2px 0 var(--blue); }
      .sup-svc.drag-over-bottom { box-shadow:inset 0 -2px 0 var(--blue); }
      .sup-svc.drag-last { box-shadow:inset 0 -2px 0 var(--blue); }
      .sup-chead { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .sup-ic { width:22px; height:22px; border-radius:5px; flex:none; overflow:hidden;
        background:var(--tile); border:0; display:flex; align-items:center; justify-content:center; }
      .sup-ic img { width:100%; height:100%; object-fit:cover; display:block; }
      .sup-ic-fallback { font-size:11px; font-weight:700; color:var(--text2); }
      .sup-cname { font-size:12px; font-weight:600; letter-spacing:-.01em; }
      .sup-cacct { font-size:9.5px; color:var(--text3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px; }
      .sup-pill { margin-left:auto; font-size:10px; font-weight:600; padding:1px 7px; border-radius:999px;
        background:var(--pill); color:var(--text2); flex:none; }

      .sup-bar { margin:5px 0; }
      .sup-barrow { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:2px; }
      .sup-bname { font-size:10.5px; color:var(--text); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:64%; }
      .sup-bpct { font-size:10px; font-weight:650; font-variant-numeric:tabular-nums; }
      .sup-track { height:4px; border-radius:999px; background:var(--track); overflow:hidden; }
      .sup-fill { height:100%; border-radius:999px; }
      .sup-cap { font-size:9px; color:var(--text3); margin-top:1px; font-variant-numeric:tabular-nums; }

      .sup-bal { display:flex; align-items:baseline; gap:5px; margin:1px 0 2px; }
      .sup-bal b { font-size:20px; font-weight:700; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
      .sup-bal span { font-size:11px; color:var(--text2); }

      .sup-foot { font-size:9.5px; color:var(--text3); margin-top:6px; }
      .sup-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:5px; vertical-align:1px; }

      /* GLM の使用量リセット権 */
      .sup-reset { margin-top:7px; padding-top:6px; border-top:1px solid var(--line); }
      .sup-reset-simple { display:flex; align-items:baseline; gap:6px; margin:3px 0; }
      .sup-reset-num { font-weight:650; color:var(--text); font-variant-numeric:tabular-nums; }
      .sup-reset-hint { font-size:9.5px; color:var(--text2); }
      .sup-reset-title { font-size:9.5px; font-weight:650; letter-spacing:.02em; text-transform:uppercase;
        color:var(--text3); margin-bottom:3px; }
      .sup-reset-row { display:flex; align-items:center; gap:6px; margin:3px 0; }
      .sup-reset-label { font-size:10.5px; color:var(--text); font-weight:500; }
      .sup-reset-count { font-size:9.5px; color:var(--text2); margin-left:auto; font-variant-numeric:tabular-nums; white-space:nowrap; }
      .sup-reset-btn { appearance:none; flex:none; border:1px solid var(--line); background:var(--tile); color:var(--text);
        font:inherit; font-size:10px; font-weight:600; padding:2px 8px; border-radius:6px; cursor:pointer;
        transition:background .15s ease, opacity .15s ease; }
      .sup-reset-btn:hover { background:var(--pill); }
      .sup-reset-btn:disabled { opacity:.4; cursor:default; }
      .sup-reset-btn.danger { background:var(--red); border-color:transparent; color:#fff; }
      .sup-reset-cap { font-size:9px; color:var(--text3); margin:0 0 1px 0; }
      .sup-reset-msg { font-size:9.5px; margin-top:2px; }
      .sup-reset-msg.ok { color:var(--blue); }
      .sup-reset-msg.err { color:var(--red); }
      .sup-reset-msg.warn { color:var(--orange); }

      .sup-backdrop { position:absolute; inset:0; z-index:29; background:rgba(0,0,0,.30);
        animation:supfade .12s ease-out; }
      @keyframes supfade { from { opacity:0; } to { opacity:1; } }
      @media (prefers-reduced-motion: reduce) { .sup-backdrop { animation:none; } }
      .sup-popwrap { display:contents; }

      /* サイドバー下部の開閉ボタン */
      .sup-fbtn { display:flex; align-items:center; gap:6px; height:28px; padding:0 8px; border-radius:8px;
        border:0; background:transparent; color:inherit; cursor:pointer; font:inherit; font-size:12px;
        opacity:.8; transition:background .15s ease, opacity .15s ease; }
      .sup-fbtn:hover { background:rgba(127,127,127,.18); opacity:1; }
      .sup-fbtn svg { display:block; flex:none; }

      /* ピーク時間帯（価格が時間帯で変わるモデル）。
         「ピーク区間の開始–終了」を必ず数字で文字表示し、その下に24時間バンドと
         時刻軸（00/06/12/18/24）を置く。バンドの位置を時計読みで推定させない。
         色だけに頼らないよう、ピーク/オフピークの語と倍率を必ず併記する。 */
      .sup-peak { margin:0 0 6px; }
      .sup-peak-row { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:2px; }
      .sup-peak-chip { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:650;
        font-variant-numeric:tabular-nums; white-space:nowrap; }
      .sup-peak[data-peak="on"] .sup-peak-chip { color:var(--orange); }
      .sup-peak[data-peak="off"] .sup-peak-chip { color:var(--green); }
      .sup-peak-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
      .sup-peak-when { font-size:9.5px; color:var(--text2); font-variant-numeric:tabular-nums;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sup-peak-range { font-weight:650; color:var(--text); }
      .sup-peak-band { position:relative; height:7px; }
      .sup-peak-track { position:absolute; inset:0; border-radius:999px; background:var(--peaktrack); }
      .sup-peak-seg { position:absolute; top:0; bottom:0; min-width:2px; border-radius:999px; background:var(--orange); }
      .sup-peak-tick { position:absolute; top:0; bottom:0; width:1px; background:rgba(127,127,128,.5); }
      .sup-peak-now { position:absolute; top:-1.5px; bottom:-1.5px; width:2px; margin-left:-1px;
        border-radius:1px; background:var(--text); box-shadow:0 0 0 1px var(--card); }
      .sup-peak-axis { position:relative; height:11px; margin-top:2px; font-size:9px; color:var(--text3);
        font-variant-numeric:tabular-nums; }
      .sup-peak-axis span { position:absolute; top:1px; transform:translateX(-50%); }
      .sup-peak-axis span:first-child { transform:none; }
      .sup-peak-axis span:last-child { transform:translateX(-100%); }

    `;

    // スタイルはプラグイン起動時に1度だけ注入（削除しない＝切替時のスタイル再計算を起こさない）
    let styleInjected = false;
    // 既存タグがあっても中身が古ければ差し替える（プラグインのHMRでCSSだけ更新された
    // ときに、古いスタイルが残り続けるのを防ぐ）。
    const ensureStyle = () => {
      if (typeof document === "undefined") return;
      const existing = document.getElementById(STYLE_ID);
      if (existing && existing.textContent === CSS) { styleInjected = true; return; }
      const el = existing ?? document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      if (!el.parentNode) document.head.appendChild(el);
      styleInjected = true;
    };

    // 開閉状態（サイドバーのボタンとポップアップで共有）
    let openState = false;
    const openListeners = new Set();
    const setOpen = (v) => {
      if (openState === v) return;
      openState = v;
      for (const l of openListeners) l();
    };
    const useOpen = () => {
      const [o, setO] = useState(openState);
      useEffect(() => {
        const l = () => setO(openState);
        openListeners.add(l);
        return () => { openListeners.delete(l); };
      }, []);
      return o;
    };

    function BrandIcon({ id }) {
      const src = ICONS[id];
      if (!src) return h("div", { className: "sup-ic" }, h("span", { className: "sup-ic-fallback" }, (id || "?").slice(0, 1).toUpperCase()));
      return h("div", { className: "sup-ic" }, h("img", { src, alt: "", draggable: false }));
    }

    const quotaColor = (p) => (p >= 90 ? "var(--red)" : p >= 70 ? "var(--orange)" : "var(--blue)");
    const num = (n) => Number(n ?? 0).toLocaleString("en-US");

    // ---- ピーク時間帯（価格が時間帯で変わるモデル） -------------------------
    //
    // 規則は「ゾーン時刻＋曜日＋窓」で持つ。表示は閲覧者のローカル時刻。
    //   tz      : ゾーンの UTC オフセット（分）。Asia/Shanghai = +480。
    //   days    : ピーク対象の曜日（0=日 … 6=土）。
    //   windows : 窓 [from, to) をゾーン時刻の分で。
    //
    // GLM（Z.ai Coding Plan）: 平日 14:00-18:00（Asia/Shanghai）。ローカルに取得済みの
    //   peakrate ドキュメント（zai-glm-5-3, 2026-10-20 時点）に一致。ピーク 1× /
    //   オフピーク 0.5×（＝ピークはオフピークの2倍）。
    // DeepSeek: 平日 09:00-12:00 / 14:00-18:00（Asia/Shanghai）。中国の祝日は終日
    //   オフピークだが、祝日表はここには持たない（週末のみ判定）。
    const PEAK_RULES = {
      glm: { tz: 480, days: [1, 2, 3, 4, 5], windows: [[14 * 60, 18 * 60]], ratioOn: "×2", ratioOff: "½" },
      deepseek: { tz: 480, days: [1, 2, 3, 4, 5], windows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]], ratioOn: "×2", ratioOff: "½" },
    };
    const PEAK_STEP_MS = 5 * 60_000;

    /** ゾーン時刻の曜日と分。 */
    function zoneParts(rule, ms) {
      const d = new Date(ms + rule.tz * 60_000);
      return { weekday: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
    }

    /** そのゾーン日 00:00 の epoch ms。 */
    function zoneDayStart(rule, ms) {
      const d = new Date(ms + rule.tz * 60_000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - rule.tz * 60_000;
    }

    /** その瞬間が窓の中なら窓を返す。 */
    function windowAt(rule, ms) {
      const { weekday, minute } = zoneParts(rule, ms);
      if (!rule.days.includes(weekday)) return null;
      for (const w of rule.windows) if (minute >= w[0] && minute < w[1]) return w;
      return null;
    }

    /** 現在のピーク判定と、次の切り替わり時刻。 */
    function peakPeriodAt(rule, ms) {
      const win = windowAt(rule, ms);
      const { minute } = zoneParts(rule, ms);
      if (win) return { peak: true, boundaryMs: zoneDayStart(rule, ms) + win[1] * 60_000 };
      const dayStart = zoneDayStart(rule, ms);
      for (let d = 0; d < 8; d += 1) {
        const ds = dayStart + d * 86_400_000;
        const wd = new Date(ds + rule.tz * 60_000).getUTCDay();
        if (!rule.days.includes(wd)) continue;
        for (const w of rule.windows) {
          if (d === 0 && w[0] <= minute) continue;
          return { peak: false, boundaryMs: ds + w[0] * 60_000 };
        }
      }
      return { peak: false, boundaryMs: ms + 86_400_000 };
    }

    /** 今日（閲覧者のローカル日）のピーク区間。 */
    function peakBands(rule, now) {
      const d = new Date(now);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const bands = [];
      let open = null;
      for (let t = start; t < end; t += PEAK_STEP_MS) {
        const peak = windowAt(rule, t) !== null;
        if (peak && open === null) open = t;
        else if (!peak && open !== null) { bands.push({ start: open, end: t }); open = null; }
      }
      if (open !== null) bands.push({ start: open, end });
      return { start, end, bands };
    }

    /** 今または次ピーク窓の開始・終了（ローカル瞬時値）。計画に使うのはこの2点。 */
    function peakRangeAt(rule, ms) {
      const win = windowAt(rule, ms);
      if (win) {
        const ds = zoneDayStart(rule, ms);
        return { peak: true, from: ds + win[0] * 60_000, to: ds + win[1] * 60_000 };
      }
      const next = peakPeriodAt(rule, ms); // boundaryMs = 次の窓の開始
      const w = windowAt(rule, next.boundaryMs);
      const ds = zoneDayStart(rule, next.boundaryMs);
      return { peak: false, from: next.boundaryMs, to: ds + w[1] * 60_000 };
    }

    const pct = (v) => (Math.round(v * 10) / 10) + "%";
    const hm = (ms) => {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    const wdShort = (ms) => {
      try { return new Date(ms).toLocaleDateString("en-US", { weekday: "short" }); } catch { return ""; }
    };
    const remainText = (ms) => {
      const minutes = Math.max(0, Math.ceil(ms / 60_000));
      const hrs = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return hrs > 0 ? hrs + "h " + rest + "m" : rest + "m";
    };

    /**
     * 1サービス分のピーク時計。
     *  1行目: 現在の区分（Peak ×2 / Off-peak ½）と、対象窓の「開始–終了」＋残り時間。
     *        ピク中は今窓の終了まで、オフピーク中は次回窓の開始までをカウントする。
     *        窓が別日を跨ぐときは曜日を接頭辞に付ける。
     *  2行目: 今日の0:00-24:00バンド。オレンジ=ピーク、緑=オフピーク、
     *        目盛り（6/12/18時）と時刻軸（00 06 12 18 24）で位置を数字で読める。
     *        白い縦線が現在時刻。
     */
    function PeakClock({ rule }) {
      const [, setTick] = useState(0);
      useEffect(() => {
        const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 30_000);
        return () => clearInterval(id);
      }, []);
      const now = Date.now();
      const period = peakPeriodAt(rule, now);
      const range = peakRangeAt(rule, now);
      const { start, end, bands } = peakBands(rule, now);
      const span = Math.max(1, end - start);
      const state = period.peak ? "on" : "off";
      const sameDay = new Date(range.from).toDateString() === new Date(now).toDateString();
      const rangeLabel = (sameDay ? "" : wdShort(range.from) + " ") + hm(range.from) + "–" + hm(range.to);
      const lead = period.peak ? "" : t("peakNextRange") + " ";
      const dur = (period.peak ? t("peakEndsIn") : t("peakStartsIn")) + " " + remainText(Math.max(0, period.boundaryMs - now));
      const chip = state === "on" ? t("peak") + " " + rule.ratioOn : t("offPeak") + " " + rule.ratioOff;
      const nowPct = Math.min(100, Math.max(0, ((now - start) / span) * 100));
      return h("div", { className: "sup-peak", "data-peak": state, title: lead + rangeLabel + " · " + dur },
        h("div", { className: "sup-peak-row" },
          h("span", { className: "sup-peak-chip" },
            h("i", { className: "sup-peak-dot" }), chip),
          h("span", { className: "sup-peak-when" },
            lead, h("span", { className: "sup-peak-range" }, rangeLabel), " · " + dur)),
        h("div", { className: "sup-peak-band" },
          h("i", { className: "sup-peak-track" }),
          [25, 50, 75].map((x) => h("i", { key: x, className: "sup-peak-tick", style: { left: x + "%" } })),
          bands.map((b, i) => h("i", {
            key: i,
            className: "sup-peak-seg",
            style: { left: pct(((b.start - start) / span) * 100), width: pct(((b.end - b.start) / span) * 100) },
          })),
          h("i", { className: "sup-peak-now", style: { left: pct(nowPct) } })),
        h("div", { className: "sup-peak-axis" },
          [0, 6, 12, 18, 24].map((hr) => h("span", { key: hr, style: { left: pct((hr / 24) * 100) } },
            String(hr).padStart(2, "0")))));
    }

    const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;

    function Bar({ w }) {
      const p = w.percent ?? null;
      const color = quotaColor(p ?? 0);
      return h("div", { className: "sup-bar" },
        h("div", { className: "sup-barrow" },
          h("span", { className: "sup-bname" }, w.label),
          h("span", { className: "sup-bpct", style: { color } }, p == null ? "—" : `${p}%`)),
        h("div", { className: "sup-track" },
          h("div", { className: "sup-fill", style: { width: `${Math.min(100, Math.max(0, p ?? 0))}%`, background: color } })),
        (w.resetAt || w.detail) && h("div", { className: "sup-cap" },
          [w.resetAt && `${t("reset")}: ${w.resetAt}`, w.detail].filter(Boolean).join(" · ")));
    }

    /**
     * Codex の使用量リセット権の1行。GLM と同じ2段確認（Reset → Use reset）。
     * 実行しない限り何も消費しない（タイミングは利用者が決める）。
     */
    function CodexResetRow({ info, credits, onDone }) {
      const [phase, setPhase] = useState("idle"); // idle | confirm | busy | done | error
      const [error, setError] = useState(null);
      const count = info?.available ?? 0;
      const busy = phase === "busy";
      const expires = credits && credits.length > 0 ? credits[0].expiresAt : null;

      const run = async () => {
        if (busy) return;
        setPhase("busy");
        setError(null);
        try {
          const res = await fetch(CODEX_RESET_API, {
            method: "POST",
            headers: { "content-type": "application/json", "x-sup-reset": "1" },
            body: JSON.stringify({}),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
          setPhase("done");
          onDone?.();
          setTimeout(() => setPhase("idle"), 4000);
        } catch (e) {
          setError(String(e?.message ?? e));
          setPhase("error");
        }
      };

      const controls = [];
      if (phase === "confirm") {
        controls.push(h("button", { key: "yes", type: "button", className: "sup-reset-btn danger", onClick: run }, t("useNow")));
        controls.push(h("button", { key: "no", type: "button", className: "sup-reset-btn", onClick: () => setPhase("idle") }, t("cancel")));
      } else {
        controls.push(h("button", {
          key: "reset",
          type: "button",
          className: "sup-reset-btn",
          disabled: busy || count <= 0,
          onClick: () => setPhase("confirm"),
          title: count <= 0 ? t("noneLeft") : `${t("confirm")} ${t("irreversible")}`,
        }, busy ? t("resetting") : t("resetBtn")));
      }

      let note = null;
      if (phase === "confirm") note = h("div", { className: "sup-reset-msg warn" }, `${t("confirm")} ${t("irreversible")}`);
      else if (phase === "done") note = h("div", { className: "sup-reset-msg ok" }, t("resetDone"));
      else if (phase === "error") note = h("div", { className: "sup-reset-msg err", title: error }, `${t("resetFailed")}: ${error}`);

      return h("div", null,
        h("div", { className: "sup-reset-row" },
          h("span", { className: "sup-reset-label" }, t("resetCredits")),
          h("span", { className: "sup-reset-count" }, count > 0 ? `${count} ${t("left")}` : t("noneLeft")),
          ...controls),
        expires && h("div", { className: "sup-reset-cap" }, `${t("expires")}: ${expires}`),
        note);
    }

    /**
     * 読み取り専用のリセット権表示（Claude など、このパネルからは消費しないサービス用）。
     */
    function ResetCreditsInfo({ info }) {
      const count = info?.available ?? 0;
      const hint = info?.eligible === false
        ? (info.reason === "no_grant" ? t("resetNoGrant") : t("resetUnavailable"))
        : null;
      return h("div", null,
        h("div", { className: "sup-reset-row" },
          h("span", { className: "sup-reset-label" }, t("resetCredits")),
          h("span", { className: "sup-reset-count" }, count > 0 ? `${count} ${t("left")}` : t("noneLeft"))),
        info?.expiresAt && h("div", { className: "sup-reset-cap" }, `${t("expires")}: ${info.expiresAt}`),
        hint && h("div", { className: "sup-reset-cap" }, hint));
    }

    /**
     * 使用量リセット権の1行。
     *  - 残数を表示し、「Reset」→ インライン確認 →「Use reset」で消費する（取り消し不可）。
     *  - 成功したら onDone() で使用量を再取得する。
     */
    function ResetRow({ kind, label, info, onDone }) {
      const [phase, setPhase] = useState("idle"); // idle | confirm | busy | done | error
      const [error, setError] = useState(null);
      const count = info?.count ?? 0;
      const busy = phase === "busy";

      const run = async () => {
        if (busy) return;
        setPhase("busy");
        setError(null);
        try {
          const res = await fetch(RESET_API, {
            method: "POST",
            headers: { "content-type": "application/json", "x-sup-reset": "1" },
            body: JSON.stringify({ type: kind }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
          setPhase("done");
          onDone?.();
          setTimeout(() => setPhase("idle"), 4000);
        } catch (e) {
          setError(String(e?.message ?? e));
          setPhase("error");
        }
      };

      const controls = [];
      if (phase === "confirm") {
        controls.push(h("button", { key: "yes", type: "button", className: "sup-reset-btn danger", onClick: run }, t("useNow")));
        controls.push(h("button", { key: "no", type: "button", className: "sup-reset-btn", onClick: () => setPhase("idle") }, t("cancel")));
      } else {
        controls.push(h("button", {
          key: "reset",
          type: "button",
          className: "sup-reset-btn",
          disabled: busy || count <= 0,
          onClick: () => setPhase("confirm"),
          title: count <= 0 ? t("noneLeft") : `${t("confirm")} ${t("irreversible")}`,
        }, busy ? t("resetting") : t("resetBtn")));
      }

      let note = null;
      if (phase === "confirm") note = h("div", { className: "sup-reset-msg warn" }, `${t("confirm")} ${t("irreversible")}`);
      else if (phase === "done") note = h("div", { className: "sup-reset-msg ok" }, t("resetDone"));
      else if (phase === "error") note = h("div", { className: "sup-reset-msg err", title: error }, `${t("resetFailed")}: ${error}`);

      return h("div", null,
        h("div", { className: "sup-reset-row" },
          h("span", { className: "sup-reset-label" }, label),
          h("span", { className: "sup-reset-count" }, count > 0 ? `${count} ${t("left")}` : t("noneLeft")),
          ...controls),
        info?.expiresAt && h("div", { className: "sup-reset-cap" }, `${t("expires")}: ${info.expiresAt}`),
        note);
    }

    // ----- 表示順の保存・復元 -----
    // ドラッグで並べ替えた順（サービスidの配列）を localStorage に保存する。
    // 未指定の id は既定順の後に追加、削除された id は無視（データ駆動で自動追従）。
    const ORDER_KEY = "sup-usage-order-v1";

    function readOrder() {
      try {
        const raw = localStorage.getItem(ORDER_KEY);
        const arr = raw ? JSON.parse(raw) : null;
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
      } catch {
        return [];
      }
    }

    function writeOrder(order) {
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* 無視 */ }
    }

    /** 既定順に保存順を適用する。未知idは末尾へ、未登録の既定idは元位置に残す。 */
    function applyOrder(subs, order) {
      if (!order.length) return subs;
      const rank = new Map(order.map((id, i) => [id, i]));
      return [...subs].sort((a, b) => {
        const ra = rank.has(a.id), rb = rank.has(b.id);
        if (ra && rb) return rank.get(a.id) - rank.get(b.id);
        if (ra) return -1;
        if (rb) return 1;
        return subs.indexOf(a) - subs.indexOf(b); // 両方未指定なら既定順維持
      });
    }

    const Service = React.memo(function Service({ s, onResetDone, drag }) {
      const head = h("div", { className: "sup-chead" },
        drag && h("button", {
          className: "sup-svc-drag", title: t("reorderHint"), "aria-label": t("reorderHint"),
          ...drag.handle,
        },
          h("svg", { viewBox: "0 0 10 16", width: 8, height: 14 },
            h("circle", { cx: 3, cy: 4, r: 1.2, fill: "currentColor" }), h("circle", { cx: 7, cy: 4, r: 1.2, fill: "currentColor" }),
            h("circle", { cx: 3, cy: 8, r: 1.2, fill: "currentColor" }), h("circle", { cx: 7, cy: 8, r: 1.2, fill: "currentColor" }),
            h("circle", { cx: 3, cy: 12, r: 1.2, fill: "currentColor" }), h("circle", { cx: 7, cy: 12, r: 1.2, fill: "currentColor" }))),
        h(BrandIcon, { id: s.id }),
        h("div", { style: { minWidth: 0 } },
          h("div", { className: "sup-cname" }, s.name),
          s.account && h("div", { className: "sup-cacct", title: s.account }, s.account)),
        s.plan && h("span", { className: "sup-pill" }, s.plan));

      let body;
      if (s.status === "error") {
        body = h("div", { style: { color: "var(--red)", fontSize: 11 } },
          h("span", { className: "sup-dot", style: { background: "var(--red)" } }),
          `${t("error")}: ${s.error}`);
      } else if (s.balance) {
        body = h("div", { className: "sup-bal" },
          h("b", null, `${s.balance.amount}`),
          h("span", null, s.balance.currency));
      } else {
        body = (s.windows ?? []).map((w) => h(Bar, { key: w.label, w }));
      }

      // 価格が時間帯で変わるサービスだけ、カードにピーク時計を出す。
      const peakRule = PEAK_RULES[s.id];

      // GLM の使用量リセット権（ZCode の coding-plan と同じもの）
      const reset = s.reset
        ? h("div", { className: "sup-reset" },
            h("div", { className: "sup-reset-title" }, t("quotaReset")),
            h(ResetRow, { kind: "FIVE_HOUR", label: t("fiveHour"), info: s.reset.fiveHour, onDone: onResetDone }),
            h(ResetRow, { kind: "WEEK", label: t("weekly"), info: s.reset.week, onDone: onResetDone }))
        : (s.resetCredits && typeof s.resetCredits.available === "number"
            ? h("div", { className: "sup-reset" },
                h("div", { className: "sup-reset-title" }, t("resetCredits")),
                s.id === "codex"
                  ? h(CodexResetRow, { info: s.resetCredits, credits: s.resetCreditsDetail || [], onDone: onResetDone })
                  : h(ResetCreditsInfo, { info: s.resetCredits }))
            : null);

      const foot = [];
      if (s.summary) foot.push(`${s.summary.range}: ${t("statInput")} ${num(s.summary.input)} · ${t("statOutput")} ${num(s.summary.output)} · ${t("statCost")} ${usd(s.summary.cost)}`);
      for (const n of s.notes ?? []) foot.push(n);

      const svcClass = "sup-svc" + (drag?.dragging ? " dragging" : "")
        + (drag?.dropSide === "top" ? " drag-over-top" : "")
        + (drag?.dropSide === "bottom" ? " drag-over-bottom" : "");
      return h("div", { className: svcClass, ...drag?.item }, head,
        peakRule ? h(PeakClock, { rule: peakRule }) : null, body, reset,
        foot.length ? h("div", { className: "sup-foot" }, foot.map((f, i) => h("div", { key: i }, f))) : null);
    });

    function readCache() {
      try {
        if (typeof localStorage === "undefined") return null;
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    /** 開いている間だけマウントされる本体（閉じればポーリングも止まる） */
    function UsagePopover() {
      const [data, setData] = useState(readCache);
      const [err, setErr] = useState(null);
      const [loading, setLoading] = useState(false);
      const abortRef = useRef(null);
      const lastJsonRef = useRef(null);
      // ドラッグ並べ替え: 順序は localStorage、途中経過は state で管理する
      const [order, setOrder] = useState(readOrder);
      const dragRef = useRef(null); // { id, fromIndex, toIndex } ドラッグ中の移動先
      const [dragId, setDragId] = useState(null);
      const [overId, setOverId] = useState(null);
      const [overSide, setOverSide] = useState(null);

      const load = useCallback((manual, force = true) => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        if (manual) setLoading(true);
        // force=true でサーバーのキャッシュを迂回し、常に最新を取得する
        fetch(API + (force ? "?refresh=1" : ""), { cache: "no-store", signal: ac.signal })
          .then((r) => r.json())
          .then((j) => {
            if (ac.signal.aborted) return;
            const json = JSON.stringify(j);
            if (json === lastJsonRef.current) return; // 内容が同じなら再描画しない
            lastJsonRef.current = json;
            const apply = () => { setData(j); setErr(null); };
            if (startTransition) startTransition(apply); else apply();
            const save = () => { try { localStorage.setItem(CACHE_KEY, json); } catch { /* 無視 */ } };
            if (typeof requestIdleCallback === "function") requestIdleCallback(save, { timeout: 2000 }); else setTimeout(save, 0);
          })
          .catch(() => { if (!ac.signal.aborted) setErr(t("serverDown")); })
          .finally(() => { if (!ac.signal.aborted && manual) setLoading(false); });
      }, []);

      const handleResetDone = useCallback(() => { load(true); }, [load]);

      useEffect(() => {
        ensureStyle();
        load(data == null, true);           // 開いた瞬間に最新を取得（表示はキャッシュで即時）
        const id = setInterval(() => { if (!document.hidden) load(false, true); }, POLL_MS);
        return () => { clearInterval(id); abortRef.current?.abort(); };
      }, [load]);

      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      const connectedAll = (data?.subscriptions ?? []).filter((s) => s.connected);
      const connected = applyOrder(connectedAll, order);

      // ----- ドラッグ並べ替え（HTML5 DnD。ハンドル掴み時のみ draggable にする）-----
      const onDragStart = useCallback((e, id) => {
        dragRef.current = { id, toIndex: null };
        setDragId(id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id); // Firefox は data が無いと drag を開始しない
      }, []);
      const onDragEnd = useCallback(() => {
        const st = dragRef.current;
        dragRef.current = null;
        setDragId(null); setOverId(null); setOverSide(null);
        // ドロップ確定: 掴んだカードを toIndex へ移動して保存
        if (st && st.toIndex !== null) {
          setOrder((prev) => {
            const ids = applyOrder(connectedAll, prev).map((s) => s.id);
            const from = ids.indexOf(st.id);
            if (from === -1) return prev;
            let to = st.toIndex;
            to = Math.max(0, Math.min(ids.length - 1, to));
            if (to === from) return prev;
            const next = [...ids];
            next.splice(from, 1);
            next.splice(to, 0, st.id);
            writeOrder(next);
            return next;
          });
        }
      }, [connectedAll]);
      const onDragOver = useCallback((e, id) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const st = dragRef.current;
        if (!st || st.id === id) return;
        const el = e.currentTarget;
        const side = e.clientY - el.getBoundingClientRect().top < el.getBoundingClientRect().height / 2 ? "top" : "bottom";
        setOverId(id); setOverSide(side);
        const ids = applyOrder(connectedAll, order).map((s) => s.id);
        const fromIdx = ids.indexOf(st.id);
        const overIdx = ids.indexOf(id);
        if (fromIdx === -1 || overIdx === -1) return;
        // 上半分ならその要素の前に、下半分なら後ろに挿入
        st.toIndex = side === "top" ? overIdx : overIdx + 1;
      }, [connectedAll, order]);

      const resetOrder = useCallback(() => {
        try { localStorage.removeItem(ORDER_KEY); } catch { /* 無視 */ }
        setOrder([]);
      }, []);

      return h("div", { className: "sup-root sup-pop", role: "dialog", "aria-label": t("title") },
        h("div", { className: "sup-pop-head" },
          h("span", { className: "sup-pop-title" }, t("title")),
          data && h("span", { className: "sup-pop-sub" }, `${connected.length}${t("services")} · ${data.generatedAt}`),
          h("span", { className: "sup-spacer" }),
          h("button", { className: "sup-btn", title: t("refresh"), onClick: () => load(true, true), disabled: loading },
            h("svg", { className: loading ? "sup-spin" : undefined, viewBox: "0 0 16 16", width: 12, height: 12 },
              h("path", { d: "M13.2 8A5.2 5.2 0 1 1 8 2.8c1.9 0 3.5.98 4.4 2.45", fill: "none",
                stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }),
              h("path", { d: "M12.9 1.7v3.4H9.5", fill: "none", stroke: "currentColor",
                strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" }))),
          order.length > 0 && h("button", { className: "sup-btn", title: t("orderReset"), "aria-label": t("orderReset"), onClick: resetOrder },
            h("svg", { viewBox: "0 0 16 16", width: 12, height: 12 },
              h("path", { d: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }))),
          h("button", { className: "sup-btn", title: t("close"), "aria-label": t("close"), onClick: () => setOpen(false) },
            h("svg", { viewBox: "0 0 16 16", width: 11, height: 11 },
              h("path", { d: "M4 4l8 8M12 4l-8 8", fill: "none", stroke: "currentColor",
                strokeWidth: "1.8", strokeLinecap: "round" })))),
        h("div", { className: "sup-pop-body" },
          err && h("div", { className: "sup-banner" }, err),
          !data && !err && h("p", { className: "sup-empty" }, t("loading")),
          data && !connected.length && h("p", { className: "sup-empty" }, t("none")),
          connected.map((s, idx) => h(Service, {
            key: s.id, s, onResetDone: handleResetDone,
            drag: {
              handle: {
                draggable: true,
                onDragStart: (e) => onDragStart(e, s.id),
                onDragEnd,
              },
              item: {
                draggable: false,
                onDragOver: (e) => onDragOver(e, s.id),
                onDrop: onDragEnd,
                onDragLeave: () => { if (overId === s.id) { setOverId(null); setOverSide(null); } },
              },
              dragging: dragId === s.id,
              dropSide: overId === s.id ? overSide : null,
              idx,
            },
          }))));
    }

    function UsageOverlay() {
      const open = useOpen();
      if (!open) return null;
      ensureStyle();
      // 暗いオーバーレイ。外側クリックで閉じ、ポップ内のクリックでは閉じない。
      return h("div", { className: "sup-backdrop", onClick: () => setOpen(false) },
        h("div", { className: "sup-popwrap", onClick: (e) => e.stopPropagation() },
          h(UsagePopover)));
    }

    /** サイドバー下部の開閉ボタン */
    function UsageToggle({ wide }) {
      const open = useOpen();
      ensureStyle();
      return h("button", {
        type: "button",
        className: "sup-fbtn",
        "aria-label": t("panel"),
        "aria-pressed": open || undefined,
        title: t("panel"),
        onClick: () => setOpen(!open),
      },
        h("svg", { viewBox: "0 0 64 64", width: 16, height: 16, "aria-hidden": true },
          h("rect", { x: 8, y: 12, width: 48, height: 40, rx: 9, fill: "currentColor", opacity: 0.85 }),
          h("rect", { x: 17, y: 23, width: 30, height: 5, rx: 2.5, fill: "#fff", opacity: 0.92 }),
          h("rect", { x: 17, y: 34, width: 19, height: 5, rx: 2.5, fill: "#fff", opacity: 0.62 })),
        wide && h("span", null, t("panel")));
    }

    return {
      inject: ["slots"],
      // 純関数のテスト用シーム（DSH は inject/apply だけを使う）
      __peak: { rules: PEAK_RULES, periodAt: peakPeriodAt, bands: peakBands, windowAt, rangeAt: peakRangeAt },
      apply(ctx) {
        ensureStyle();
        ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay",
          id: "subscription-usage-overlay",
          locale: NS,
        }, UsageOverlay));
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
          name: "sidebar.footer.action",
          id: "subscription-usage-toggle",
          locale: NS,
        }, UsageToggle));
      },
    };
  },
});
