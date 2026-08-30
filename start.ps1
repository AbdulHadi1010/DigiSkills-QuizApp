<#
================================================================================
 DigiQuiz — start.ps1   (Windows, primary entry point)

 EASIEST WAY TO RUN THIS: double-click START-DIGIQUIZ.bat instead. It calls this
 script with the right flags and keeps the window open so you can read any error.

 From a PowerShell window in this folder:

       .\start.ps1

 If Windows blocks the script ("running scripts is disabled on this system"),
 run this once — it only affects your own user account, and does not require
 Administrator:

       Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

 Or bypass it for a single run without changing any setting:

       powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

--------------------------------------------------------------------------------
 What it does
   0. PREFLIGHT: checks Node is present and >= 22.5.0, and stops with one clear
      line if not, rather than failing deep inside a stack trace.
   1. Finds the LAN IPv4 address a phone can reach (Get-NetIPAddress).
   2. Prints that URL in large high-contrast text, up front.
   3. Picks Path B (Node + SQLite) by default; Path A (Docker) only if Node is
      unusable, or if you ask for it with -Mode docker.
   4. Starts both tiers bound to 0.0.0.0.
   5. Prints the URL again at the end, after the servers report ready.

 Parameters
   -Port <n>        host port for the web tier            (default 8080)
   -Mode <auto|docker|node>                               (default auto)
   -NoQr            skip the QR code
   -OpenFirewall    add the inbound firewall rule (needs Administrator)
   -SkipInstall     do not run `npm install` even if node_modules is missing

 Exit codes
   0  started normally (or stopped with Ctrl+C)
   1  something else failed — read the message
   3  NODE PREFLIGHT FAILED — Node missing or older than 22.5.0
================================================================================
#>

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [ValidateSet('auto', 'docker', 'node')]
    [string]$Mode = 'auto',
    [switch]$NoQr,
    [switch]$OpenFirewall,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# The one hard requirement, in one place.
$REQUIRED_NODE = [version]'22.5.0'

# ------------------------------------------------------------------------------
# Console setup — UTF-8 so the box drawing and QR blocks render, and VT so we can
# use ANSI background colours for the QR (which keeps the light/dark polarity
# correct no matter what colour scheme the window uses).
# ------------------------------------------------------------------------------
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:AnsiOk = $false
if ($env:WT_SESSION -or $PSVersionTable.PSVersion.Major -ge 7) {
    $script:AnsiOk = $true
} else {
    # Windows PowerShell 5.1 in conhost: turn on VIRTUAL_TERMINAL_PROCESSING.
    try {
        if (-not ('DigiQuizVT' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DigiQuizVT {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
    public static bool Enable() {
        IntPtr h = GetStdHandle(-11);
        uint mode;
        if (!GetConsoleMode(h, out mode)) return false;
        return SetConsoleMode(h, mode | 0x0004);
    }
}
'@
        }
        $script:AnsiOk = [DigiQuizVT]::Enable()
    } catch {
        $script:AnsiOk = $false
    }
}

function Write-Head($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [warn] $text" -ForegroundColor Yellow }
function Write-Err2($text) { Write-Host "  [X]    $text" -ForegroundColor Red }

# ------------------------------------------------------------------------------
# The screenshot-friendly URL block.
#
# Deliberately plain and high contrast: black text on a white bar, one short line,
# lots of surrounding whitespace, no log lines mixed in. It has to survive being
# read off a phone photo of a laptop screen at normal resolution.
# ------------------------------------------------------------------------------
function Show-BigUrl {
    param(
        [string]$Url,
        [string]$Caption = 'OPEN THIS ON YOUR PHONE'
    )

    $bar = '=' * 66
    Write-Host ""
    Write-Host ""
    Write-Host "  $bar" -ForegroundColor DarkGray
    Write-Host ""

    if ([string]::IsNullOrWhiteSpace($Url)) {
        Write-Host "   NO LAN ADDRESS FOUND - is WiFi switched on?" -ForegroundColor Red
        Write-Host ""
        Write-Host "   The app will still work on this computer at:" -ForegroundColor White
        $Url = "http://localhost:$Port"
        $Caption = 'ON THIS COMPUTER ONLY'
    } else {
        Write-Host "   $Caption" -ForegroundColor White
    }

    Write-Host ""
    # Pad the URL so the white highlight forms a solid, easy-to-read bar.
    $padded = "   $Url   "
    Write-Host "     " -NoNewline
    Write-Host $padded -ForegroundColor Black -BackgroundColor White
    Write-Host ""
    Write-Host "   (phone and computer must be on the same WiFi)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  $bar" -ForegroundColor DarkGray
    Write-Host ""
}

Write-Host ""
Write-Host "  DigiQuiz - local development stack" -ForegroundColor White
Write-Host "  ----------------------------------" -ForegroundColor DarkGray

# ==============================================================================
# 0. PREFLIGHT - Node version gate
#
# This runs before anything else so that a wrong Node version produces ONE clear
# line instead of an ERR_UNKNOWN_BUILTIN_MODULE stack trace forty lines deep.
# ==============================================================================
Write-Head "Preflight"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeVersionRaw = $null
$nodeVersion = $null
$nodeOk = $false

if ($nodeCmd) {
    try {
        $nodeVersionRaw = (& node --version 2>$null | Select-Object -First 1)
        if ($nodeVersionRaw -match '^v?(\d+)\.(\d+)\.(\d+)') {
            $nodeVersion = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
            $nodeOk = ($nodeVersion -ge $REQUIRED_NODE)
        }
    } catch {
        $nodeVersionRaw = $null
    }
}

# Is nvm-windows available? If so we can give an exact fix instead of "go install Node".
$nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue

function Stop-NodePreflight {
    param([string]$Headline)

    Write-Host ""
    Write-Host "  ##############################################################" -ForegroundColor Red
    Write-Host ""
    Write-Host "   $Headline" -ForegroundColor Black -BackgroundColor Red
    Write-Host ""
    Write-Host "  ##############################################################" -ForegroundColor Red
    Write-Host ""
    Write-Host "  DigiQuiz needs Node $REQUIRED_NODE or newer, because it uses node:sqlite -" -ForegroundColor White
    Write-Host "  the SQLite engine built into Node - which first shipped in 22.5.0." -ForegroundColor White
    Write-Host ""

    if ($nvmCmd) {
        Write-Host "  You have nvm installed. Fix it with these two commands:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "      nvm install 22" -ForegroundColor White -BackgroundColor DarkBlue
        Write-Host "      nvm use 22" -ForegroundColor White -BackgroundColor DarkBlue
        Write-Host ""
        Write-Host "  (as one line:  nvm install 22 && nvm use 22 )" -ForegroundColor Gray
        Write-Host "  Then run START-DIGIQUIZ.bat again." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  nvm use may need an Administrator window on nvm-windows." -ForegroundColor Gray
    } else {
        Write-Host "  Install Node 22 LTS from https://nodejs.org" -ForegroundColor Yellow
        Write-Host "  Pick the Windows Installer (.msi) and accept all the defaults." -ForegroundColor Yellow
        Write-Host "  Then run START-DIGIQUIZ.bat again." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  Alternative that needs no Node at all, if Docker Desktop is running:" -ForegroundColor Gray
    Write-Host "      powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Mode docker" -ForegroundColor Gray
    Write-Host ""
    exit 3
}

if ($Mode -ne 'docker') {
    if (-not $nodeCmd) {
        Stop-NodePreflight "NODE MISSING: node is not installed or not on PATH, need v$REQUIRED_NODE+"
    }
    if (-not $nodeVersion) {
        Stop-NodePreflight "NODE UNREADABLE: 'node --version' returned '$nodeVersionRaw', need v$REQUIRED_NODE+"
    }
    if (-not $nodeOk) {
        # If Docker is available we could fall back, but the whole point of this
        # gate is a clear answer rather than a silent detour into a slower path.
        Stop-NodePreflight "NODE TOO OLD: found v$nodeVersion, need v$REQUIRED_NODE+"
    }
    Write-Ok "Node v$nodeVersion (need v$REQUIRED_NODE+)"
} else {
    if ($nodeVersion) { Write-Ok "Node v$nodeVersion" } else { Write-Warn2 "Node not found - fine, -Mode docker does not need it" }
}

if ($nvmCmd) { Write-Ok "nvm is installed" }

# ------------------------------------------------------------------------------
# Docker is optional. Checked, never required.
#
# The probe is SKIPPED when Node is already good and you did not ask for Docker,
# because `docker info` blocks for ~10 seconds when Docker Desktop is installed
# but not running - which is a long, silent pause on the happy path for no
# benefit. (This skip came from an edit already made to this file on the laptop;
# I overwrote that edit when rewriting the script, so it is folded back in here.)
# ------------------------------------------------------------------------------
$dockerOk = $false
$dockerNeeded = ($Mode -eq 'docker') -or (-not $nodeOk)

if (-not $dockerNeeded) {
    Write-Host "  [--]   Skipping Docker check (not needed - Path B is the default)" -ForegroundColor DarkGray
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "  [..]   Checking Docker (this can take a few seconds)..." -ForegroundColor DarkGray
    # `docker` on PATH is not the same as Docker Desktop actually running.
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true; Write-Ok "Docker is installed and running" }
    else { Write-Warn2 "Docker is installed but not running" }
} else {
    Write-Warn2 "Docker not found on PATH"
}

# ==============================================================================
# 1. Choose a path
#
# Default is Path B (Node + SQLite). Docker is a fallback, not the preference.
# ==============================================================================
$chosen = $Mode
if ($chosen -eq 'auto') {
    if ($nodeOk) { $chosen = 'node' }
    elseif ($dockerOk) { $chosen = 'docker' }
    else { Stop-NodePreflight "NODE TOO OLD: found v$nodeVersion, need v$REQUIRED_NODE+" }
}

if ($chosen -eq 'node' -and -not $nodeOk) {
    Stop-NodePreflight "NODE TOO OLD: found v$nodeVersion, need v$REQUIRED_NODE+"
}
if ($chosen -eq 'docker' -and -not $dockerOk) {
    Write-Host ""
    Write-Err2 "-Mode docker was requested but Docker Desktop is not running."
    Write-Host "         Start Docker Desktop, wait for the whale icon to settle, and retry."
    Write-Host ""
    exit 1
}

Write-Host ""
if ($chosen -eq 'docker') {
    Write-Host "  Using Path A: Docker (MySQL 8 + both tiers in containers)" -ForegroundColor White
} else {
    Write-Host "  Using Path B: Node + SQLite (no Docker, no MySQL install)" -ForegroundColor White
}

# ==============================================================================
# 2. Find the LAN IP a phone can reach  --  done EARLY so the URL can be shown
#    at the top of the output, before any wall of logs.
# ==============================================================================
Write-Head "Finding your LAN address"

function Get-LanIPv4 {
    $candidates = @()

    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                 Where-Object {
                     $_.IPAddress -notlike '127.*' -and
                     $_.PrefixOrigin -ne 'WellKnown'
                 }

        foreach ($a in $addrs) {
            $alias = $a.InterfaceAlias
            $ip = $a.IPAddress
            $score = 0

            # Private ranges a phone can plausibly be on
            if     ($ip -like '192.168.*') { $score += 100 }
            elseif ($ip -like '10.*')      { $score += 90  }
            elseif ($ip -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { $score += 80 }
            elseif ($ip -like '169.254.*') { $score -= 50 }   # APIPA: no DHCP

            # Real adapters
            if ($alias -match 'Wi-?Fi|Wireless|WLAN') { $score += 50 }
            elseif ($alias -match 'Ethernet' -and $alias -notmatch 'vEthernet') { $score += 40 }

            # Virtual adapters a phone can never reach
            if ($alias -match 'vEthernet|Hyper-V|WSL|Default Switch|VirtualBox|VMware|Loopback|Bluetooth|Tailscale|ZeroTier|VPN') {
                $score -= 200
            }
            # Docker Desktop's internal subnet
            if ($ip -match '^172\.(1[7-9]|2[0-9]|3[01])\.') { $score -= 60 }

            # Prefer adapters that are actually up
            try {
                $nic = Get-NetAdapter -InterfaceIndex $a.InterfaceIndex -ErrorAction SilentlyContinue
                if ($nic -and $nic.Status -ne 'Up') { $score -= 150 }
            } catch { }

            $candidates += [pscustomobject]@{ IP = $ip; Alias = $alias; Score = $score }
        }
    } catch {
        # Get-NetIPAddress is missing on very old Windows - fall back to ipconfig
        Write-Warn2 "Get-NetIPAddress unavailable, falling back to ipconfig"
        $out = & ipconfig
        foreach ($line in $out) {
            if ($line -match 'IPv4 Address[^:]*:\s*([0-9]{1,3}(\.[0-9]{1,3}){3})') {
                $ip = $Matches[1]
                if ($ip -notlike '127.*') {
                    $score = 0
                    if ($ip -like '192.168.*') { $score = 100 }
                    elseif ($ip -like '10.*') { $score = 90 }
                    $candidates += [pscustomobject]@{ IP = $ip; Alias = '(ipconfig)'; Score = $score }
                }
            }
        }
    }

    return $candidates | Sort-Object -Property Score -Descending
}

$lanCandidates = Get-LanIPv4
$lanIp = $null
if ($lanCandidates -and $lanCandidates.Count -gt 0) {
    $lanIp = $lanCandidates[0].IP
    Write-Ok "$lanIp  ($($lanCandidates[0].Alias))"
    if ($lanCandidates.Count -gt 1) {
        Write-Host "         other addresses on this machine:" -ForegroundColor DarkGray
        $lanCandidates | Select-Object -Skip 1 -First 4 | ForEach-Object {
            Write-Host "           $($_.IP)  ($($_.Alias))" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Warn2 "No LAN address found - is WiFi switched on?"
}

$lanUrl = if ($lanIp) { "http://${lanIp}:${Port}" } else { $null }

# ---- THE URL, UP FRONT ---------------------------------------------------------
Show-BigUrl -Url $lanUrl
Write-Host "  Starting the servers now. The same URL is repeated at the bottom" -ForegroundColor Gray
Write-Host "  once both tiers report ready." -ForegroundColor Gray

# ==============================================================================
# 3. Optional: open the Windows Firewall
# ==============================================================================
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($OpenFirewall) {
    Write-Head "Opening the Windows Firewall"
    if (-not (Test-Admin)) {
        Write-Err2 "-OpenFirewall needs an elevated PowerShell (Run as Administrator)."
    } else {
        $ruleName = "DigiQuiz dev $Port"
        $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Ok "Firewall rule '$ruleName' already exists"
        } else {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
            Write-Ok "Added inbound rule '$ruleName' for TCP $Port on Private networks"
        }
    }
}

# ==============================================================================
# 4. Start the stack
# ==============================================================================
$env:WEB_PORT = "$Port"
if ($lanIp) { $env:DIGIQUIZ_LAN_IP = $lanIp }

$qrArgs = @()
if ($NoQr) { $qrArgs += '--no-qr' }
if (-not $script:AnsiOk) { $qrArgs += '--blocks' }

function Show-FirewallHelp {
    Write-Host ""
    Write-Host "  If your phone cannot open the page:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Windows Firewall is the usual cause. In an ADMINISTRATOR PowerShell:" -ForegroundColor White
    Write-Host "       New-NetFirewallRule -DisplayName 'DigiQuiz dev $Port' ``" -ForegroundColor Gray
    Write-Host "         -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private" -ForegroundColor Gray
    Write-Host "     or re-run as Administrator with:  .\start.ps1 -OpenFirewall" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  2. Your WiFi must be a 'Private' network, not 'Public'. Check with:" -ForegroundColor White
    Write-Host "       Get-NetConnectionProfile" -ForegroundColor Gray
    Write-Host "     and change it with (Administrator):" -ForegroundColor White
    Write-Host "       Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  3. Make sure the phone is on WiFi, not mobile data. See DEV-README.md." -ForegroundColor White
    Write-Host ""
}

if ($chosen -eq 'docker') {
    Write-Head "Starting containers (first run pulls MySQL and builds two images - a few minutes)"

    & docker compose up --build -d
    if ($LASTEXITCODE -ne 0) {
        Write-Err2 "docker compose failed. Scroll up for the reason."
        Write-Host "         If it mentions a port already in use, try:  .\start.ps1 -Port 8081"
        exit 1
    }

    Write-Host ""
    Write-Host "  Waiting for the stack to become healthy..." -ForegroundColor DarkGray
    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }

    if (-not $ready) {
        Write-Err2 "The stack did not come up in time."
        Write-Host "         Look at the logs with:  docker compose logs"
        exit 1
    }
    Write-Ok "All three containers are healthy"

    if ($nodeVersion) { & node tools/banner.js --port $Port @qrArgs }

    if ($lanIp) {
        $reach = Test-NetConnection -ComputerName $lanIp -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($reach) { Write-Ok "TCP $Port is reachable on $lanIp" }
        else { Write-Warn2 "TCP $Port did NOT answer on $lanIp - the firewall is probably blocking it"; Show-FirewallHelp }
    }

    # ---- THE URL AGAIN, AT THE END ------------------------------------------
    Show-BigUrl -Url $lanUrl -Caption 'SERVERS ARE READY - OPEN THIS ON YOUR PHONE'
    Write-Host "  Sign in:  admin / Admin123!   or   student_demo / Passw0rd!" -ForegroundColor White
    Write-Host ""
    Write-Host "  Following container logs. Press Ctrl+C to detach (containers keep running)." -ForegroundColor DarkGray
    Write-Host "  Stop everything with:  docker compose down" -ForegroundColor DarkGray
    Write-Host ""
    & docker compose logs -f
} else {
    if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
        Write-Head "Installing dependencies (three pure-JavaScript packages, no compiler needed)"
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Err2 "npm install failed. Are you online?"
            exit 1
        }
        Write-Ok "Dependencies installed"
    }

    if ($NoQr) { $env:NO_QR = '1' } else { $env:NO_QR = $null }
    if (-not $script:AnsiOk) { $env:DIGIQUIZ_QR_STYLE = 'blocks' }

    Show-FirewallHelp

    Write-Head "Starting both tiers"
    # Hands over to the Node supervisor, which starts both tiers and prints the
    # banner + QR + the big URL block itself once they are ready. Ctrl+C stops both.
    & node tools/dev.js
    exit $LASTEXITCODE
}
