# Prowl installer for Windows (double-click install.cmd, which runs this). Installs whatever is missing with
# winget (Node.js, Git, the GitHub CLI, the Azure CLI when your tickets are in Azure DevOps) plus Claude Code,
# copies Prowl to %LOCALAPPDATA%\Prowl, adds a `prowl` command, then runs `prowl --setup` to sign you in.
# Re-run it any time to update Prowl; it skips anything already installed.
#
#   irm https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.ps1 | iex
#   install.cmd [-TaskBoard ado|jira] [-NoSetup] [-Update]
#
# Run from a URL, it downloads Prowl from GitHub; run as a file, it installs the copy next to it.
# -Update is what Prowl runs when it updates itself: no setup, and a short closing message.
param([ValidateSet('', 'ado', 'jira')][string]$TaskBoard = '', [switch]$NoSetup, [switch]$Update)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Update) { $NoSetup = $true }

$repo = 'darrenxhays/agents'
$src = $PSScriptRoot
$root = Join-Path $env:LOCALAPPDATA 'Prowl'
$app = Join-Path $root 'app'
$bin = Join-Path $root 'bin'
$prowlData = if ($env:PROWL_HOME) { $env:PROWL_HOME } else { Join-Path $HOME '.prowl' }

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Yellow }
function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Update-SessionPath {
  $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), "$HOME\.local\bin", $bin) -join ';'
}
function Install-Winget($id, $name) {
  if (-not (Have winget)) { throw "winget is missing, so $name can't be installed. Install 'App Installer' from the Microsoft Store, then run this again." }
  Say "Installing $name"
  winget install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements
  # -1978335189 (0x8A15002B): already installed, nothing to upgrade
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget couldn't install $name (exit code $LASTEXITCODE)" }
  Update-SessionPath
}

$download = $null
if (-not $src) {
  Say 'Downloading Prowl'
  $download = Join-Path ([IO.Path]::GetTempPath()) "prowl-$([guid]::NewGuid())"
  New-Item -ItemType Directory $download | Out-Null
  Invoke-WebRequest "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile "$download\prowl.zip" -UseBasicParsing
  Expand-Archive "$download\prowl.zip" $download
  $src = Join-Path $download "$($repo.Split('/')[1])-main\apps\prowl"
  if (-not (Test-Path (Join-Path $src 'prowl.mjs'))) { throw "the download from github.com/$repo didn't contain Prowl" }
}

# Replacing Prowl's files under a running copy would break the reviews it starts.
$lock = Join-Path $prowlData 'lock'
if (Test-Path $lock) {
  $running = Get-Process -Id ([int](Get-Content $lock -Raw)) -ErrorAction SilentlyContinue
  if ($running -and $running.ProcessName -eq 'node') { throw 'Prowl is running. Quit it (press q) first, then run the installer again.' }
}

if (-not $TaskBoard) {
  $config = Join-Path $prowlData 'config.json'
  if (Test-Path $config) {
    $TaskBoard = if ((Get-Content $config -Raw) -match '"taskBoard":\s*"jira"') { 'jira' } else { 'ado' }
  } else {
    $TaskBoard = if ((Read-Host 'Where are your tickets? 1 = Azure DevOps, 2 = Jira [1]') -eq '2') { 'jira' } else { 'ado' }
  }
}

Update-SessionPath
$nodeOk = (Have node) -and ([int](node -p "process.versions.node.split('.')[0]") -ge 18)
if ($nodeOk) { Ok "Node.js $(node --version)" } else { Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js' }
if (Have git) { Ok 'Git' } else { Install-Winget 'Git.Git' 'Git (Claude Code needs its Git Bash)' }
if (Have gh) { Ok 'GitHub CLI' } else { Install-Winget 'GitHub.cli' 'the GitHub CLI' }
if ($TaskBoard -eq 'ado') {
  if (Have az) { Ok 'Azure CLI' } else { Install-Winget 'Microsoft.AzureCLI' 'the Azure CLI' }
}
if (Have claude) {
  Ok 'Claude Code'
} else {
  Say 'Installing Claude Code'
  # In a child PowerShell, so an `exit` in Anthropic's script can't end this one.
  powershell -NoProfile -ExecutionPolicy Bypass -Command 'Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression'
  Update-SessionPath
  if (-not (Have claude)) { throw "Claude Code didn't install" }
}
if (-not (Have node)) { throw 'Node.js still is not available: open a new terminal and run the installer again.' }

Say "Installing Prowl into $app"
if ((Resolve-Path $src).Path.TrimEnd('\') -ne $app) {
  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  New-Item -ItemType Directory -Force $root | Out-Null
  Copy-Item -LiteralPath $src -Destination $app -Recurse -Force
  Get-ChildItem $app -Recurse -File | Unblock-File
}
New-Item -ItemType Directory -Force $bin | Out-Null
# %LOCALAPPDATA% rather than the expanded path keeps this file plain ASCII whatever the user name is.
# Rewritten only when it changes: cmd.exe reads a running .cmd file as it goes, and Prowl updates itself from inside it.
$launcher = Join-Path $bin 'prowl.cmd'
$launch = "@echo off`r`nnode `"%LOCALAPPDATA%\Prowl\app\prowl.mjs`" %*"
if (-not (Test-Path $launcher) -or (Get-Content $launcher -Raw).TrimEnd() -ne $launch) { Set-Content -Path $launcher -Encoding ASCII -Value $launch }
Ok "prowl command: $bin\prowl.cmd"

$userPath = "$([Environment]::GetEnvironmentVariable('Path', 'User'))"
$newTerminal = ''
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath.TrimEnd(';'), $bin) | Where-Object { $_ }) -join ';', 'User')
  Ok "added $bin to your PATH"
  $newTerminal = ' (open a new terminal first)'
}

if ($download) { Remove-Item $download -Recurse -Force -ErrorAction SilentlyContinue }
if ($Update) {
  Write-Host "`nProwl is updated." -ForegroundColor White
  return
}
if (-not $NoSetup) {
  Say 'Setting up'
  node (Join-Path $app 'prowl.mjs') --setup --task-board $TaskBoard
}
Write-Host "`nProwl is installed. Start it in Windows Terminal$newTerminal with: prowl" -ForegroundColor White
if ($NoSetup) { Write-Host 'First run: prowl --setup' }
