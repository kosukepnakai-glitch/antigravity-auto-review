# Antigravity Auto-Review Hook (v3)

[![Platform](https://img.shields.io/badge/Platform-Windows-blue?logo=windows)](https://github.com/kosukepnakai-glitch/antigravity-auto-review)
[![Antigravity](https://img.shields.io/badge/Antigravity-v2.19%2B-4285F4?logo=google)](https://github.com/kosukepnakai-glitch/antigravity-auto-review)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0-339933?logo=node.js)](https://github.com/kosukepnakai-glitch/antigravity-auto-review)
[![PowerShell](https://img.shields.io/badge/PowerShell-5.1%20%2F%207-5391FE?logo=powershell)](https://github.com/kosukepnakai-glitch/antigravity-auto-review)

**Antigravity でのペアプログラミングを劇的に快適にする、安全・多層防御の承認レビューフックです。**  
日常的な「通常ファイルの編集」や「追跡済みGitの差分確認」で発生する**確認クリック（ダイアログ）を安全に0回**にし、思考を止めないコーディング体験を提供します。

---

## ⚡ このツールが解決すること

### Before（導入前）
- ❌ コードを1行直すごとに「承認」をクリック…
- ❌ 「今の差分どうなった？」と聞くたびに「承認」をクリック…
- ❌ かといって「全許可」にするのは `.git` や機密ファイルが壊れそうで怖い…

### After（導入後）
- 🚀 **通常ファイルの作成・部分置換はノータイム（確認0回）で進行！**
- 🚀 **「変更状態と差分行数教えて」と日本語で聞くだけで即座に回答！**
- 🛡️ **`.git` や `.env`、既存ファイルの上書き破壊は確実にブロック＆人間に確認！**

---

## 🛡️ 何を自動化し、何をブロックするのか？

「すべてを全自動にする」のではなく、**安全な操作だけをパスし、危険な操作は確実に止める**絶妙なバランスで設計されています。

| 操作種別 | アクション内容 | 判定 |
| :--- | :--- | :---: |
| **自動許可**<br>（確認 0 回） | • ワークスペース内における**通常ファイルの新規作成**<br>• 既存ファイルの**部分置換**（`replace_file_content`）<br>• 登録済みProjectでの**追跡済みGit状態・差分行数の確認**（`tracked-status` / `tracked-diff-stat`） | ⚡ **パス**<br>（作業が止まらない） |
| **確認を維持**<br>（従来通りダイアログ表示） | • 既存ファイルの**丸ごと上書き**（`write_to_file` で既存破壊の恐れがある場合）<br>• **未登録プロジェクト**でのコマンド実行<br>• **自由なコマンド**（`npm`, `build`, `test`, 任意の `git` コマンド等）<br>• 外部 URL のフェッチ（`read_url_content`）<br>• シンボリックリンクやジャンクションの操作 | ❓ **確認**<br>（人が判断） |
| **自動拒否**<br>（即座にブロック） | • `.git`, `.agents`, `.gemini`, `.ssh`, `.vscode` 等の**保護ディレクトリ・設定ファイルへの変更** | 🚫 **拒否（Deny）** |

---

## 🔒 4つの多層防御アーキテクチャ

1. **厳密な 5 ツール監視（PreToolUse フック）**  
   ファイル書き換えやコマンド実行に関わる5つのツールのみを審査します。
2. **改ざん不可能な固定コマンド ＆ 隔離 Git**  
   任意の `git status` ではなく、追跡済みファイルのみを隔離コピーして比較する固定ランチャーを経由。コマンド文字列が空白や末尾リダイレクト（`2>&1`）まで**完全一致**しないと通りません。
3. **8つのアセットを SHA-256 でピン留め**  
   関連スクリプトのハッシュ値を厳格に検証。1文字でもコードが改ざんされたり壊れたりした場合は、**即座に自動停止して確認画面に戻る（フェイル・クローズ）**安全設計です。
4. **Project 単位の最小権限**  
   グローバルにターミナル実行権限を与えず、**あなたが明示的に登録したリポジトリ（Project）でのみ**Git自動確認が機能します。

---

## 🚀 クイックスタート（導入手順）

### 動作要件
* **OS**: Windows 10 / 11
* **Node.js**: v20 以上
* **PowerShell**: Windows PowerShell 5.1 または PowerShell 7
* **Antigravity**: v2.19.1.0 以降

### インストール方法（選べる2つの方法）

#### 方法 A：公式プラグインとして配置（おすすめ）
Antigravity の標準プラグインディレクトリ（`~/.gemini/config/plugins/`）にクローンまたは解凍するだけで、Antigravity が自動認識します。

```powershell
# グローバルプラグインフォルダーへクローン
git clone https://github.com/kosukepnakai-glitch/antigravity-auto-review.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-auto-review"

# 初期セットアップ（安全のためのハッシュ生成・事前チェック）
cd "$env:USERPROFILE\.gemini\config\plugins\antigravity-auto-review"
& '.\install.ps1' -AllConversations
```

#### 方法 B：任意のフォルダーから手動インストール
任意の場所にダウンロード・解凍してセットアップすることも可能です。

```powershell
# 本リポジトリをダウンロード（または git clone）
git clone https://github.com/kosukepnakai-glitch/antigravity-auto-review.git
cd antigravity-auto-review

# 事前チェック（ファイルの変更は行いません）
& '.\install.ps1' -AllConversations -CheckOnly

# グローバル設定へ配置
& '.\install.ps1' -AllConversations
```

### 有効化
Antigravity の **Settings > Customizations > Hooks**（または Plugins）を開き、`codex-style-auto-review`（または `antigravity-auto-review`）をトグル **ON** にします。  
これだけで、通常ファイルの作成・編集が自動審査されるようになります！

> 💡 **Git確認の自動化（確認0回）も使いたい場合：**  
> 詳しい登録手順は [利用ガイド（USER-GUIDE.ja.md）](./USER-GUIDE.ja.md) をご覧ください（2ステップで簡単に追加できます）。

---

## 📖 ドキュメント一覧

* [📘 利用ガイド（USER-GUIDE.ja.md）](./USER-GUIDE.ja.md) - 日常的な使い方とプロジェクト登録の詳細
* [🛑 停止・復帰ガイド（DISABLE-RESTORE.ja.md）](./DISABLE-RESTORE.ja.md) - 安全な停止・元に戻す具体的な手順
* [🔬 詳細技術仕様（README.ja.md）](./README.ja.md) - アーキテクチャと詳細な設計仕様
* [📝 検証記録（VALIDATION.ja.md）](./VALIDATION.ja.md) - テストケースと受け入れ検証記録

---

## 🤝 コントリビューション・フィードバック

不具合の報告や改善の提案は、お気軽に [Issues](https://github.com/kosukepnakai-glitch/antigravity-auto-review/issues) までお寄せください！
気に入っていただけたら、ぜひ右上の **Star (⭐️)** を押していただけると励みになります！
