[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('tracked-status','tracked-diff-stat')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$WorkspacePath
)
# This entry point is pinned by the sibling policy and reviewed exact command.
# The explicitly authorized command uses RemoteSigned for this child process only.
# Never use ExecutionPolicy Bypass or change a persisted execution policy.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$process = $null
try {
    function File-Hash([string]$Value) {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes($Value)))).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose() }
    }
    function Assert-Path([string]$Value, [bool]$Directory = $false) {
        if ($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[\x00-\x1f\x7f"''`$%&|<>^!;(){}\[\]]' -or $Value.Substring(2) -match '[:?*]') { throw 'Unsupported path' }
        if ([System.IO.Path]::GetFullPath($Value) -cne $Value) { throw 'Noncanonical path' }
        $cursor = $Value
        while ($cursor) {
            if (([System.IO.File]::GetAttributes($cursor) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked path' }
            $cursor = [System.IO.Path]::GetDirectoryName($cursor)
        }
        if ($Directory) { if (-not [System.IO.Directory]::Exists($Value)) { throw 'Missing directory' } }
        elseif (-not [System.IO.File]::Exists($Value)) { throw 'Missing file' }
    }
    Assert-Path $WorkspacePath $true
    if (-not [string]::Equals((Get-Location).Path, $WorkspacePath, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Working directory mismatch' }
    $policyPath = Join-Path $PSScriptRoot 'restricted-policy.json'
    Assert-Path $policyPath
    if ((New-Object System.IO.FileInfo($policyPath)).Length -gt 32000) { throw 'Oversized policy' }
    $policy = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($policyPath))
    if ($policy.version -ne 2 -or $policy.profile -cne 'isolated-tracked-git-v1') { throw 'Unsupported policy' }
    # The helper must stop independently of hook/native-grant state, before Node starts.
    if ($null -eq $policy.PSObject.Properties['enabled'] -or $policy.enabled -isnot [bool] -or $policy.enabled -ne $true) { throw 'Restricted helper disabled or invalid' }
    $names = @{ reviewer='auto_review.mjs'; support='restricted-policy.mjs'; runner='restricted-git.mjs'; driver='restricted-driver.mjs'; launcher='restricted-launcher.ps1' }
    foreach ($role in @('node','git','powershell','reviewer','support','runner','driver','launcher')) {
        $asset = $policy.assets.$role
        Assert-Path $asset.path
        if ($asset.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid digest' }
        if ($names.ContainsKey($role) -and $asset.path -cne (Join-Path $PSScriptRoot $names[$role])) { throw 'Non-sibling asset' }
        if ((New-Object System.IO.FileInfo($asset.path)).Length -gt 134217728 -or (File-Hash $asset.path) -cne $asset.sha256) { throw 'Stale asset' }
    }
    if (-not [string]::Equals($policy.assets.powershell.path, [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Different PowerShell runtime' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $policy.assets.node.path
    $start.Arguments = '"' + $policy.assets.driver.path + '"'
    $start.WorkingDirectory = $WorkspacePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Node startup failed' }
    $outBuffer = New-Object char[] 4194305
    $errBuffer = New-Object char[] 4097
    $outTask = $process.StandardOutput.ReadBlockAsync($outBuffer, 0, $outBuffer.Length)
    $errTask = $process.StandardError.ReadBlockAsync($errBuffer, 0, $errBuffer.Length)
    $payload = @{ operation=$Operation; repoPath=$WorkspacePath } | ConvertTo-Json -Compress
    $bytes = $utf8.GetBytes($payload)
    $writeTask = $process.StandardInput.BaseStream.WriteAsync($bytes,0,$bytes.Length)
    if (-not $writeTask.Wait(1000)) { throw 'Input timeout' }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(35000) -or -not $outTask.Wait(500) -or $outTask.Result -gt 4194304) { throw 'Runner timeout or excess output' }
    $raw = [string]::new($outBuffer,0,$outTask.Result)
    $result = ConvertFrom-Json -InputObject $raw
    if ($process.ExitCode -eq 2 -and $result.ok -eq $false -and $result.code -cmatch '^[A-Z_]+$' -and $result.message -is [string] -and $result.message.Length -le 1000) {
        [Console]::OutputEncoding = $utf8
        [Console]::Out.Write($raw)
        exit 2
    }
    if ($process.ExitCode -ne 0 -or $result.ok -ne $true) { throw 'Restricted operation refused or failed' }
    [Console]::OutputEncoding = $utf8
    [Console]::Out.Write($raw)
    exit 0
} catch {
    [Console]::Out.WriteLine('{"ok":false,"code":"RESTRICTED_OPERATION_REFUSED","message":"Pinned assets, canonical workspace or supported repository requirements were not met; no summary was accepted."}')
    exit 2
} finally {
    if ($null -ne $process) { try { if (-not $process.HasExited) { $process.Kill() } } catch {}; $process.Dispose() }
}
