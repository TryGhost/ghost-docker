<#
.SYNOPSIS
    ghost-docker: start the ghost-docker manager.

.DESCRIPTION
    ghost-docker.ps1 [--dir PATH] <command> [options]
    ghost-docker.ps1 help

    Everything ghost-docker does happens in a container, the manager image.
    This script is the only part that runs on the host, and it does three
    things: check that Docker can be used, decide which image to run, and run
    it with the site directory and the Docker socket. The manager's exit
    status is this script's exit status.

      --dir PATH   The site directory. Default: the current directory.

    Which image runs, first match wins:

      $env:GD_IMAGE      an image you name
      a pinned image     written into a site's own copy of this script at install
      a checkout         this script next to manager\Dockerfile builds from it
      $env:GD_CHANNEL    a published channel (default: edge)

    Requires PowerShell 5.1 or later and Docker with the Compose plugin.

    The contract this implements is docs/ghost-cli-replacement.md section
    2.10, and the bash launcher, ghost-docker, implements the same one. Keep
    them in step.

    EXPERIMENTAL ON WINDOWS. Compose bind mounts are resolved by the Docker
    daemon, so the manager has to see the site directory at the path the
    daemon itself uses for it. On Windows that is not the Windows path, and
    the translation this script applies (see Get-DaemonPath) has not been
    verified against Docker Desktop. `doctor` runs; do not rely on anything
    that starts services until it has been.
#>

$ErrorActionPreference = 'Stop'

$RegistryImage = 'ghcr.io/tryghost/ghost-docker'
# Replaced with `repository@sha256:...` in the copy installed into a site.
$PinnedImage = ''
# How long Docker may take to answer before it is treated as not running. A
# daemon that has wedged stops answering rather than returning an error.
$DockerTimeout = if ($env:GD_DOCKER_TIMEOUT) { [int]$env:GD_DOCKER_TIMEOUT } else { 20 }

function Stop-Launcher([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

# PowerShell 5.1 has no $IsWindows; it only runs on Windows.
$OnWindows = if ($null -ne (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) { $IsWindows } else { $true }

# Runs a native command with its stderr merged into the returned lines. Under
# Windows PowerShell 5.1 a redirected stderr line arrives as an error record,
# which $ErrorActionPreference = 'Stop' would turn into an exception; this
# runs the command with that preference relaxed and flattens the records.
# $LASTEXITCODE is the command's.
function Invoke-Native([scriptblock]$Command) {
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        })
    return , $lines
}

# Runs docker with a deadline. Returns exit code, stdout and whether it had to
# be killed.
function Invoke-Docker([string[]]$Arguments, [int]$Seconds) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    # Resolved the way `& docker` below resolves it, through PowerShell and
    # PATHEXT. Process.Start on a bare name searches PATH for an .exe only,
    # and could pick a different docker than the one the final command runs.
    $info.FileName = (Get-Command docker -CommandType Application | Select-Object -First 1).Source
    # Every argument used with this function is free of spaces and quotes.
    $info.Arguments = $Arguments -join ' '
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($Seconds * 1000)) {
        try { $process.Kill() } catch { }
        return @{ TimedOut = $true; Code = 124; Output = '' }
    }
    [void]$stderr.Result
    return @{ TimedOut = $false; Code = $process.ExitCode; Output = $stdout.Result }
}

# The path the Docker daemon uses for a host directory.
#
# On Linux and macOS it is the path itself. On Windows the daemon runs in a
# Linux VM and sees the drives of the host under a mount prefix; with the WSL2
# backend of Docker Desktop that is /run/desktop/mnt/host/<drive>/. Override
# with GD_WINDOWS_MOUNT_PREFIX if your Docker uses another. UNVERIFIED: see the
# note at the top of this file.
function Get-DaemonPath([string]$Path) {
    if (-not $OnWindows) { return $Path }
    if ($Path -notmatch '^([A-Za-z]):\\(.*)$') {
        Stop-Launcher "the site directory must be on a local drive (C:\...), not $Path" 2
    }
    $prefix = if ($env:GD_WINDOWS_MOUNT_PREFIX) { $env:GD_WINDOWS_MOUNT_PREFIX.TrimEnd('/') } else { '/run/desktop/mnt/host' }
    $rest = $Matches[2].TrimEnd('\') -replace '\\', '/'
    $drive = $Matches[1].ToLowerInvariant()
    if ($rest) { return "$prefix/$drive/$rest" }
    return "$prefix/$drive"
}

# --- Options that belong to the launcher --------------------------------------

$SiteDir = ''
$Rest = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq '--dir') {
        if ($i + 1 -ge $args.Count) { Stop-Launcher '--dir needs a path' 2 }
        $i++
        $SiteDir = [string]$args[$i]
    }
    elseif ($arg.StartsWith('--dir=')) {
        $SiteDir = $arg.Substring(6)
    }
    else {
        $Rest.Add($arg)
    }
}

# --- Can Docker be used? ------------------------------------------------------
#
# These are the only checks that cannot run in the manager, because without
# them there is no manager. Each says what to do next.

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Launcher "Docker is not installed, or is not on the PATH.
  Install Docker Desktop: https://docs.docker.com/get-docker/"
}

$daemon = Invoke-Docker @('info', '--format', '{{.OSType}}|{{.SecurityOptions}}') $DockerTimeout
if ($daemon.TimedOut) {
    Stop-Launcher "the Docker daemon did not answer within $DockerTimeout seconds.
  It may be starting, or stuck. Wait for it to report running, or restart it."
}
if ($daemon.Code -ne 0) {
    Stop-Launcher "the Docker daemon is not reachable.
  Start Docker and try again. If it is running, check ``docker info``."
}
$osType, $security = $daemon.Output.Trim().Split('|', 2)
if ($osType -ne 'linux') {
    Stop-Launcher "Docker is running $osType containers, and ghost-docker needs Linux containers.
  In Docker Desktop, choose `"Switch to Linux containers`"."
}

$compose = Invoke-Docker @('compose', 'version') $DockerTimeout
if ($compose.TimedOut -or $compose.Code -ne 0) {
    Stop-Launcher "the Docker Compose plugin is not installed.
  ghost-docker sites are run with ``docker compose``. See https://docs.docker.com/compose/install/"
}

$Rootless = if ($security -match 'rootless') { '1' } else { '0' }

# --- The site directory -------------------------------------------------------

if (-not $SiteDir) { $SiteDir = (Get-Location).ProviderPath }
if (-not (Test-Path -LiteralPath $SiteDir -PathType Container)) {
    Stop-Launcher "$SiteDir is not a directory. Create it, or name another with --dir." 2
}
# Resolved, because the daemon resolves Compose bind mounts against real paths.
$SiteDir = (Resolve-Path -LiteralPath $SiteDir).ProviderPath
if (-not $OnWindows) {
    $resolved = (Get-Item -LiteralPath $SiteDir).ResolvedTarget
    if ($resolved) { $SiteDir = $resolved }
}
$DaemonSiteDir = Get-DaemonPath $SiteDir

# --- Which image --------------------------------------------------------------

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
$Source = 'image'
if ($env:GD_IMAGE) {
    $Image = $env:GD_IMAGE
}
elseif ($PinnedImage) {
    $Image = $PinnedImage
}
elseif ($ScriptDir -and (Test-Path -LiteralPath (Join-Path $ScriptDir 'manager/Dockerfile')) -and
    (Test-Path -LiteralPath (Join-Path $ScriptDir 'compose.yml'))) {
    # A checkout of the repository: build the manager from it. Docker's build
    # cache makes this quick when nothing has changed.
    $Source = 'checkout'
    $Image = 'ghost-docker:checkout'
    $commit = ''
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $gitOutput = Invoke-Native { git -C $ScriptDir rev-parse HEAD }
        if ($LASTEXITCODE -eq 0) { $commit = ($gitOutput -join '').Trim() }
    }
    # Also tagged with its commit, so the image that belongs to an earlier
    # checkout is still here if an update has to go back to it.
    $tags = @('--tag', $Image)
    if ($commit) { $tags += @('--tag', ('ghost-docker:checkout-' + $commit.Substring(0, [Math]::Min(12, $commit.Length)))) }
    $buildOutput = Invoke-Native {
        docker build --quiet --file (Join-Path $ScriptDir 'manager/Dockerfile') `
            --build-arg 'GD_VERSION=checkout' --build-arg "GD_COMMIT=$commit" `
            @tags $ScriptDir
    }
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine(($buildOutput -join "`n"))
        Stop-Launcher "the manager image could not be built from $ScriptDir."
    }
}
else {
    $channel = if ($env:GD_CHANNEL) { $env:GD_CHANNEL } else { 'edge' }
    $Image = "${RegistryImage}:$channel"
}

# --- Run it -------------------------------------------------------------------

$HostOs = if ($OnWindows) { 'Windows' } else { (& uname -s) }
$run = New-Object System.Collections.Generic.List[string]
$run.AddRange([string[]]@(
        'run', '--rm', '--init',
        # Docker Desktop exposes the daemon's own socket at this path on every
        # platform; on Windows the leading double slash stops path conversion.
        '--volume', $(if ($OnWindows) { '//var/run/docker.sock:/var/run/docker.sock' } else { '/var/run/docker.sock:/var/run/docker.sock' }),
        '--volume', "${SiteDir}:${DaemonSiteDir}",
        '--workdir', $DaemonSiteDir,
        '--env', "GD_SITE_DIR=$DaemonSiteDir",
        '--env', "GD_ROOTLESS=$Rootless",
        '--env', "GD_HOST_OS=$HostOs",
        '--env', "GD_IMAGE=$Image",
        '--env', "GD_SOURCE=$Source"
    ))
if (-not $OnWindows) {
    # A uid and gid exist to match. Windows has neither: Docker Desktop maps
    # ownership itself, and the manager runs as its default user.
    $run.AddRange([string[]]@('--env', "GD_UID=$(& id -u)", '--env', "GD_GID=$(& id -g)"))
}
if ($env:NO_COLOR) { $run.AddRange([string[]]@('--env', "NO_COLOR=$($env:NO_COLOR)")) }

# A terminal is attached when there is one.
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    $run.AddRange([string[]]@('--interactive', '--tty'))
}

$run.Add($Image)
$run.AddRange($Rest)

& docker @run
exit $LASTEXITCODE
