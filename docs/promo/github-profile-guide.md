# GitHub プロフィール編集ガイド（TKY-27）

編集ページ: https://github.com/settings/profile （Brave で開いてあります）

## 1. Bio（クリップボードに入っています・157字/上限160）

```
AI engineering: on-device inference, Metal/GPU, LLM agent tooling. Rust / Swift / TS. Building a shogi AI engine, image-gen on Apple Silicon & agent plugins.
```

→ Edit profile → Bio に貼り付け

## 2. Name（任意）

現在 TKY-27。表示名を足すなら例:
- `TKY-27` のまま（ハンドル名として一貫）
- `TKY-27 · AI engineer`（肩書き入り）

## 3. Pinned repositories（推奨構成）

AI開発者としての印象を最優先するなら:

| pin | 理由 |
|---|---|
| **OpenShogiAI** | Rust + ニューラルネット評価の将棋AIエンジン（最强の実績） |
| **iris-3b-metal** | Apple Silicon での画像生成エンジン（on-device AI / GPU） |
| **dsh-usage-panel** | LLM エージェントツール（本日の公開プラグイン） |
| **MacEase** | ネイティブ macOS 開発の実績 |
| OpenShogiUI / inmu-factorizer | 外す（UIとネタ枠は5枠に入れなくてよい） |

手順: profile の「Customize your pins」→ 上の4つを選ぶ

## 4. dsh-usage-panel を push（pin の前に必須）

```bash
cd ~/dsh-workspaces/default/dsh-usage-panel
git remote add origin git@github.com:reoanrudo/dsh-usage-panel.git   # または https URL
git push -u origin main
```

※ リポジトリの About 欄（右サイド）に description を設定すると pin 時に説明が出ます:
`Usage panel for DeepSeek Harness: GLM/Codex/Claude/DeepSeek/opencode go/Command Code in one popup`
Topics: `deepseek` `glm` `claude` `ai-tools` `electron` 等

## 5. README profile README（任意・さらにAI寄りにするなら）

reoanrudo/reoanrudo リポジトリを作ると profile 上部に大きな自己紹介が出せます。
作る場合は言ってください — 雛形を書きます。


---

# X (Twitter) プロフィール編集

編集ページ: https://x.com/settings/profile （Brave で開いてあります）
（自分のアカウントでログイン済みであること）

## 名前（Name・50字以内）

```
TKY-27 / AI tools
```

## 自己紹介（Bio・160字以内）※クリップボードに入っています

```
AI開発エンジニア。将棋AI（Rust+NN）、Apple Silicon画像生成（Metal）、LLMエージェントツール（DSH プラグイン）など、on-device AI と開発ツールを作っています。Rust / Swift / TS。
```

英語版がよければ:

```
AI engineering — shogi AI engine in Rust, image generation on Apple Silicon (Metal), LLM agent tooling. Rust / Swift / TS.
```

## その他

- 場所 (Location): `Japan`
- ウェブサイト (Website): `https://github.com/TKY-27`
- pinned post: dsh-usage-panel のリリース投稿を pinned にすると良い
- バナー画像（ヘッダ）: AI開発者らしいバナーが必要なら作成します（1500x500）
