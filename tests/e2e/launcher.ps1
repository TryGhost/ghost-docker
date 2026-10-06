<#
.SYNOPSIS
    The PowerShell launcher, checked against a stand-in docker.

.DESCRIPTION
    tests/e2e/launcher.ps1

    Puts a stand-in `docker` on the PATH and checks what ghost-docker.ps1 says
    when Docker cannot be used, and exactly how it would start the manager.
    Needs no Docker. Runs under Windows PowerShell 5.1 and PowerShell 7, on
    Windows, Linux and macOS.

    What this does NOT establish: that a manager started this way works on
    Windows. That needs Docker Desktop with Linux containers, which CI runners
    do not have; see the note at the top of ghost-docker.ps1.

    Exits non-zero at the first check that fails, naming it.
#>

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).ProviderPath
$Launcher = Join-Path $Root 'ghost-docker.ps1'
$OnWindows = if ($null -ne (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) { $IsWindows } else { $true }
$Shell = (Get-Process -Id $PID).Path

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("ghost-docker-launcher-ps-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Work | Out-Null
$Work = (Resolve-Path $Work).ProviderPath
if (-not $OnWindows) {
    $target = (Get-Item -LiteralPath $Work).ResolvedTarget
    if ($target) { $Work = $target }
}

$script:Current = 'setup'
$script:Out = ''
$script:Code = 0

function Step([string]$Name) { $script:Current = $Name; Write-Host "`n== $Name" }
function Ok([string]$Message) { Write-Host "   ok    $Message" }
function Fail([string]$Message, [string]$Detail = '') {
    Write-Host "`nFAILED in `"$($script:Current)`": $Message"
    if ($Detail) { Write-Host "--- output ---`n$Detail`n--------------" }
    Remove-Item -Recurse -Force -LiteralPath $Work -ErrorAction SilentlyContinue
    exit 1
}

# --- A stand-in docker ---------------------------------------------------------
#
# FAKE_DOCKER selects how it behaves. Every invocation is appended to the calls
# file, one argument per line after a CALL line.

$Fake = Join-Path $Work 'fake-bin'
New-Item -ItemType Directory -Path $Fake | Out-Null
$Calls = Join-Path $Work 'calls'
$FakeScript = Join-Path $Fake 'fake-docker.ps1'
Set-Content -LiteralPath $FakeScript -Encoding ASCII -Value @'
Add-Content -LiteralPath $env:FAKE_CALLS -Value 'CALL'
foreach ($a in $args) { Add-Content -LiteralPath $env:FAKE_CALLS -Value ([string]$a) }
$mode = $env:FAKE_DOCKER
switch ("${mode}:$($args[0])") {
    'down:info' { [Console]::Error.WriteLine('Cannot connect to the Docker daemon'); exit 1 }
    'hang:info' { Start-Sleep -Seconds 30; exit 0 }
    'windows:info' { Write-Output 'windows|[]'; exit 0 }
    'rootless:info' { Write-Output 'linux|[name=seccomp name=rootless]'; exit 0 }
    'nocompose:compose' { [Console]::Error.WriteLine("docker: 'compose' is not a docker command."); exit 1 }
}
switch ($args[0]) {
    'info' { Write-Output 'linux|[name=seccomp,profile=builtin]'; exit 0 }
    'compose' { Write-Output 'Docker Compose version v2.40.3'; exit 0 }
    'build' { Write-Output 'sha256:built'; exit 0 }
    'run' { if ($env:FAKE_RUN_STATUS) { exit [int]$env:FAKE_RUN_STATUS } else { exit 0 } }
}
exit 0
'@
if ($OnWindows) {
    Set-Content -LiteralPath (Join-Path $Fake 'docker.cmd') -Encoding ASCII -Value "@echo off`r`n`"$Shell`" -NoProfile -ExecutionPolicy Bypass -File `"$FakeScript`" %*`r`nexit /b %ERRORLEVEL%"
}
else {
    Set-Content -LiteralPath (Join-Path $Fake 'docker') -Encoding ASCII -Value "#!/bin/sh`nexec `"$Shell`" -NoProfile -File `"$FakeScript`" `"`$@`""
    & chmod +x (Join-Path $Fake 'docker')
}

$Site = Join-Path $Work 'site'
New-Item -ItemType Directory -Path $Site | Out-Null
$Separator = [System.IO.Path]::PathSeparator
$RealPath = $env:PATH

# Invoke-Launcher MODE ENV ARGS... -> sets $script:Out and $script:Code
function Invoke-Launcher([string]$Mode, [hashtable]$Environment, [string[]]$Arguments, [string]$LauncherPath = $Launcher, [string]$Path = "$Fake$Separator$RealPath") {
    Set-Content -LiteralPath $Calls -Value $null
    $saved = @{}
    $all = @{ FAKE_DOCKER = $Mode; FAKE_CALLS = $Calls; GD_IMAGE = $null; GD_CHANNEL = $null; GD_DOCKER_TIMEOUT = $null; FAKE_RUN_STATUS = $null }
    foreach ($key in $Environment.Keys) { $all[$key] = $Environment[$key] }
    # Through the env: drive, not [Environment]: on Linux and macOS only the
    # drive reaches the processes PowerShell then starts.
    foreach ($key in $all.Keys) {
        $saved[$key] = (Get-Item -LiteralPath "env:$key" -ErrorAction SilentlyContinue).Value
        Set-Variable-InEnvironment $key $all[$key]
    }
    try {
        # PATH is set inside the child rather than inherited: some PowerShell
        # installations start through a wrapper that resets it.
        $quote = { param($text) "'" + ([string]$text).Replace("'", "''") + "'" }
        $command = '$env:PATH = ' + (& $quote $Path) + '; & ' + (& $quote $LauncherPath) + ' ' +
            (($Arguments | ForEach-Object { & $quote $_ }) -join ' ') + '; exit $LASTEXITCODE'
        # Windows PowerShell 5.1 turns each redirected stderr line into an
        # error record, and the script-wide 'Stop' would make the first one a
        # terminating error. Relax it for this call only (the assignment is
        # local to the function) and flatten the records to their text.
        $ErrorActionPreference = 'Continue'
        $lines = @(& $Shell -NoProfile -ExecutionPolicy Bypass -Command $command 2>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
            })
        $script:Code = $LASTEXITCODE
        $script:Out = ($lines -join "`n") + "`n"
    }
    finally {
        foreach ($key in $saved.Keys) { Set-Variable-InEnvironment $key $saved[$key] }
    }
}

function Set-Variable-InEnvironment([string]$Name, $Value) {
    if ($null -eq $Value -or $Value -eq '') {
        Remove-Item -LiteralPath "env:$Name" -ErrorAction SilentlyContinue
    }
    else {
        Set-Item -LiteralPath "env:$Name" -Value ([string]$Value)
    }
}

function Expect-Status([int]$Expected) {
    if ($script:Code -ne $Expected) { Fail "exited $($script:Code), expected $Expected" $script:Out }
}
function Expect-Output([string]$Pattern) {
    if ($script:Out -notmatch $Pattern) { Fail "the output does not match: $Pattern" $script:Out }
}
# The arguments of the last docker invocation.
function Get-RunArgs {
    $lines = @(Get-Content -LiteralPath $Calls)
    $last = [Array]::LastIndexOf($lines, 'CALL')
    if ($last -lt 0) { return @() }
    return @($lines[($last + 1)..($lines.Count - 1)])
}
function Expect-RunArg([string]$Expected) {
    $runArgs = Get-RunArgs
    if ($runArgs -notcontains $Expected) { Fail "docker run was not given: $Expected" ($runArgs -join "`n") }
}

# --- Without Docker --------------------------------------------------------------

Step 'Docker is not installed'
$Empty = Join-Path $Work 'empty-bin'
New-Item -ItemType Directory -Path $Empty | Out-Null
Invoke-Launcher 'ok' @{} @('version') -Path $Empty
Expect-Status 1
Expect-Output 'Docker is not installed'
Ok 'says so, and where to get it'

Step 'The daemon is not running'
Invoke-Launcher 'down' @{} @('--dir', $Site, 'version')
Expect-Status 1
Expect-Output 'the Docker daemon is not reachable'
Ok 'says so'

Step 'The daemon does not answer'
Invoke-Launcher 'hang' @{ GD_DOCKER_TIMEOUT = '2' } @('--dir', $Site, 'version')
Expect-Status 1
Expect-Output 'did not answer within 2 seconds'
Ok 'gives up after the deadline instead of hanging'

Step 'Windows containers'
Invoke-Launcher 'windows' @{} @('--dir', $Site, 'version')
Expect-Status 1
Expect-Output 'needs Linux containers'
Ok 'are refused, with how to switch'

Step 'Compose is not installed'
Invoke-Launcher 'nocompose' @{} @('--dir', $Site, 'version')
Expect-Status 1
Expect-Output 'the Docker Compose plugin is not installed'
Ok 'says so'

Step 'The site directory'
Invoke-Launcher 'ok' @{} @('--dir', (Join-Path $Work 'no-such-directory'), 'version')
Expect-Status 2
Expect-Output 'is not a directory'
Invoke-Launcher 'ok' @{} @('--dir')
Expect-Status 2
Expect-Output '--dir needs a path'
Ok 'a missing directory and a missing value are usage errors'

# --- How the manager is started ----------------------------------------------------

if ($OnWindows) {
    $drive = $Site.Substring(0, 1).ToLowerInvariant()
    $DaemonSite = '/run/desktop/mnt/host/' + $drive + '/' + ($Site.Substring(3) -replace '\\', '/')
    $Socket = '//var/run/docker.sock:/var/run/docker.sock'
}
else {
    $DaemonSite = $Site
    $Socket = '/var/run/docker.sock:/var/run/docker.sock'
}

Step 'How the manager is started'
Invoke-Launcher 'ok' @{ GD_IMAGE = 'example/manager:1' } @('--dir', $Site, 'doctor', '--json')
Expect-Status 0
Expect-RunArg $Socket
Expect-RunArg "${Site}:${DaemonSite}"
Expect-RunArg "GD_SITE_DIR=$DaemonSite"
Expect-RunArg 'GD_ROOTLESS=0'
Expect-RunArg 'GD_SOURCE=image'
$runArgs = Get-RunArgs
if (($runArgs[-3..-1] -join '|') -ne 'example/manager:1|doctor|--json') {
    Fail 'the image and the command are not the last arguments, in order' ($runArgs -join "`n")
}
if ($OnWindows) {
    Expect-RunArg 'GD_HOST_OS=Windows'
    if ($runArgs -match '^GD_UID=') { Fail 'a uid was passed on Windows, which has none' ($runArgs -join "`n") }
}
else {
    Expect-RunArg "GD_UID=$(& id -u)"
    Expect-RunArg "GD_GID=$(& id -g)"
}
if ($runArgs -contains '--tty') { Fail 'a terminal was attached with output redirected' ($runArgs -join "`n") }
Ok 'socket, site directory at the daemon''s path for it, then the image and the command'

if ($OnWindows) {
    Step 'A different mount prefix'
    Invoke-Launcher 'ok' @{ GD_IMAGE = 'example/manager:1'; GD_WINDOWS_MOUNT_PREFIX = '/host_mnt/' } @('--dir', $Site, 'version')
    Expect-RunArg ("GD_SITE_DIR=/host_mnt/$drive/" + ($Site.Substring(3) -replace '\\', '/'))
    Ok 'can be supplied for a Docker that mounts drives elsewhere'
}

Step 'The site directory defaults to the current directory'
Push-Location $Site
try { Invoke-Launcher 'ok' @{ GD_IMAGE = 'example/manager:1' } @('version') } finally { Pop-Location }
Expect-RunArg "GD_SITE_DIR=$DaemonSite"
Invoke-Launcher 'ok' @{ GD_IMAGE = 'example/manager:1' } @("--dir=$Site", 'version')
Expect-RunArg "GD_SITE_DIR=$DaemonSite"
Ok 'and --dir=PATH is accepted as well as --dir PATH'

Step 'Rootless Docker'
Invoke-Launcher 'rootless' @{ GD_IMAGE = 'example/manager:1' } @('--dir', $Site, 'version')
Expect-RunArg 'GD_ROOTLESS=1'
Ok 'is passed on'

Step 'Which image'
Invoke-Launcher 'ok' @{} @('--dir', $Site, 'version')
Expect-RunArg 'ghost-docker:checkout'
Expect-RunArg 'GD_SOURCE=checkout'
if ((Get-Content -LiteralPath $Calls) -notcontains 'build') { Fail 'a checkout did not build its image' (Get-Content -LiteralPath $Calls | Out-String) }
Ok 'a checkout builds from itself'

$Standalone = Join-Path $Work 'standalone.ps1'
Copy-Item -LiteralPath $Launcher -Destination $Standalone
Invoke-Launcher 'ok' @{} @('--dir', $Site, 'version') -LauncherPath $Standalone
Expect-RunArg 'ghcr.io/tryghost/ghost-docker:edge'
Invoke-Launcher 'ok' @{ GD_CHANNEL = 'beta' } @('--dir', $Site, 'version') -LauncherPath $Standalone
Expect-RunArg 'ghcr.io/tryghost/ghost-docker:beta'
Ok 'outside a checkout, the published channel'

$Pinned = Join-Path $Work 'pinned.ps1'
$text = [System.IO.File]::ReadAllText($Launcher)
$placeholder = "`$PinnedImage = ''"
if (-not $text.Contains($placeholder)) { Fail 'the pin placeholder is not where install will look for it' }
[System.IO.File]::WriteAllText($Pinned, $text.Replace($placeholder, "`$PinnedImage = 'ghcr.io/tryghost/ghost-docker@sha256:abc123'"))
Invoke-Launcher 'ok' @{} @('--dir', $Site, 'version') -LauncherPath $Pinned
Expect-RunArg 'ghcr.io/tryghost/ghost-docker@sha256:abc123'
Ok 'a site''s own copy runs the digest it was pinned to'

Step 'The manager''s exit status'
foreach ($status in 0, 1, 2, 3) {
    Invoke-Launcher 'ok' @{ GD_IMAGE = 'example/manager:1'; FAKE_RUN_STATUS = "$status" } @('--dir', $Site, 'anything')
    Expect-Status $status
}
Ok '0, 1, 2 and 3 each reach the caller unchanged'

Remove-Item -Recurse -Force -LiteralPath $Work -ErrorAction SilentlyContinue
Write-Host "`nAll checks passed. (Stand-in docker only: nothing here ran a real manager.)"
exit 0
