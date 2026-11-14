# awesome-dsh-plugin への登録手順

## 現在の状態
- エントリファイル準備済み: /tmp/reoanrudo__dsh-usage-panel.yml（リポジトリにも同梱: docs/market/）
- リポジトリは push 済み: https://github.com/reoanrudo/dsh-usage-panel
- SSH 認証 OK（git@github.com:reoanrudo）

## 手順（fork ページを開いてあります）
1. https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork で **Create fork** を押す
2. fork 完了後、このメッセージに「fork した」と伝える
3. 以下を自動実行します:
   - fork を clone → ブランチ add-usage-panel 作成
   - data/plugins/reoanrudo__dsh-usage-panel.yml を追加
   - commit → push → PR 作成ページを開く

## PR 本文（ドラフト）
```
Add reoanrudo/dsh-usage-panel (category: usage)

- dsh.bundle manifest declared in bundle/package.json (root package re-exports)
- Multi-subscription usage popup: GLM, opencode go, Codex, Claude, DeepSeek, Command Code
- Quota-reset consumption for GLM / Codex (read-only display for Claude)
- Peak-hour clock for time-of-day pricing (GLM, DeepSeek)
- Local-only credential handling; reset POSTs gated by header + Origin allow-list
- Screenshots declared in screenshots.json
```
