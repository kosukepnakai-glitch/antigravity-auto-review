---
trigger: always_on
description: "追跡済みファイルの状態・差分統計を、固定の隔離Gitヘルパーで確認する。承認や権限設定は変更しない。"
---

# 追跡済みGit変更の確認

追跡済みファイルの状態や差分統計が目的に合う場合は、次の固定ヘルパーを使う。無関係な作業では実行しない。これは隔離設定での比較であり、未追跡ファイルの変更・外部global/system設定や属性は対象外。通常Git全体との一致、リポジトリ全体がcleanであること、変更内容そのものの確認として扱わない。

登録済みProjectに、そのProjectの正規パスを埋め込んだ固定コマンドの案内がある場合は、その2本を優先する。対象Projectが一致することを確認し、ドライブ文字を含む大文字・小文字、引用符、空白を案内どおりに保つ。固定コマンドのパスをチャットの表示や推測した表記で作り直さない。

固定コマンドの案内がない場合は、`<CURRENT_WORKSPACE>`を現在開いている対象リポジトリの実在する正規絶対パスへ置き換える。ドライブ文字は大文字（例：`C:`）にする。ドライブ文字から始まるローカルWindowsパスだけを使い、引用符、ドル記号、バッククォート、%、&、|、<、>、^、!、;、丸括弧・波括弧・角括弧・制御文字を含むパスでは使わない。`run_command.Cwd`にも同じパスを指定する。`IsDaemon`と`RunPersistent`はfalseまたは省略、`WaitMsBeforeAsync`は5000とする。コマンドの他の部分を変えたり、引数・別コマンド・リダイレクトを追加したりしない。

追跡済み状態：

```text
C:\windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "C:\Users\<YOUR_USER_NAME>\.gemini\config\auto-review\restricted-launcher.ps1" -Operation tracked-status -WorkspacePath "<CURRENT_WORKSPACE>" 2>&1
```

追跡済み差分の統計：

```text
C:\windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "C:\Users\<YOUR_USER_NAME>\.gemini\config\auto-review\restricted-launcher.ps1" -Operation tracked-diff-stat -WorkspacePath "<CURRENT_WORKSPACE>" 2>&1
```

実行ファイルとヘルパーのパスは、導入時に検証済みの固定パスを設定する。実行するコマンドに未置換のテンプレート項目が残る場合、または対象パスを確認できない場合は実行しない。

このルール自体は権限を付与しない。未登録ProjectのAskや既存の拒否を維持し、表示された承認は利用者に委ねる。grant・policy・enabled・実行ポリシーを自動変更しない。helperが無効・欠落・未対応・失敗の場合は停止理由を伝え、通常Gitや別の実行方法へ黙って切り替えない。必要な代替操作には通常の承認手順を使う。
