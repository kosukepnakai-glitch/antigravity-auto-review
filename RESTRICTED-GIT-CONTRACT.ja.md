# 隔離した追跡変更の概要 — 統合用候補

実装は `restricted-git.mjs`。Node標準ライブラリのみを使う。元の作業ディレクトリではGitを起動せず、検査した通常ファイルを専用の一時ディレクトリへコピーしてから、固定Gitで追跡変更の概要を作る。元repoは変更しない。

これは**隔離された設定での追跡済みファイル比較**である。通常のGitの全設定を再現するものではなく、リポジトリ全体がcleanであることや、通常Gitの出力との一般的な一致を示さない。全成功結果に `scope`、`trackedOnly`、日本語の範囲説明と適用した設定を返す。

## 実行契約

統合候補の固定PowerShellランチャーは、ユーザーの「今回の子プロセスだけ許可する」という明示承認を受け、`-ExecutionPolicy RemoteSigned` を `-File` の直前へ指定する。これは当該PowerShellセッションと設定を継承する子セッションへのProcess指定で、単一ファイル限定のOS権限ではない。固定コマンド・asset検査で実行内容を限定し、runnerのGit子環境へpolicy環境変数を継承しない。永続設定、`Set-ExecutionPolicy`、`Bypass`、任意スクリプトへの許可拡大は行わない。組織のMachinePolicy/UserPolicyによる制限は解除しない。完全一致コマンドとProject専用regexにはこの固定引数を含め、省略・他のpolicyへの変更・追加引数を自動許可しない。

信頼された起動処理から、stdinに次のJSONを渡す。コマンドやGit引数の選択機能はない。CLIでは余分なトップレベルフィールドを拒否する。

```json
{
  "repoPath": "C:\\approved\\project",
  "gitPath": "C:\\Program Files\\Git\\cmd\\git.exe",
  "gitSha256": "信頼policyで固定した64桁のSHA-256",
  "defaults": {
    "autocrlf": "false",
    "eol": "native",
    "attributes": "disabled-external"
  }
}
```

成功はexit 0、`ok:true`、`statusShort`、`unstagedStat`、`stagedStat`を返す。内容を表示するdiffは実行しない。失敗・未対応・制限超過・元データの変更検出はexit 2、`ok:false`、`code`と短い理由を返す。失敗を通常のGit実行へ自動的に置き換えてはならない。

stdinは32,000 UTF-8バイト、3秒に制限する。Node自体のpreloadはこのスクリプトより前に動くため、信頼された起動処理で `NODE_OPTIONS` と `NODE_PATH` を除去する必要がある。信頼policy・runner・起動スクリプトの改変検査と、許可する固定コマンドの厳密照合は統合側の責任。

## 対応範囲と判定

- ローカルの通常 `.git` ディレクトリを持つSHA-1 repo。通常ファイルだけのindex v2/v3。
- HEAD、refs、packed-refs、index、objectsを検査してコピーする。indexはstatキャッシュをリセットし、実行を伴わない既知の最適化拡張を除いて再構成する。未知拡張、split/sparse、競合、skip-worktree、assume-unchangedは停止する。
- Gitfile、commondir、config.worktree、shallow、grafts、info/attributes、alternates/http-alternates、partial cloneのpromisor pack、submodule、リンクは停止する。
- 追跡対象の保護・機密パス、`.gitmodules`、削除をstage済みの保護対象やsubmoduleも停止する。対象の一部だけを黙って省略しない。
- 追跡対象と、削除等をstage済みの対象の全祖先にある `.gitattributes` は、未追跡でも検査・コピーする。`.gitattributes` 自身がindexから削除されても、作業ツリーに残っていれば属性入力として扱う。存在しない属性ファイルも確認後に出現したら停止する。
- `.git/config` は一時的な「解析用データ」としてのみコピーし、`git config --no-includes --file` で読む。snapshotの実効configにはしない。hooksはコピーしない。
- localの `autocrlf`、`eol`、`safecrlf`、`filemode`、`ignorecase` は許可した値だけ採用する。user名/email、remote URL/fetch、branchのremote/merge等、今回の処理に影響しない既知キーは非適用と結果に表示する。include、filter、fsmonitor、external diff、任意pager、hooksPath、その他未知キーは停止する。
- global/system configと属性は適用しない。`defaults` は外部設定の不存在を表す自己申告ではなく、隔離profileの指定である。
- 未追跡ファイルの変更は集計しない。追跡比較に影響する未追跡 `.gitattributes` は上記の通り入力として扱う。
- objects/infoの既知の `packs` / `commit-graph` は読み取り検査・変更検出を行い、最適化用cacheとして非適用にしたことを結果に表示する。未知のmetadataは停止する。

## 実行と制限

Git実行ファイルを絶対パスで固定し、起動ごとにSHA-256を再検査する。Git for Windowsが正規配布で実行ファイルをハードリンクにする場合は固定binaryとして扱う。repo内のハードリンクは引き続き拒否する。

Gitは `shell:false`、snapshotのcwd、`--no-pager --no-optional-locks --no-lazy-fetch` で起動する。環境は新規allowlistから作り、ambient `GIT_*`、PATH、pager、trace、外部object/index/worktree指定を継承しない。global/system config、system attributes、replace refs、対話入力、通信プロトコルを無効化し、HOME/TEMP等を専用tempへ向ける。diffは `--no-ext-diff --no-textconv` を指定する。

コピーは20,000ファイル・合計256MiB・1ファイル32MiB、追跡数10,000件まで。解析用configと追加属性は1MiBまで。metadataの各ディレクトリ列挙も有界。snapshotのobject一覧から展開サイズも1個32MiB・合計256MiB・20,000個まで確認する。各Git子プロセス10秒・出力4MiB、snapshot全体30秒を上限とする。Git自身のnative解析器やOS全体へのメモリ隔離を実装したものではない。

読み込みでは祖先と開いたファイルのidentity・サイズ・時刻を確認し、全入力を終了前に再hashする。元configや追跡ファイルが途中で変われば結果を捨てる。一時領域の削除は今回 `mkdtemp` で作った領域だけに限定する。

**Nodeの通常パスAPIでは、別プロセスによる意図的な同時ジャンクション差替え等を原子的に封じることはできない。** 固定Gitとそのインストール、Node、OS、起動処理を信頼し、作業対象が安定している前提が残る。これはOSサンドボックスや、同一ユーザー権限の攻撃者からの隔離を保証する実装ではない。

## 検証

`run-tests.mjs` が使い捨てrepoだけで試験し、`test-result.json`、`test-stdout.log`、`test-stderr.log`、`test-observations.json` に記録する。比較対象Gitも外部global/system設定を無効化した制御済みfixtureであり、一般的なユーザー環境との同一性を主張する試験ではない。

実Antigravityによる承認削減、既存拒否との関係、固定ランチャーからの結線はこの候補単体の試験範囲外。
