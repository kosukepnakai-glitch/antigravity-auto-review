# Antigravity 承認レビュー v3：利用ガイド

Antigravity（2.19.1.0以降対応）で、安全性を維持したまま日々のコーディングにおける承認クリック（確認ダイアログ）を最小限に抑えるための利用ガイドです。

- ワークスペース内の**通常ファイルの新規作成・部分編集**を自動審査（確認0回）。
- 登録したProjectの**追跡済みGit状態・差分行数**を固定隔離ヘルパーで確認（確認0回）。
- 未登録Project、任意コマンド、既存ファイルの丸ごと上書き、保護対象パスへのアクセスは確実に確認または拒否します。

---

## クイックスタート（導入手順）

### 1. 前提条件
- **OS**: Windows 10 / 11
- **Node.js**: v20 以上（`node -v` で確認）
- **PowerShell**: Windows PowerShell 5.1 または PowerShell 7

### 2. インストール
管理者権限不要の通常のPowerShellターミナルで、解凍した本パッケージのフォルダーから以下を実行します。

```powershell
# 事前チェック（ファイルの変更は行いません）
& '.\install.ps1' -AllConversations -CheckOnly

# グローバル設定への配置（初回は安全のため enabled: false で配置されます）
& '.\install.ps1' -AllConversations
```

配置後、Antigravity の **Settings > Customizations > Hooks** で `codex-style-auto-review` が追加されていることを確認できます。

### 3. 対象プロジェクトの登録（Git自動確認を使う場合）
プロジェクトごとの安全性を守るため、コマンドの自動実行許可はリポジトリ（Project）ごとに登録します。

1. 次のコマンドを実行して、登録用コマンド文字列を取得します：
   ```powershell
   node "$env:USERPROFILE\.gemini\config\auto-review\restricted-policy.mjs" --project-grants "C:\path\to\your-project"
   ```
2. 出力された `terminalCommandsUiRule` の2つの正規表現ルールを、Antigravity の **Project設定 > Permissions > Terminal Commands** に Allow として登録します。
3. 対象プロジェクトフォルダー直下に `.agents\rules\antigravity-tracked-review.md` を配置し、上記コマンドで出力された固定コマンドを記載します（詳細は `AGENT-RULE.template.md` および `examples/` を参照）。

---

## 普段の使い方

Antigravityのチャットで、通常通りコーディングを依頼したり、Gitの状態を尋ねたりします。

例：
- 「この関数のバグを修正して」（通常ファイルの編集 → **確認0回で実行**）
- 「このプロジェクトの追跡済みファイルの変更状態と差分の行数を教えて」（登録済みProjectでのGit確認 → **確認0回で即答**）

### 判定の範囲

| 対象 | 判定と範囲 |
|---|---|
| **hookが審査する5 tools** | `run_command`、`write_to_file`、`replace_file_content`、`multi_replace_file_content`、`read_url_content` |
| **自動許可される通常編集** | ワークスペース内の通常ファイルの新規作成、`replace_file_content` による部分置換 |
| **固定Git helper** | `tracked-status` と `tracked-diff-stat`（追跡済みファイルの状態・差分統計のみ） |
| **確認が残る操作** | 既存ファイルの丸ごと上書き（`write_to_file`）、未登録Projectでのコマンド、自由なコマンド（`npm`, `build`, 任意Git）、外部URL読み取り |
| **拒否される操作** | `.git`, `.agents`, `.gemini`, `.ssh`, `.vscode` 等の保護パスへの変更 |

---

## 標準の配置先

| 用途 | パス |
|---|---|
| 共通hook設定 | `%USERPROFILE%\.gemini\config\hooks.json` |
| helperスクリプト・ポリシー | `%USERPROFILE%\.gemini\config\auto-review\` |
| 共通案内ルール | `%USERPROFILE%\.gemini\config\rules\codex-style-auto-review.md` |
| 登録Projectの固定案内 | 対象Project内 `.agents\rules\antigravity-tracked-review.md` |

---

## 停止と復帰

一時的に機能を無効化したい場合や、元に戻したい場合は [停止・復帰ガイド](DISABLE-RESTORE.ja.md) を参照してください。
helperのポリシーフラグの変更、UIからのルール削除、hookの無効化を段階的かつ安全に行う手順が記載されています。
