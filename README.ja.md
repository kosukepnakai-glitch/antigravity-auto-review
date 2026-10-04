# Antigravity 承認レビューフック v3（Windows）

## 概要と検証状況

Antigravity（2.19.1.0以降対応）において、通常ファイルの新規作成・部分編集および追跡済みGit状態・差分統計を自動審査し、日常的な確認クリック（ダイアログ表示）を削減するための安全制御フックです。

- **共通hookの対象**: `run_command`、`write_to_file`、`replace_file_content`、`multi_replace_file_content`、`read_url_content` の 5 tools。
- **ターミナルの自動許可**: 明示的に登録した Project の固定コマンド（完全一致2本）のみ。
- **未登録Project / 任意コマンド**: 従来の確認ダイアログを厳格に維持。
- **保護対象パス**: `.git` や `.gemini`、`.ssh` 等への操作は自動拒否（Deny）。

普段の使い方は [利用ガイド](USER-GUIDE.ja.md)、停止・復帰操作は [停止・復帰ガイド](DISABLE-RESTORE.ja.md) を参照してください。

---

## v3 の有効化境界とアーキテクチャ

本システムは、固定コマンド末尾の ` 2>&1` と、helper自身が読み取る `restricted-policy.json` の厳格な `enabled` フラグ（policy schema version 2）によって保護されます。
配置直後は必ず `enabled:false` であり、installer の `-Enable` は hook だけを有効にします。helperフラグが false・欠落・boolean 以外の場合、起動スクリプトは Node を起動する前に停止し、reviewer も固定コマンドを自動許可しません。driver も runner を import する前に同一 policy を再検査します。

配置後に次を実行すると、指定した正規リポジトリ専用の2コマンドと、Terminal Commands UIへ入力する正規表現を JSON で表示します（native権限の追加や helper の有効化は行いません）。

```text
node <配置先のrestricted-policy.mjs> --project-grants <正規repo絶対パス>
```

Global には共通 hook と helper を配置できます。native Allow は対象 Project ごとに出力された2本を登録する設計とし、WorkspacePath をワイルドカードにしたルールや repo 別ルールの Global 登録は行いません。未登録 Project は従来の確認を維持します。

自然文チャットで固定コマンドを安定して選ばせるため、登録済み Project には正規パス入りの2コマンドを記載する所有ルール（`.agents\rules\antigravity-tracked-review.md`）も配置します。共通 global ルールはその Project 用案内を優先します。

**インストーラーの既定は無効です。実運用では、共通global配置を有効化し、利用する対象Projectごとに完全一致許可2本を登録します。Globalの包括的なnativeコマンド許可は追加しません。**

追跡済みファイルを一時コピーし、隔離したGit設定で比較します。未追跡ファイルと外部 global/system 設定・属性は対象外で、リポジトリ全体が clean であることや通常Gitとの一般的な同値性は示しません。

配置先の `auto-review/COMMANDS.ja.md` に、チャットへ渡せる2つのコマンドを記載します。Project配置では `.agents`、共通配置では `%USERPROFILE%\.gemini\config` がその親です。対象リポジトリの正規絶対パスを `WorkspacePath` と `run_command.Cwd` の両方に指定します。

`restricted-policy.json` は配置時に生成する固定の隣接設定で、Node・Git・Windows PowerShell・レビューコード・サポート・ランナー・ランチャーの SHA-256 とパスを保持します。環境変数やツール引数から別 policy を指定する機構はありません。実行ファイルやスクリプトが更新されて SHA が変わった場合、自動許可を即座に停止します。

ユーザーの明示承認に基づき、固定ヘルパーは `-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File` で起動します。`Set-ExecutionPolicy`、永続設定の変更、`Bypass` は使いません。ランチャーは子Nodeの `NODE_OPTIONS` と `NODE_PATH` を除去します。

---

## 何を自動化するか

| 操作 | 判定 |
|---|---|
| ワークスペース内の通常ファイルの新規作成・部分編集 | 自動許可 |
| 既存ファイルを `write_to_file` で上書き | 確認 |
| `.git`、`.agents`、`.gemini`、`.codex`、`.ssh`、`.aws`、`.vscode`、`.idea` 内の変更 | 拒否 |
| 機密ファイル、シェル起動設定、特殊なパス、リンク、範囲外の変更 | 確認 |
| 固定ランチャーの2つの追跡済みGit比較 | 配置policy・SHA・引数・対象パスが一致した場合のみ許可 |
| その他のターミナルコマンド（任意Git・テスト・ビルドを含む） | 確認 |
| 外部URLの読み取り | 確認 |

「通常ファイル」と判定するには、存在するローカルワークスペース内にあり、パスの全階層にシンボリックリンク・ジャンクションがなく、既存対象が通常ファイルでリンク数が1である必要があります。既存ファイルの部分編集は、編集対象の文字列と置換内容も必要です。

Gitの設定やシェルの定義次第で、見た目が読み取りコマンドでもプログラムが実行される可能性があるため、任意のコマンド文字列を読み取り専用と推定して自動許可することはありません。

---

## 導入前の確認と配置

Windows、Node.js 20以上、Windows PowerShell 5.1またはPowerShell 7が必要です。Nodeは導入時に検出した絶対パスに固定します。npmパッケージは不要です。

まず使い捨てのテストフォルダーを用意して、次を実行します。

```powershell
& '.\install.ps1' -WorkspacePath 'C:\path\to\test-project' -CheckOnly
& '.\install.ps1' -WorkspacePath 'C:\path\to\test-project' -WhatIf
& '.\install.ps1' -WorkspacePath 'C:\path\to\test-project'
```

`-CheckOnly` はNodeのバージョン、スクリプトの構文、確認へのフォールバック、既存設定等を検査して終了します。ファイルは変更しません。通常の配置では `.agents/auto-review/auto_review.mjs` と `.agents/hooks.json` が追加され、フックは `enabled: false` のままです。

全チャット向けの共通配置は次を実行します。

```powershell
& '.\install.ps1' -AllConversations -CheckOnly
& '.\install.ps1' -AllConversations
```

共通配置先は `%USERPROFILE%\.gemini\config\` です。
有効化は Antigravity の **Settings > Customizations > Hooks** で対象フックを選びます。

---

## テスト

```powershell
node --test .\tests\auto_review.test.mjs
node --test .\tests\install.test.mjs
node --test .\tests\restricted-integration.test.mjs
```

フック本体では、通常編集に加え、Git・特殊パス・保護ルート・ハードリンクなどの境界挙動を網羅的に検査します。導入テストは使い捨てフォルダーで試験し、実際のグローバル設定を変更しません。

---

## 無効化

製品全体の停止には [停止・復帰ガイド](DISABLE-RESTORE.ja.md) を使います。
helperの信頼された `restricted-policy.json` を `enabled:false` にし、登録した Project grant を削除した後、Global の `codex-style-auto-review` hook を無効にし、所有する案内ルールを退役します。

---

## 仕様と実装

判断ロジックは `auto_review.mjs`、配置処理は `install.ps1` にすべて記載しています。Windowsの複数のシェルで同じように起動するため、フックの起動コマンドはPowerShellのEncodedCommandを使います。

- [Antigravity Hooks](https://antigravity.google/docs/hooks)
- [Antigravity Permissions](https://antigravity.google/docs/permissions)
- [Antigravity Terminal Sandbox](https://antigravity.google/docs/sandbox)
