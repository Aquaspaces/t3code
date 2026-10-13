<#
Keeps Aqua's custom T3 Code in step with upstream and builds it as T3 Code (Nightly).

  Repo:     X:/t3code (origin = Aquaspaces/t3code, upstream = pingdotgg/t3code)
  main:     mirror of upstream/main, pushed to the fork
  aqua:     Aqua's own commits, rebased onto the newest upstream nightly tag

  t3code-custom.ps1              sync only (main + rebase aqua + push)
  t3code-custom.ps1 -Build       sync, then build the installer if anything changed
  t3code-custom.ps1 -Install     sync, build, and install silently (closes T3 Code)
  t3code-custom.ps1 -Auto        scheduled mode: sync, build if changed, install only
                                 if T3 Code isn't running (otherwise leaves the installer)
  -Force                         build even if nothing changed

Used by the app (Settings > My features and the update button):

  -Status [-NoFetch]             print the clone's state as one "##status {json}" line
  -Build -Machine                like -Build, plus "##progress" and "##result" lines
  -InstallBuilt -WaitPid <pid>   wait for the app to exit, install the last build, relaunch

The local build has no update feed (no app-update.yml), so the official nightly
updater never replaces it. New nightlies arrive through this script instead.
#>
param(
    [string]$Repo = 'X:/t3code',
    [string]$Branch = 'aqua',
    [switch]$Build,
    [switch]$Install,
    [switch]$Auto,
    [switch]$Force,
    [switch]$Status,
    [switch]$NoFetch,
    [switch]$Machine,
    [switch]$InstallBuilt,
    [int]$WaitPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Install -or $Auto) { $Build = $true }

$TaskName = 'T3 Code custom sync'
$AppExe = Join-Path $env:LOCALAPPDATA 'Programs/t3code/T3 Code (Nightly).exe'
$logDir = Join-Path $env:LOCALAPPDATA 't3code-custom'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stateFile = Join-Path $logDir 'state.json'
$lockFile = Join-Path $logDir 'lock'

function Invoke-Git {
    & git.exe -C $Repo @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed ($LASTEXITCODE)" }
}

function Get-GitLine {
    # Stop would turn git's stderr into a terminating error under PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    $out = & git.exe -C $Repo @args 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    return ([string]($out | Select-Object -First 1)).Trim()
}

function Get-Commits([string]$Range) {
    $lines = & git.exe -C $Repo log --no-merges --format='%H%x09%s' $Range 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $lines) { return @() }
    return @($lines | ForEach-Object {
        $parts = $_ -split "`t", 2
        [ordered]@{ sha = $parts[0]; subject = $parts[1] }
    })
}

function Get-NewestNightlyTag {
    $tag = & git.exe -C $Repo tag -l 'v*-nightly.*' --sort=-creatordate | Select-Object -First 1
    if ($tag) { return ([string]$tag).Trim() }
    return $null
}

function Write-Marker([string]$Kind, [string]$Text) {
    if ($Machine -or $Status) { [Console]::Out.WriteLine("##$Kind $Text"); [Console]::Out.Flush() }
}

function Write-Progress2([int]$Percent, [string]$Text, [int]$EstimateSeconds = 0) {
    Write-Host $Text
    Write-Marker 'progress' "$Percent $EstimateSeconds $Text"
}

function Read-State {
    if (Test-Path $stateFile) { return Get-Content $stateFile -Raw | ConvertFrom-Json }
    return $null
}

function Save-State($State) {
    $State | ConvertTo-Json -Depth 5 | Set-Content $stateFile -Encoding utf8
}

function Notify([string]$Message) {
    Write-Host $Message
    if ($Machine) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.Visible = $true
        $n.ShowBalloonTip(10000, 'T3 Code custom build', $Message, 'Info')
        Start-Sleep -Seconds 5
        $n.Dispose()
    } catch {}
}

# --- Status (read-only apart from fetching) -----------------------------------
if ($Status) {
    # Read-only: git warnings on stderr must not abort the report.
    $ErrorActionPreference = 'Continue'
    $result = [ordered]@{
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
        repo = $Repo; repoFound = $false; branch = $null; head = $null; dirty = $false
        baseTag = $null; newestNightlyTag = $null; pushed = $false
        customCommits = @(); features = @(); scheduledTask = $false
        lastBuild = $null; error = $null
    }
    try {
        $result.scheduledTask = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
        $state = Read-State
        if ($state) {
            $result.lastBuild = [ordered]@{
                commit = $state.builtCommit; tag = $state.tag; builtAt = $state.builtAt
                installedCommit = $state.installedCommit
            }
        }
        if (-not (Test-Path (Join-Path $Repo '.git'))) { throw "No git clone at $Repo." }
        $result.repoFound = $true
        if (-not $NoFetch) {
            & git.exe -C $Repo fetch upstream --tags --prune --quiet 2>$null
            & git.exe -C $Repo fetch origin --prune --quiet 2>$null
        }
        $result.branch = Get-GitLine rev-parse --abbrev-ref HEAD
        $result.head = Get-GitLine rev-parse $Branch
        $result.dirty = [bool](& git.exe -C $Repo status --porcelain --untracked-files=no)
        $result.newestNightlyTag = Get-NewestNightlyTag
        $result.baseTag = Get-GitLine describe --tags --abbrev=0 --match 'v*-nightly.*' $Branch
        $result.pushed = ($result.head -and $result.head -eq (Get-GitLine rev-parse "origin/$Branch"))
        if ($result.baseTag) { $result.customCommits = @(Get-Commits "$($result.baseTag)..$Branch") }
        $featuresRaw = & { $ErrorActionPreference = 'Continue'; & git.exe -C $Repo show "${Branch}:apps/web/src/aqua/features.json" 2>$null }
        if ($LASTEXITCODE -eq 0 -and $featuresRaw) {
            # PowerShell 5.1 emits a parsed JSON array as one object; enumerate it.
            $parsed = ($featuresRaw -join "`n") | ConvertFrom-Json
            $result.features = @($parsed | ForEach-Object { $_ })
        }
    } catch {
        $result.error = $_.Exception.Message
    }
    Write-Marker 'status' ($result | ConvertTo-Json -Depth 6 -Compress)
    exit 0
}

# --- Install the last build after the app quits ---------------------------------
if ($InstallBuilt) {
    Start-Transcript -Path (Join-Path $logDir 'last-install.log') -Force | Out-Null
    try {
        if ($WaitPid -gt 0) {
            $p = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
            if ($p -and -not $p.WaitForExit(60000)) { throw "T3 Code (pid $WaitPid) didn't quit within a minute." }
        }
        $state = Read-State
        if (-not $state -or -not $state.installer -or -not (Test-Path $state.installer)) {
            throw 'No finished build to install.'
        }
        Write-Host "Installing $($state.installer)"
        $p = Start-Process -FilePath $state.installer -ArgumentList '/S' -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
        $state | Add-Member -NotePropertyName installedCommit -NotePropertyValue $state.builtCommit -Force
        Save-State $state
        if (Test-Path $AppExe) { Start-Process -FilePath $AppExe }
    } catch {
        Notify "Install failed: $($_.Exception.Message)"
        if (Test-Path $AppExe) { Start-Process -FilePath $AppExe }
        Stop-Transcript | Out-Null
        exit 1
    }
    Stop-Transcript | Out-Null
    exit 0
}

# --- Sync / build ----------------------------------------------------------------
Start-Transcript -Path (Join-Path $logDir 'last-run.log') -Force | Out-Null

# One sync or build at a time: the app's update button and the scheduled task share the clone.
$lock = $null
$exitCode = 0
try {
    $lock = [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    Write-Marker 'error' 'Another sync or build is already running.'
    Notify 'Skipped: another sync or build is already running.'
    Stop-Transcript | Out-Null
    exit 2
}

try {
    Write-Progress2 2 'Fetching from GitHub'
    Invoke-Git fetch upstream --tags --prune --quiet
    Invoke-Git fetch origin --prune --quiet

    $current = (& git.exe -C $Repo rev-parse --abbrev-ref HEAD).Trim()
    if ($current -eq 'main') {
        Invoke-Git merge --ff-only upstream/main
    } else {
        Invoke-Git fetch . upstream/main:main
    }
    Invoke-Git push --quiet origin main

    $tag = Get-NewestNightlyTag
    if (-not $tag) { throw 'No upstream nightly tag found.' }
    Write-Host "Newest nightly: $tag"

    if ($current -ne $Branch) {
        throw "$Repo has '$current' checked out; switch to '$Branch' to sync and build."
    }
    $dirty = & git.exe -C $Repo status --porcelain --untracked-files=no
    if ($dirty) { throw "Uncommitted changes in $Repo; commit or stash them first." }

    # Pick up commits pushed to the fork from another machine.
    & git.exe -C $Repo merge-base --is-ancestor HEAD "origin/$Branch"
    if ($LASTEXITCODE -eq 0) { Invoke-Git merge --ff-only --quiet "origin/$Branch" }

    & git.exe -C $Repo merge-base --is-ancestor $tag HEAD
    if ($LASTEXITCODE -ne 0) {
        Write-Progress2 8 "Applying your changes on top of $tag"
        & git.exe -C $Repo rebase $tag
        if ($LASTEXITCODE -ne 0) {
            & git.exe -C $Repo rebase --abort
            throw "Your changes conflict with $tag. Rebase by hand: git -C $Repo rebase $tag"
        }
    }
    Invoke-Git push --quiet --force-with-lease origin $Branch

    if (-not $Build) { Write-Host 'Sync done.'; return }

    # --- Build ------------------------------------------------------------
    $head = (& git.exe -C $Repo rev-parse HEAD).Trim()
    $state = Read-State
    $installer = $null

    if ($state -and $state.builtCommit -eq $head -and $state.installer -and (Test-Path $state.installer) -and -not $Force) {
        Write-Host "Already built $head."
        $installer = $state.installer
    } else {
        # Nightly branding needs a -nightly.YYYYMMDD.N version; use the base tag's.
        $version = $tag.TrimStart('v')
        $estimate = if ($state -and $state.buildSeconds) { [int]$state.buildSeconds } else { 600 }

        # No MSVC tools on this PC: reuse the installed resource monitor binary.
        $monitorSrc = Join-Path $env:LOCALAPPDATA 'Programs/t3code/resources/resource-monitor/t3-resource-monitor.exe'
        $monitorDst = Join-Path $Repo 'native/resource-monitor/target/x86_64-pc-windows-msvc/release'
        if (Test-Path $monitorSrc) {
            New-Item -ItemType Directory -Force $monitorDst | Out-Null
            Copy-Item $monitorSrc $monitorDst -Force
            $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = 'true'
        }

        # Keep the build feed-less so the official updater can't overwrite it.
        Remove-Item Env:GITHUB_REPOSITORY, Env:T3CODE_DESKTOP_UPDATE_REPOSITORY -ErrorAction SilentlyContinue
        $env:T3CODE_DESKTOP_VERSION = $version
        $outDir = Join-Path $Repo "release/$version"
        $env:T3CODE_DESKTOP_OUTPUT_DIR = $outDir

        # Embedded in the app's package.json; Settings > My features reads it.
        $env:T3CODE_CUSTOM_BUILD = [ordered]@{
            repo = $Repo
            branch = $Branch
            baseTag = $tag
            commit = $head
            builtAt = (Get-Date).ToUniversalTime().ToString('o')
            commits = @(Get-Commits "$tag..HEAD")
        } | ConvertTo-Json -Depth 5 -Compress

        $started = Get-Date
        Push-Location $Repo
        try {
            Write-Progress2 15 'Installing dependencies'
            & npx --yes pnpm@11.10.0 install --frozen-lockfile | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
            Write-Progress2 25 'Building the app' $estimate
            & npx --yes pnpm@11.10.0 run dist:desktop:win:x64 | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed. See the log in %LOCALAPPDATA%\t3code-custom\last-run.log' }
        } finally {
            Pop-Location
            Remove-Item Env:T3CODE_CUSTOM_BUILD -ErrorAction SilentlyContinue
        }

        $installer = (Get-ChildItem $outDir -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        if (-not $installer) { throw "No installer found in $outDir" }
        $state = [pscustomobject]@{
            builtCommit = $head; tag = $tag; version = $version; installer = $installer
            builtAt = (Get-Date).ToString('o'); buildSeconds = [int]((Get-Date) - $started).TotalSeconds
            installedCommit = if ($state) { $state.installedCommit } else { $null }
        }
        Save-State $state
        Write-Host "Built $installer"
    }
    Write-Progress2 100 'Build ready'
    Write-Marker 'result' ([ordered]@{ commit = $head; tag = $tag; version = $tag.TrimStart('v'); installer = $installer } | ConvertTo-Json -Compress)

    # --- Install ----------------------------------------------------------
    if (-not ($Install -or $Auto)) { return }
    $running = Get-Process -Name 'T3 Code (Nightly)' -ErrorAction SilentlyContinue
    if ($Auto -and $running) {
        Notify "New build ready ($tag + $Branch). Use the update button in T3 Code to install it."
        return
    }
    if ($state.installedCommit -eq $head -and -not $Force) { Write-Host 'Already installed.'; return }
    Write-Host "Installing $installer"
    $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
    $state | Add-Member -NotePropertyName installedCommit -NotePropertyValue $head -Force
    Save-State $state
    Notify "Installed T3 Code (Nightly) from $tag + $Branch."
} catch {
    Write-Marker 'error' $_.Exception.Message
    Notify "Failed: $($_.Exception.Message)"
    $exitCode = 1
} finally {
    if ($lock) { $lock.Dispose() }
    Stop-Transcript | Out-Null
}
exit $exitCode
