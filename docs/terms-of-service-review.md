# 規約遵守チェック結果（2026-11-14 調査）

## 結論サマリ

| プロバイダ | 機能 | リスク評価 | 根拠 |
|---|---|---|---|
| **Claude** | usage 表示 + リセット権表示（読み取りのみ） | **🔴 高リスク（規約違反の可能性が高い）** | Anthropic 2026-02-17/18 更新の「Authentication and credential use」 |
| **Claude** | refresh_token 自動更新 | **🔴 同上** | 同上（サードパーティがトークンを保持・更新すること自体が制約対象） |
| **Codex (ChatGPT)** | usage 表示（wham/usage） | **🟡 中リスク** | OpenAI Terms「Automatically or programmatically extracting data」+ 非公式内部 API |
| **Codex (ChatGPT)** | リセット権消費（rate-limit-reset-credits/consume） | **🟡〜🔴 中〜高リスク** | 同上 + 「circumventing any rate limits or restrictions」条項に抵触する解釈の余地 |
| **GLM (Z.AI)** | リセット権消費（zcode reset API） | **🟡 中リスク** | Z.AI Usage Policy「Use limited to supported tools」— ZCode が公式ツールのため、それ以外のツールからは「非対応ツール」になり得る |
| **GLM (Z.AI)** | 使用量表示（api.z.ai quota） | **🟡 低〜中リスク** | API キー認証での読み取り。supported tools 条項の解釈次第 |
| **opencode go** | 公式 usage API | **🟢 低リスク** | 公式 API・公式クライアントのキー |
| **Command Code** | 公式 billing API | **🟢 低リスク** | 公式 API キー認証 |
| **DeepSeek** | 残高スナップショット表示 | **🟢 低リスク** | ローカルスナップショットの読み取りのみ |

## 各規約の該当条項（一次情報）

### Anthropic（最重要・2026-02-17/18 追加）
出典: https://code.claude.com/docs/en/legal-and-compliance

> **OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.**
>
> Developers building products or services that interact with Claude's capabilities ... should use API key authentication through Claude Console or a supported cloud provider. **Anthropic does not permit third-party developers to offer Claude.ai login into their own applications**, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, **developers may not collect, store, or intermediate Claude.ai credentials or session tokens** — sign-in to a Claude account must complete through Anthropic's own flow.
>
> Nor does it prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude subscription...

**このプラグインへの当てはめ:**
- OAuth トークン（Claude.ai ログイン）を第三者ツールから使用して usage API を叩く行為は、
  「third-party developers offering Claude.ai login into their own applications」に該当する解釈が強い
- refresh_token の保持・自動更新は「collect, store, or intermediate credentials」に該当し得る
- **例外的に許される形**: ユーザーが「unmodified Claude Code binary」で自分のサブスクでログインしている場合。
  このプラグインは Claude Code の Keychain 認証情報を読んでいる（keychainBound）ため、
  「unmodified Claude Code binary のセッションを別ツールが使う」グレー領域
- リスク低減策: Claude は表示のみで消費しない（現状その通り）＋ API キー認証ユーザーには対応しない

### OpenAI
出典: https://openai.com/policies/eu-terms-of-use/
- 「Automatically or programmatically extracting data or Output」— usage データの自動取得はこの条項に触れる解釈の余地あり
- 「circumventing any rate limits or restrictions」— **リセット権の消費は rate limit の制限を回避する行為**
  と解釈されるリスク。ただしリセット権は ChatGPT 側が公式に提供している「枠」なので、
  「提供された権利を行使する」ことと「回避」の区別は曖昧
- wham/usage は **undocumented internal API**（community で unofficial reference が共有されている状態）

### Z.AI（GLM）
出典: https://docs.z.ai/devpack/usage-policy
> **Use limited to supported tools: GLM Coding Plan may only be used within officially supported tools and products. Use in unsupported tools may result in restricted benefits.**
> Account sharing or multi-user access is prohibited.

**このプラグインへの当てはめ:**
- リセット権の消費は ZCode（公式ツール）と同じ API をユーザー自身のアカウントで呼ぶ。
  アカウント共有には当たらない（本人のトークン）が、「unsupported tool から的操作」は
  「restricted benefits」の対象になり得る
- リスク低減策: 表示は問題ない。リセット消費は ZCode アプリと同じ挙動（公式ツール経由と実質同一）

## X 投稿文・README の評価

- X 投稿文: 「GLM/Codex の『使用量リセット権』をパネルから直接消費」という記述は **機能の事実** であり、
  規約違反を推奨・助長する記述ではない。ただし、OpenAI/Anthropic の規約が変わった場合、
  この機能自体が使えなくなるリスクを含む
- README には「Codex / Claude usage numbers come from unofficial endpoints and may break」の
  注記があり、非公式 API への依存を明示している ✓
- 「リセットは取り消せない」警告と2段階確認の実装 ✓（誤操作防止）

## 推奨アクション

### 必須（規約リスクを明示）
1. README に「Terms of Service risk」セクションを追加し、以下を明記:
   - Claude usage 表示は Anthropic の OAuth policy（2026-02 追加）と矛盾する可能性
   - Codex リセット消費は OpenAI の rate limit 条項の解釈次第
   - Z.AI の supported-tools 条項
2. X 投稿は既に完了している。投稿内容自体は事実記述なので削除不要だが、
   README に注記を入れることで「知らずに規約違反を助長していた」状況は避けられる

### 推奨（オプション）
3. Claude の usage 表示を **opt-in**（設定で無効デフォルト）にする — Anthropic リスク最大のため
4. Codex リセット消費も opt-in にする
5. GLM リセット消費は ZCode 公式と同じ API なのでそのまま可（ただし README に注記）

## 結論

- **Claude 関連が最もリスクが高い**（Anthropic は明確に「third-party developers が OAuth を使った
  アプリを提供すること」を禁止した）。usage の「表示のみ」といえど、トークンをツールが保持する
  構造自体が規約と矛盾する
- Codex は中リスク。リセット権「消費」は OpenAI 規約の解釈次第
- GLM（Z.AI）は中リスク。ZCode と同じ API なので実質的リスクは低いが、規約文面上は
  「supported tools」条件がある
- opencode go / Command Code / DeepSeek は低リスク
- README に注記を追加することを推奨（このファイル自体をリポジトリに含めるかは任意）
