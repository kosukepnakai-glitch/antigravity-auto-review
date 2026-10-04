# 停止と復帰の具体的な手順

本パッケージで導入した Antigravity 承認レビューフック（global・Project案内）の停止・復帰手順です。
設定ファイルを破壊せず、バックアップを保持しながら安全に切り替えます。

---

## 止める

停止の安全な順序は **helper停止 → Project許可の削除 → global hook停止 → 案内の退役** です。

### 1. helper を停止する

PowerShell ターミナルで以下を実行します。ファイルを削除せず、バックアップを残して `enabled: false` に切り替えます。

```powershell
function Set-ReviewHelperEnabled([bool]$Enabled) {
    $reviewPolicy = Join-Path $env:USERPROFILE '.gemini\config\auto-review\restricted-policy.json'
    if (-not (Test-Path -LiteralPath $reviewPolicy)) { throw "Policy file not found: $reviewPolicy" }
    
    $reviewData = Get-Content -LiteralPath $reviewPolicy -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($reviewData.version -ne 2 -or $reviewData.profile -cne 'isolated-tracked-git-v1' -or
        $reviewData.enabled -isnot [bool]) { throw 'Unexpected helper policy; stop.' }
    
    if ($Enabled) {
        $reviewAssets = @($reviewData.assets.PSObject.Properties)
        if ($reviewAssets.Count -ne 8) { throw 'Expected exactly 8 pinned assets.' }
        foreach ($reviewAsset in $reviewAssets) {
            $actualHash = (Get-FileHash -LiteralPath $reviewAsset.Value.path -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($actualHash -ine $reviewAsset.Value.sha256) { throw "Asset changed: $($reviewAsset.Name)" }
        }
    }
    $reviewData.enabled = $Enabled
    $reviewSuffix = [guid]::NewGuid().ToString('N')
    $reviewTemp = "$reviewPolicy.$reviewSuffix.tmp"
    $reviewBackup = "$reviewPolicy.$reviewSuffix.bak"
    $reviewUtf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($reviewTemp, ($reviewData | ConvertTo-Json -Depth 30), $reviewUtf8)
    [IO.File]::Replace($reviewTemp, $reviewPolicy, $reviewBackup)
    $readBack = Get-Content -LiteralPath $reviewPolicy -Raw | ConvertFrom-Json
    if ($readBack.enabled -isnot [bool] -or $readBack.enabled -ne $Enabled) { throw 'Readback failed.' }
    [pscustomobject]@{ Enabled = $readBack.enabled; Backup = $reviewBackup }
}

# 停止を実行
Set-ReviewHelperEnabled $false
```

### 2. Project 許可（Terminal Commands）を削除する

Antigravity の **Project設定 → Permissions → Terminal Commands** で、導入時に対象プロジェクトへ追加した `tracked-status` と `tracked-diff-stat` の Allow ルールを削除します。

※削除対象のルール文字列を確認したい場合は、以下を実行してください（登録されているプロジェクトのパスを指定します）：
```powershell
$targetProject = 'C:\path\to\your-project'
node "$env:USERPROFILE\.gemini\config\auto-review\restricted-policy.mjs" --project-grants $targetProject
```

### 3. global hook と案内を止める

1. **Settings → Customizations → Hooks** で、Global 側の `codex-style-auto-review` を無効化（トグルOFF）します。
2. 案内ルール（.md）を退役（一時退避）させます：

```powershell
$targetProject = 'C:\path\to\your-project'
$reviewRules = @(
    (Join-Path $env:USERPROFILE '.gemini\config\rules\codex-style-auto-review.md'),
    (Join-Path $targetProject '.agents\rules\antigravity-tracked-review.md')
)

foreach ($reviewRule in $reviewRules) {
    if (Test-Path -LiteralPath $reviewRule -PathType Leaf) {
        Move-Item -LiteralPath $reviewRule -Destination "$reviewRule.disabled" -ErrorAction Stop
        Write-Host "Disabled: $reviewRule"
    }
}
```

これで安全にすべての自動化機能が停止し、元の通常確認（Ask）状態に戻ります。

---

## 再び使う（復帰）

再開する手順は以下の通りです。

1. **global hook を有効化**: Antigravity の **Settings → Customizations → Hooks** で `codex-style-auto-review` を有効にします。
2. **helper を有効化**:
   上記ステップ1で定義した関数を使って有効化します（8アセットのハッシュ検査が自動で走ります）：
   ```powershell
   Set-ReviewHelperEnabled $true
   ```
3. **Project 許可を再登録**:
   ```powershell
   $targetProject = 'C:\path\to\your-project'
   node "$env:USERPROFILE\.gemini\config\auto-review\restricted-policy.mjs" --project-grants $targetProject
   ```
   出力されたルールを再度 Antigravity の **Project設定 → Permissions → Terminal Commands** に追加します。
4. **案内ルールを復帰**:
   ```powershell
   $targetProject = 'C:\path\to\your-project'
   $reviewRules = @(
       (Join-Path $env:USERPROFILE '.gemini\config\rules\codex-style-auto-review.md'),
       (Join-Path $targetProject '.agents\rules\antigravity-tracked-review.md')
   )

   foreach ($reviewRule in $reviewRules) {
       if (Test-Path -LiteralPath "$reviewRule.disabled" -PathType Leaf) {
           Move-Item -LiteralPath "$reviewRule.disabled" -Destination $reviewRule -ErrorAction Stop
           Write-Host "Restored: $reviewRule"
       }
   }
   ```
5. 新規チャットで動作確認を行い、正常に確認0回で動作することを確認します。
