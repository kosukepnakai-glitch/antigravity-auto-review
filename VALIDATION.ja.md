# v3 検証範囲（2026-10-03）

2.19.1.0のglobal配置について、新規日本語チャット、未登録Projectの確認維持、停止・復帰を確認しました。以下の版・操作・対象の範囲に限る結果です。実行コードは変更せず、案内・文書と導入状態を更新しました。

## ローカル検証

| 対象 | 結果と再利用範囲 |
|---|---|
| v3変更前のreviewer・installer・結線 | 24 + 11 + 8 = 43成功、skip 0。旧版のhashとともに `V3-LOCAL-VALIDATION.json` のpriorRevisionへ保存 |
| レビュー済み子RemoteSigned反映後 | 影響する結線3件成功、skip 0。現行receiptのfilesが実行コード・試験コードに対応。43件すべての再実行ではない |
| 隔離Git runner | 14成功、skip 0。runner hash `0e13fcae36cae1d346858c55bd8bd4db2934302e80960d0849c00213ee129031`。独立レビューの属性欠落修正確認を含む |
| 文書・案内 | 実行コードとは別hash。Project固定案内とglobal案内の変更後に実機の新規自然文チャットを確認 |

Node24.15.0、Windows PowerShell5.1とPowerShell7を使用しました。Node20・別OSの実行結果ではありません。ローカル試験を実アプリ試験の件数に含めません。

## 実アプリ2.18.1.0：fixture段階

| 観測 | 主な証跡 |
|---|---|
| 固定差分統計の確認1→0、状態も0。日本語の新規chatも期待結果 | `v3-useful-baseline.json`、`v3-useful-positive.json`、`v3-natural-language.json` |
| 通常作成・部分編集0Ask。範囲外・上書き・未知command・redirect変形はAsk、拒否後marker不在 | `v3-boundaries.json` |
| helper無効、独立hash不一致で固定helperはexit1拒否。native許可が残るためAskは0 | `v3-disabled-native.json`、`v3-independent-hash-refusal.json` |
| Project移動、所有許可削除によるAsk復帰、復元後2操作0Ask | `v3-project-scope.json`、`v3-lifecycle.json` |
| wrapper不正応答・異常終了・timeout・Node欠落・reviewer欠落の5件はAskへ戻り、拒否後marker不在 | `wrapper-native-faults.json`、`wrapper-native-missing-node.json`、`wrapper-native-missing-reviewer.json` |

保護対象Denyにはアプリ内エージェント報告によるものがあります。復元UIの1行が途中で切れ、完全readback一致はnullでした。機能上の2操作成功と区別します。

## 実アプリ2.19.1.0：更新・global段階

| 観測 | 主な証跡 |
|---|---|
| 利用者承認後に更新・再起動、新規日本語chatの2操作0Ask | `v3-update-restart.json`、`v3-update-positive.json` |
| hook/native Denyのエラー報告、marker不在 | `v3-update-denials.json` |
| reviewer欠落はfallback理由付きAsk、拒否後に復旧 | `v3-update-reviewer-failure.json` |
| hook無効・native許可ありでも変形commandはAsk、拒否後marker不在 | `v3-update-native-variant.json` |
| global helper＋案内修正後、Project-aの新規自然文chatが2操作0Askで期待結果。ユーザー指示にコマンド文字列なし | `v3-global-positive.json` |
| 未登録Project-bはglobal helperを選ぶがAsk1、拒否して停止 | `v3-global-scope-ask.json` |
| local hook不在のProject-bで共通hook拒否のエラー報告、保護marker不在 | `v3-global-scope-deny.json` |
| global helper/hook/両案内を停止し許可0本→同じ操作Ask1を拒否。8 pinsと設定を復元、UIの2本がそれぞれ一致true、復元後の新規自然文2操作Ask0で期待結果 | `v3-global-lifecycle.json`、`global-lifecycle-runs/acceptance-20261003-final-retry1` の3 success receipt |

global案内の初回は小文字ドライブ表記で完全一致許可から外れ、Askへ戻りました。実行コードや許可の範囲を変えず、登録Projectの固定案内を追加して再試験しました。旧版の全故障ケースを新版で再実行したという意味ではありません。

停止・復帰用の作業補助スクリプトは初回にWindows PowerShellの引数変換で設定変更前に失敗しました。4対象の初期hash一致とfailure receiptを保持し、明示backupパスへ修正した再試行の3段階が成功しました。今回の導入に固有の補助スクリプトは証跡として保持し、portableな製品コマンドには含めません。この結果を製品runtimeの43/3/14件へ合算しません。

現行global復元の2ルールはUI readbackがともにtrueです。旧2.18.1.0 fixtureのnullを置き換えず、別時点の結果として残しています。

## 信頼境界と履歴

対応hookは5 toolsのみ。共通hook/案内と、登録Project限定の固定2コマンド許可は別です。Gitは隔離設定での追跡済み状態・統計に限定します。未追跡変更・patch本文・外部設定は含めず、通常Gitとの一般的同値やrepo全体cleanを保証しません。

OS・固定実行ファイル・導入済みcode/policyを信頼します。OS sandboxや意図的な同時差し替えの原子的排除ではありません。任意のnative file Denyを子GitのファイルI/Oへ継承する保証もありません。

前段候補の文書は `historical/VALIDATION.pre-v3.ja.md` に元bytesを保存しました。`candidate-validation.json`、`integration-test.log`、旧manifestは履歴資料です。現行の実行コード対応は `V3-LOCAL-VALIDATION.json`、最終配布の全file hashは生成する `SHA256SUMS.txt` で示します。
