# Runs INSIDE Windows Sandbox as its logon command; started by scripts/test/activation-sandbox.ps1.
# C:\in is read-only input, C:\vscode is the host's VS Code installation (read-only), and C:\out
# is the only folder shared back with the host. The sandbox has no network adapter.
$ErrorActionPreference = 'Continue'
$in = 'C:\in'
$out = 'C:\out'
$work = 'C:\work'
function Stamp { Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff zzz' }
Start-Transcript -Path (Join-Path $out 'inside-transcript.txt') -Force | Out-Null
try {
    'start ' + (Stamp)
    'windows ' + (Get-CimInstance Win32_OperatingSystem).Version
    # Each evidence line names its cmdlet's error: a cmdlet that fails must not read as "none".
    'network adapters: ' + $(try { @(Get-NetAdapter -ErrorAction Stop).Count } catch { 'ERROR ' + $_.Exception.Message })
    'Visual C++ runtime files in System32: ' + $(try { $vc = @(Get-ChildItem 'C:\Windows\System32\vcruntime140*.dll', 'C:\Windows\System32\msvcp140*.dll' -ErrorAction Stop | ForEach-Object Name); if ($vc.Count) { $vc -join ', ' } else { 'none' } } catch { 'ERROR ' + $_.Exception.Message })
    $ud = Join-Path $work 'user-data'
    $ext = Join-Path $work 'extensions'
    New-Item -ItemType Directory -Force -Path (Join-Path $ud 'User'), $ext | Out-Null
    Copy-Item (Join-Path $in 'settings.json') (Join-Path $ud 'User\settings.json')
    $cli = 'C:\vscode\bin\code.cmd'
    'code --version: ' + ((& $cli --version 2>&1) -join ' | ')
    foreach ($v in 'voqr.vsix', 'probe.vsix') {
        $log = Join-Path $out ('install-' + [IO.Path]::GetFileNameWithoutExtension($v) + '.txt')
        & $cli --user-data-dir $ud --extensions-dir $ext --install-extension (Join-Path $in $v) *> $log
        'install ' + $v + ' exit ' + $LASTEXITCODE
    }
    Get-ChildItem -Recurse -File $ext | ForEach-Object { '{0,12} {1}' -f $_.Length, $_.FullName.Substring($ext.Length) } |
        Set-Content (Join-Path $out 'installed-files.txt')
    $env:VOQR_PROBE_OUT = Join-Path $out 'probe.json'
    $editorArgs = @('--user-data-dir', $ud, '--extensions-dir', $ext, '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes', '--disable-updates', '--new-window')
    $editor = Start-Process -FilePath 'C:\vscode\Code.exe' -ArgumentList $editorArgs -PassThru
    'editor started, pid ' + $editor.Id + ' at ' + (Stamp)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path $env:VOQR_PROBE_OUT) -and $sw.Elapsed.TotalSeconds -lt 300) { Start-Sleep -Seconds 2 }
    if (Test-Path $env:VOQR_PROBE_OUT) { 'probe record after ' + [int]$sw.Elapsed.TotalSeconds + ' s' } else { 'NO probe record after 300 s' }
    Start-Sleep -Seconds 8
    Get-Process -Name Code -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Copy-Item -Recurse (Join-Path $ud 'logs') (Join-Path $out 'logs') -ErrorAction SilentlyContinue
    Get-ChildItem $ext -Directory | ForEach-Object {
        $f = Join-Path $_.FullName 'voqr-debug.log'
        if (Test-Path $f) { Copy-Item $f (Join-Path $out 'voqr-debug.log') }
    }
    'end ' + (Stamp)
} catch {
    'ERROR ' + $_.Exception.Message
}
Stop-Transcript | Out-Null
Set-Content -Path (Join-Path $out 'done.txt') -Value ('done ' + (Stamp))
shutdown.exe /s /t 0
