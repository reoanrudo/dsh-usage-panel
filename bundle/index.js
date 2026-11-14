/**
 * Host half: DSH（デスクトップ/Web）がこのプラグインをロードした時点で
 * 使用量APIサーバー（127.0.0.1:50071）を自動起動する。
 * これにより `node server.mjs` を手動で実行する必要はなくなる。
 *
 * ポートが既に使われている場合（手動起動や多重ロード）は何もせず、
 * 既存サーバーをそのまま使う。アンロード時は自分が起動したサーバーだけ閉じる。
 */
import { startUsageServer } from "../src/usage-server.mjs";

export function apply() {
  let disposed = false;
  let server = null;
  startUsageServer(50071, "127.0.0.1").then((s) => {
    if (!s) return; // 既に誰かが同じポートで提供している
    if (disposed) {
      s.close();
    } else {
      server = s;
    }
  });
  return () => {
    disposed = true;
    try {
      server?.close();
    } catch {
      /* 既に閉じている場合は無視 */
    }
  };
}
