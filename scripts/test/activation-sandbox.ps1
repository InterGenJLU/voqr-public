<#
.SYNOPSIS
    Does a VOQR package activate on a clean Windows? Installs the .vsix into a new, empty
    VS Code profile inside Windows Sandbox and reports what the editor says.
.DESCRIPTION
    The sandbox has no network adapter and no microphone, camera, clipboard or printer. It sees
    three folders: the host's VS Code installation (read-only), an input folder holding the two
    packages and the inside script (read-only), and an output folder (the only writable one).
    Inside, scripts/test/sandbox/inside-activation.ps1 installs the VOQR package and the test-only
    probe extension (scripts/test/probe) into a new profile, starts the editor, lets the probe ask
    VS Code to activate VOQR, copies the editor's logs out, and shuts the sandbox down.
      PASS, exit 0: VOQR activated, registered voqr.pushToTalk and voqr.toggleVoicePanel, both
                    commands ran when executed, and VOQR's panel (voqr.voicePanel) opened.
      FAIL, exit 1: it did not; the activation error and each command's error are printed as
                    the editor reports them.
      exit 2: the run itself did not complete.
    Needs Windows Sandbox (Windows feature Containers-DisposableClientVM) with the hypervisor on.
    A sandbox window opens and closes by itself; nothing in it needs a click.
.EXAMPLE
    pwsh -NoProfile -File scripts/test/activation-sandbox.ps1 -Vsix D:\pkg\voqr.vsix -ProbeVsix D:\pkg\probe.vsix -OutDir D:\runs\run1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Vsix,
    [Parameter(Mandatory = $true)][string]$ProbeVsix,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$VSCodeDir = (Join-Path $env:ProgramFiles 'Microsoft VS Code'),
    [int]$TimeoutSec = 900
)
$ErrorActionPreference = 'Stop'
function Stamp { Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz' }
function X([string]$s) { [Security.SecurityElement]::Escape($s) }

$sandboxExe = Join-Path $env:windir 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandboxExe)) { Write-Output 'Windows Sandbox is not installed'; exit 2 }
if (Get-Process -Name WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) { Write-Output 'a sandbox is already running'; exit 2 }
foreach ($p in $Vsix, $ProbeVsix) { if (-not (Test-Path -PathType Leaf $p)) { Write-Output "missing input: $p"; exit 2 } }
if (-not (Test-Path (Join-Path $VSCodeDir 'Code.exe'))) { Write-Output "no Code.exe in $VSCodeDir"; exit 2 }
if ((Test-Path $OutDir) -and (Get-ChildItem -Force $OutDir | Select-Object -First 1)) { Write-Output "OutDir must be new or empty: $OutDir"; exit 2 }

$OutDir = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$inDir = (New-Item -ItemType Directory -Path (Join-Path $OutDir 'in')).FullName
$resDir = (New-Item -ItemType Directory -Path (Join-Path $OutDir 'out')).FullName
Copy-Item $Vsix (Join-Path $inDir 'voqr.vsix')
Copy-Item $ProbeVsix (Join-Path $inDir 'probe.vsix')
Copy-Item (Join-Path $PSScriptRoot 'sandbox\inside-activation.ps1') $inDir
Copy-Item (Join-Path $PSScriptRoot 'sandbox\settings.json') $inDir
$runLog = Join-Path $OutDir 'run.txt'
function Say([string]$line) { $line | Tee-Object -FilePath $runLog -Append }

Say ('start ' + (Stamp) + ' | package ' + (Resolve-Path $Vsix))
Get-ChildItem -File $inDir | ForEach-Object { Say ('input sha256 ' + (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower() + ' ' + $_.Name + ' ' + $_.Length + ' bytes') }
$product = Get-ChildItem -Path $VSCodeDir -Recurse -Depth 3 -Filter product.json -ErrorAction SilentlyContinue | Select-Object -First 1
if ($product) { $pj = Get-Content $product.FullName -Raw | ConvertFrom-Json; Say ('editor ' + $pj.nameLong + ' commit ' + $pj.commit) }

$wsb = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>6144</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$(X $VSCodeDir)</HostFolder><SandboxFolder>C:\vscode</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(X $inDir)</HostFolder><SandboxFolder>C:\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(X $resDir)</HostFolder><SandboxFolder>C:\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\in\inside-activation.ps1</Command></LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $OutDir 'run.wsb'
Set-Content -Path $wsbPath -Value $wsb -Encoding ascii
Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $wsbPath + '"')
$done = Join-Path $resDir 'done.txt'
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $done) -and $sw.Elapsed.TotalSeconds -lt $TimeoutSec) { Start-Sleep -Seconds 5 }
if (-not (Test-Path $done)) { Say ('TIMEOUT: the sandbox did not finish within ' + $TimeoutSec + ' s'); exit 2 }
Say ('sandbox finished after ' + [int]$sw.Elapsed.TotalSeconds + ' s')
# The sandbox shuts itself down, but its window then stays open on an error dialog ("The remote
# environment is shutting down. The connection will be closed.") and blocks the next run.
# Give the guest time to finish, then close that window.
Start-Sleep -Seconds 15
$left = Get-Process -Name WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force; Say ('closed the sandbox window: ' + (($left | ForEach-Object Name) -join ', ')) }
Start-Sleep -Seconds 3
if (Get-Process -Name WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) { Say 'WARNING: the sandbox window is still open' }

$probePath = Join-Path $resDir 'probe.json'
if (-not (Test-Path $probePath)) { Say 'no probe record: the editor or the probe did not run (see out\inside-transcript.txt)'; exit 2 }
$probe = Get-Content $probePath -Raw | ConvertFrom-Json
Say ('VOQR installed: ' + $probe.installed + ' | version ' + $probe.version + ' | editor ' + $probe.vscodeVersion + ' ' + $probe.platform + '-' + $probe.arch)
Say ('VOQR activated: ' + $probe.activated)
if ($probe.activationError) { ($probe.activationError -split "`n") | Select-Object -First 3 | ForEach-Object { Say ('  editor says: ' + $_) } }
Say ('voqr commands registered: ' + (@($probe.voqrCommands) -join ', '))
if ($probe.vad) { Say ('voice-activity model: ' + $probe.vad.framesProcessed + ' frames processed, last speech probability ' + $probe.vad.lastIsSpeech) }
if ($probe.vadError) { Say ('voice-activity model: ERROR ' + (($probe.vadError -split "`n")[0])) }
$exthost = Get-ChildItem -Recurse -File -Filter exthost.log (Join-Path $resDir 'logs') -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exthost) {
    Select-String -Path $exthost.FullName -Pattern 'intergen\.voqr' | Select-Object -First 6 | ForEach-Object { Say ('  exthost.log: ' + $_.Line.Trim()) }
} else { Say '  exthost.log: not found' }
$debugLog = Join-Path $resDir 'voqr-debug.log'
if (Test-Path $debugLog) {
    Select-String -Path $debugLog -Pattern 'micstream|avr-vad|Failed|Error' | Select-Object -First 8 | ForEach-Object { Say ('  voqr-debug.log: ' + $_.Line.Trim()) }
}
foreach ($run in @($probe.commandsRun)) {
    Say ('command ' + $run.command + ': ' + $(if ($run.ran -eq $true) { 'ran' } else { 'FAILED: ' + (($run.error -split "`n")[0]) }))
}
Say ('webview tabs open: ' + ((@($probe.webviewTabs) | ForEach-Object { $_.label + ' (' + $_.viewType + ')' }) -join ', '))
$cmds = @($probe.voqrCommands)
$ran = @($probe.commandsRun | Where-Object { $_.ran -eq $true } | ForEach-Object { $_.command })
$panel = @($probe.webviewTabs | Where-Object { $_.viewType -like '*voqr.voicePanel' }).Count -gt 0
$pass = ($probe.activated -eq $true) -and ($cmds -contains 'voqr.pushToTalk') -and ($cmds -contains 'voqr.toggleVoicePanel') -and
        ($ran -contains 'voqr.pushToTalk') -and ($ran -contains 'voqr.toggleVoicePanel') -and $panel
Say ('VERDICT: ' + $(if ($pass) { 'PASS' } else { 'FAIL' }) + ' at ' + (Stamp))
if ($pass) { exit 0 } else { exit 1 }
