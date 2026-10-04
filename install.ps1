[CmdletBinding(DefaultParameterSetName = 'Workspace', SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Workspace')]
    [string]$WorkspacePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'AllConversations')]
    [switch]$AllConversations,
    [switch]$CheckOnly,
    [switch]$Enable
)

# Windows PowerShell 5.1 and PowerShell 7. CheckOnly and WhatIf never install.
# Default installation is staged with enabled:false; -Enable is explicit opt-in.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$hookName = 'codex-style-auto-review'

function Assert-LocalPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "Only an absolute local Windows path is supported: $Path"
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    # Defense in depth, even though the generated launcher encodes its paths.
    if ($full -match '[\x00-\x1f\x7f"''`$%&|<>^!;(){}\[\]]') {
        throw "Shell metacharacters are not supported in installation/runtime paths: $Path"
    }
    return $full
}

function Assert-NoReparseAncestors([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        try {
            $attributes = [System.IO.File]::GetAttributes($cursor)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse points and symlinks are not supported: $cursor"
            }
        } catch [System.IO.FileNotFoundException] {
        } catch [System.IO.DirectoryNotFoundException] {
        }
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
}

function Get-ByteHash([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash($Bytes)) }
    finally { $sha.Dispose() }
}

function Invoke-Node([string]$Arguments, [string]$InputText = '') {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $nodePath
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    # Preloads run before the reviewer and could replace its decision entirely.
    # Keep administrator TLS trust settings; remove Node code-loading overrides.
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    $start.EnvironmentVariables['AG_REVIEW_MODE'] = 'local'
    $start.EnvironmentVariables['AG_REVIEW_SANDBOX_CONFIRMED'] = '0'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Unable to start Node.js.' }
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        $inputBytes = [System.Text.Encoding]::UTF8.GetBytes($InputText)
        $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            throw 'Node.js preflight timed out.'
        }
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Node.js preflight failed: $stderr" }
        return $stdout
    } finally { $process.Dispose() }
}

function Assert-AskResponse([string]$Text, [string]$CaseName) {
    try { $response = ConvertFrom-Json -InputObject $Text -ErrorAction Stop }
    catch { throw "Reviewer preflight returned invalid JSON for $CaseName." }
    if ($response -isnot [System.Management.Automation.PSCustomObject] -or
        $null -eq $response.PSObject.Properties['decision'] -or
        $response.decision -cne 'force_ask') {
        throw "Reviewer preflight must return force_ask for $CaseName. Refusing to install."
    }
}

if ($PSCmdlet.ParameterSetName -eq 'AllConversations') {
    $scopeRoot = Assert-LocalPath (Join-Path $env:USERPROFILE '.gemini\config')
    $agents = $scopeRoot
    $scopeLabel = 'all Antigravity conversations'
} else {
    $scopeRoot = Assert-LocalPath $WorkspacePath
    Assert-NoReparseAncestors $scopeRoot
    if (-not [System.IO.Directory]::Exists($scopeRoot)) {
        throw 'WorkspacePath must be an existing directory.'
    }
    $agents = Join-Path $scopeRoot '.agents'
    $scopeLabel = 'one Antigravity workspace'
}
$reviewDir = Join-Path $agents 'auto-review'
$hookPath = Join-Path $agents 'hooks.json'
$source = Assert-LocalPath (Join-Path $PSScriptRoot 'auto_review.mjs')
$target = Assert-LocalPath (Join-Path $reviewDir 'auto_review.mjs')
$restrictedFiles = @('restricted-policy.mjs','restricted-git.mjs','restricted-driver.mjs','restricted-launcher.ps1')
$candidateBytes = @{}
foreach ($file in $restrictedFiles) {
    $sourceFile = Assert-LocalPath (Join-Path $PSScriptRoot $file)
    Assert-NoReparseAncestors $sourceFile
    if (-not [System.IO.File]::Exists($sourceFile)) { throw "Missing restricted component: $file" }
    $assetTarget = Join-Path $reviewDir $file
    Assert-NoReparseAncestors $assetTarget
    if (Test-Path -LiteralPath $assetTarget) { throw "Restricted component already exists: $assetTarget" }
    $candidateBytes[$assetTarget] = [System.IO.File]::ReadAllBytes($sourceFile)
}
$policyTarget = Join-Path $reviewDir 'restricted-policy.json'
$guideTarget = Join-Path $reviewDir 'COMMANDS.ja.md'
foreach ($newTarget in @($policyTarget,$guideTarget)) {
    Assert-NoReparseAncestors $newTarget
    if (Test-Path -LiteralPath $newTarget) { throw "Candidate target already exists: $newTarget" }
}
foreach ($destination in @($reviewDir, $hookPath, $target)) {
    Assert-NoReparseAncestors $destination
}
if (-not [System.IO.File]::Exists($source)) { throw 'auto_review.mjs is missing beside install.ps1.' }
if (Test-Path -LiteralPath $target) { throw 'The installed reviewer path already exists; refusing to overwrite it.' }
if ((Test-Path -LiteralPath $reviewDir) -and -not [System.IO.Directory]::Exists($reviewDir)) {
    throw 'The reviewer directory path is occupied by a file.'
}
if ((Test-Path -LiteralPath $hookPath) -and -not [System.IO.File]::Exists($hookPath)) {
    throw 'The hooks.json path is occupied by a directory.'
}

$hadConfig = [System.IO.File]::Exists($hookPath)
$oldBytes = $null
$hooks = New-Object PSObject
if ($hadConfig) {
    $oldBytes = [System.IO.File]::ReadAllBytes($hookPath)
    $existingText = [System.IO.File]::ReadAllText($hookPath, [System.Text.Encoding]::UTF8)
    $hooks = ConvertFrom-Json -InputObject $existingText -ErrorAction Stop
    if ($hooks -isnot [System.Management.Automation.PSCustomObject]) {
        throw 'Existing hooks.json must contain a JSON object.'
    }
    foreach ($property in $hooks.PSObject.Properties) {
        if ($property.Value -isnot [System.Management.Automation.PSCustomObject]) {
            throw "Existing hook group must be an object: $($property.Name)"
        }
        $enabledProperty = $property.Value.PSObject.Properties['enabled']
        if ($null -ne $enabledProperty -and $enabledProperty.Value -isnot [bool]) {
            throw "Existing enabled field must be boolean: $($property.Name)"
        }
    }
    if ($null -ne $hooks.PSObject.Properties[$hookName]) {
        throw "A hook named $hookName already exists; refusing to overwrite it."
    }
}

$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop)[0]
$nodePath = Assert-LocalPath $nodeCommand.Source
Assert-NoReparseAncestors $nodePath
$gitCommand = @(Get-Command git -CommandType Application -ErrorAction Stop)[0]
$gitPath = Assert-LocalPath $gitCommand.Source
Assert-NoReparseAncestors $gitPath
$shellPath = Assert-LocalPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
Assert-NoReparseAncestors $shellPath
if (-not [System.IO.File]::Exists($shellPath) -or $shellPath -match '\s') {
    throw 'The Windows PowerShell launcher must be an existing absolute path without whitespace.'
}
$versionText = (Invoke-Node '--version').Trim()
if ($versionText -notmatch '^v(\d+)\.\d+\.\d+' -or [int]$Matches[1] -lt 20) {
    throw "Node.js 20 or later is required; detected $versionText."
}
$sourceBytes = [System.IO.File]::ReadAllBytes($source)
$null = Invoke-Node ('--check "' + $source + '"')
$smoke = @{ toolCall = @{ name = 'run_command'; args = @{ CommandLine = 'git status'; Cwd = $scopeRoot } }; workspacePaths = @($scopeRoot) } | ConvertTo-Json -Depth 8 -Compress
Assert-AskResponse (Invoke-Node ('"' + $source + '"') $smoke) 'git status'
Assert-AskResponse (Invoke-Node ('"' + $source + '"') '{') 'malformed input'
if ((Get-ByteHash $sourceBytes) -cne (Get-ByteHash ([System.IO.File]::ReadAllBytes($source)))) {
    throw 'Reviewer source changed during preflight. Retry with stable source files.'
}
foreach ($file in $restrictedFiles) {
    if ((Get-ByteHash $candidateBytes[(Join-Path $reviewDir $file)]) -cne (Get-ByteHash ([System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file))))) { throw "Restricted component changed during preflight: $file" }
}
$candidateBytes[$target] = $sourceBytes
function Hex-Hash([byte[]]$Bytes) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha256.Dispose() }
}
$assets = [ordered]@{}
foreach ($runtime in @(@('node',$nodePath),@('git',$gitPath),@('powershell',$shellPath))) {
    $assets[$runtime[0]] = [ordered]@{ path=$runtime[1]; sha256=(Hex-Hash ([System.IO.File]::ReadAllBytes($runtime[1]))) }
}
foreach ($component in @(@('reviewer','auto_review.mjs'),@('support','restricted-policy.mjs'),@('runner','restricted-git.mjs'),@('driver','restricted-driver.mjs'),@('launcher','restricted-launcher.ps1'))) {
    $componentPath = Join-Path $reviewDir $component[1]
    $assets[$component[0]] = [ordered]@{ path=$componentPath; sha256=(Hex-Hash $candidateBytes[$componentPath]) }
}
$policy = [ordered]@{ version=2; profile='isolated-tracked-git-v1'; enabled=$false; assets=$assets; defaults=[ordered]@{ autocrlf='false'; eol='native'; attributes='disabled-external' } }
$textEncoding = New-Object System.Text.UTF8Encoding($false)
$candidateBytes[$policyTarget] = $textEncoding.GetBytes(($policy | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
$launcherTarget = Join-Path $reviewDir 'restricted-launcher.ps1'
$guide = @"
# Restricted tracked Git commands (v3 candidate)

Use these only to inspect tracked files with the isolated Git profile. Untracked files and external global/system configuration and attributes are excluded. This does not establish repository cleanliness or equivalence to general Git.

The trusted restricted-policy.json has enabled:false by default, even when install.ps1 -Enable enables the hook. False, missing, or non-boolean helper state stops before Node starts. Turning off only the hook does not turn off the helper. No native permission is installed by this package.

Use the exact command below, replacing WORKSPACE with the existing canonical absolute repository directory and set run_command.Cwd to that same directory. Paths containing shell metacharacters are unsupported. IsDaemon and RunPersistent must be false or omitted. The final 2>&1 is required exactly once. The user explicitly authorized RemoteSigned only for this fixed helper child process; this is not authorization for other scripts or a persisted policy change. No Set-ExecutionPolicy or Bypass is used.

$shellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$launcherTarget" -Operation tracked-status -WorkspacePath "WORKSPACE" 2>&1

$shellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$launcherTarget" -Operation tracked-diff-stat -WorkspacePath "WORKSPACE" 2>&1

Generate two exact Project-only commands and Terminal Commands UI inner regex strings while disabled:

& "$nodePath" "$(Join-Path $reviewDir 'restricted-policy.mjs')" --project-grants "WORKSPACE"

Register only in the named Project, after the native matcher tests pass. Do not put repository-specific grants in Global permissions or replace WORKSPACE with a wildcard. Global hook installation can serve all conversations; unregistered projects keep their existing command approval behavior.

Enable order: verify the pinned installation and native tests, enable the hook, deliberately set the trusted helper enabled flag to true, then add only the two owned Project rules. Disable order: set the helper flag to false, remove and verify deletion of only rules this installation added, then disable the hook. A failed removal is an incomplete disable, not success. Preserve the exact rule strings, scope and whether each rule existed before enrollment; never delete pre-existing identical rules. Existing native file-deny rules are not automatically inherited by child filesystem operations.

If the command is refused, retain the ordinary approval flow. Never broaden permissions or change security settings to make the command pass. Actual Antigravity approval reduction and native Deny precedence remain unverified until integration tests pass.
"@
$candidateBytes[$guideTarget] = $textEncoding.GetBytes($guide)

# Both cmd.exe and pwsh accept this encoded launcher. A separate Node process
# limits stdin waits, execution time and failures without relying on the host's
# handling of a broken hook. Shell startup failure still depends on the host.
$launcher = @'
$ErrorActionPreference='Stop'
$answer='{"decision":"force_ask","reason":"Reviewer unavailable; confirm this operation."}'
$p=$null
try {
$u=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=$u
$r=New-Object System.IO.StreamReader([Console]::OpenStandardInput(),$u)
$ib=New-Object char[] 1048577
$inputTask=$r.ReadBlockAsync($ib,0,$ib.Length)
if(-not $inputTask.Wait(3000)){throw 'stdin timeout'}
$count=$inputTask.Result
if($count -gt 1048576){throw 'oversized input'}
$payload=[string]::new($ib,0,$count)
$s=New-Object System.Diagnostics.ProcessStartInfo
$s.FileName='__NODE__'
$s.Arguments='"__TARGET__"'
$s.UseShellExecute=$false
$s.CreateNoWindow=$true
$s.RedirectStandardInput=$true
$s.RedirectStandardOutput=$true
$s.RedirectStandardError=$true
$s.StandardOutputEncoding=$u
$s.StandardErrorEncoding=$u
$s.EnvironmentVariables.Remove('NODE_OPTIONS')
$s.EnvironmentVariables.Remove('NODE_PATH')
$p=New-Object System.Diagnostics.Process
$p.StartInfo=$s
if(-not $p.Start()){throw 'start failed'}
$ob=New-Object char[] 16385
$eb=New-Object char[] 4097
$ot=$p.StandardOutput.ReadBlockAsync($ob,0,$ob.Length)
$et=$p.StandardError.ReadBlockAsync($eb,0,$eb.Length)
$bytes=$u.GetBytes($payload)
$wt=$p.StandardInput.BaseStream.WriteAsync($bytes,0,$bytes.Length)
if(-not $wt.Wait(1000)){throw 'write timeout'}
$p.StandardInput.Close()
if(-not $p.WaitForExit(12000)){throw 'reviewer timeout'}
if($p.ExitCode -ne 0 -or -not $ot.Wait(500)){throw 'reviewer failed'}
if($ot.Result -gt 16384){throw 'oversized output'}
$raw=[string]::new($ob,0,$ot.Result)
if(-not $raw.TrimStart().StartsWith('{')){throw 'invalid object'}
$v=ConvertFrom-Json -InputObject $raw
if($v -isnot [System.Management.Automation.PSCustomObject] -or $v.decision -cnotin @('allow','deny','force_ask','ask','deny_unless_prior_grant')){throw 'invalid decision'}
$answer=$raw
}catch{}finally{
if($null -ne $p){try{if(-not $p.HasExited){$p.Kill()}}catch{};$p.Dispose()}
}
[Console]::Out.Write([regex]::Replace($answer,'[^\x00-\x7f]',{param($m) '\u'+([int][char]$m.Value).ToString('x4')}))
exit 0
'@
$launcher = $launcher.Replace('__NODE__', $nodePath).Replace('__TARGET__', $target)
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($launcher))
$command = $shellPath + ' -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded
if ($command.Length -gt 7500) { throw 'The generated hook command is too long for Windows command shells.' }
$hookGroup = [ordered]@{
    enabled = [bool]$Enable
    PreToolUse = @(@{
        matcher = '^(run_command|write_to_file|replace_file_content|multi_replace_file_content|read_url_content)$'
        hooks = @(@{ type = 'command'; command = $command; timeout = 20 })
    })
}
$groupJson = ConvertTo-Json -InputObject $hookGroup -Depth 20 -WarningAction Stop
if ($hadConfig) {
    # Retain existing JSON values verbatim, including timestamps and large
    # numeric literals that a deserialize/serialize round trip could change.
    $prefix = $existingText.TrimEnd()
    $prefix = $prefix.Substring(0, $prefix.Length - 1).TrimEnd()
    $separator = ''
    if (@($hooks.PSObject.Properties).Count -gt 0) { $separator = ',' }
    $json = $prefix + $separator + [Environment]::NewLine + '"' + $hookName + '": ' + $groupJson + [Environment]::NewLine + '}'
} else {
    $json = '{' + [Environment]::NewLine + '"' + $hookName + '": ' + $groupJson + [Environment]::NewLine + '}'
}
$null = ConvertFrom-Json -InputObject $json -ErrorAction Stop
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($CheckOnly) {
    Write-Output "Preflight passed; no files changed. Node $versionText; enabled=$([bool]$Enable); destination=$hookPath"
    return
}
if (-not $PSCmdlet.ShouldProcess($hookPath, "Install reviewer for $scopeLabel (enabled=$([bool]$Enable))")) { return }

$reviewDirExisted = [System.IO.Directory]::Exists($reviewDir)
$agentsExisted = [System.IO.Directory]::Exists($agents)
$tempPath = Join-Path $agents ('hooks.json.pending-' + [Guid]::NewGuid().ToString('N'))
$backup = $hookPath + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '-' + [Guid]::NewGuid().ToString('N')
$createdAssets = New-Object System.Collections.Generic.List[string]
$committed = $false
try {
    foreach ($destination in @($reviewDir, $hookPath, $target)) { Assert-NoReparseAncestors $destination }
    $null = [System.IO.Directory]::CreateDirectory($reviewDir)
    foreach ($destination in @($reviewDir, $hookPath, $target)) { Assert-NoReparseAncestors $destination }
    foreach ($assetPath in $candidateBytes.Keys) {
        Assert-NoReparseAncestors $assetPath
        $assetBytes = $candidateBytes[$assetPath]
        $stream = New-Object System.IO.FileStream($assetPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $createdAssets.Add($assetPath)
        try { $stream.Write($assetBytes, 0, $assetBytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
    }
    $configBytes = $utf8.GetBytes($json + [Environment]::NewLine)
    $tempStream = New-Object System.IO.FileStream($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $tempStream.Write($configBytes, 0, $configBytes.Length); $tempStream.Flush($true) }
    finally { $tempStream.Dispose() }
    Assert-NoReparseAncestors $hookPath
    if ($hadConfig) {
        if (-not [System.IO.File]::Exists($hookPath) -or
            (Get-ByteHash $oldBytes) -cne (Get-ByteHash ([System.IO.File]::ReadAllBytes($hookPath)))) {
            throw 'hooks.json changed during installation; refusing to replace it.'
        }
        [System.IO.File]::Replace($tempPath, $hookPath, $backup, $true)
    } else {
        [System.IO.File]::Move($tempPath, $hookPath)
    }
    $committed = $true
} finally {
    if (-not $committed) {
        if ([System.IO.File]::Exists($tempPath)) { [System.IO.File]::Delete($tempPath) }
        foreach ($assetPath in $createdAssets) {
            if ([System.IO.File]::Exists($assetPath) -and (Get-ByteHash $candidateBytes[$assetPath]) -ceq (Get-ByteHash ([System.IO.File]::ReadAllBytes($assetPath)))) {
                [System.IO.File]::Delete($assetPath)
            }
        }
        if (-not $reviewDirExisted -and [System.IO.Directory]::Exists($reviewDir) -and
            [System.IO.Directory]::GetFileSystemEntries($reviewDir).Length -eq 0) {
            [System.IO.Directory]::Delete($reviewDir)
        }
        if (-not $agentsExisted -and [System.IO.Directory]::Exists($agents) -and
            [System.IO.Directory]::GetFileSystemEntries($agents).Length -eq 0) {
            [System.IO.Directory]::Delete($agents)
        }
    }
}
Write-Output "Installed reviewer files: $hookPath"
Write-Output 'Restricted helper remains disabled in restricted-policy.json. No native Allow rules were added.'
if ($hadConfig) { Write-Output "Exact previous config backup: $backup" }
if ($Enable) {
    Write-Output 'Hook enabled by explicit -Enable. Antigravity runtime behavior still requires integration verification.'
} else {
    Write-Output 'Hook staged with enabled:false. Approval behavior has not been activated. Complete Antigravity integration checks before enabling.'
}
