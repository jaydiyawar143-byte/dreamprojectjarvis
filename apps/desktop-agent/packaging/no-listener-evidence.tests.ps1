<#
.SYNOPSIS
  Phase 19.6: pins the socket-table parser and the no-listener decision.

.DESCRIPTION
  Run by CI's desktop-agent job and by hand on Windows 11. It starts nothing;
  its one live case opens the same loopback control the check itself opens, and
  proves the merged socket table reports it. It exits 1 when any case fails.

  The cases are the regressions Phase 19.6 needs: a loopback listener, a
  wildcard listener, a clean process, an unobservable positive control, PID 0
  rows, and parser edges (IPv6, CRLF, localized headers, malformed rows).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "NoListenerEvidence.ps1")

$script:passed = 0
$script:failed = 0

function Assert-Equal($expected, $actual, [string]$case) {
  if ($expected -eq $actual) {
    $script:passed += 1
    return
  }
  $script:failed += 1
  Write-Host "FAIL: $case - expected [$expected], got [$actual]"
}

function Assert-True([bool]$condition, [string]$case) {
  if ($condition) {
    $script:passed += 1
    return
  }
  $script:failed += 1
  Write-Host "FAIL: $case"
}

function Assert-Throws([scriptblock]$action, [string]$case) {
  $threw = $false
  try { & $action | Out-Null } catch { $threw = $true }
  Assert-True $threw $case
}

# The control this check opens in its own process, as netstat shows it.
$controlRows = @"
  TCP    127.0.0.1:50505        0.0.0.0:0              LISTENING       4242
  UDP    127.0.0.1:50506        *:*                                    4242
"@

function New-FixedRows([string]$agentRows) {
  return @(ConvertFrom-NetstatOutput -Text ($controlRows + "`n" + $agentRows))
}

function Get-Verdict([string]$agentRows) {
  return Get-NoListenerVerdict -Rows (New-FixedRows $agentRows) -ProcessId 777 -ControlProcessId 4242 `
    -ControlTcpPort 50505 -ControlUdpPort 50506
}

# --- the parser ------------------------------------------------------------

$table = @"
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900
  TCP    127.0.0.1:3102         0.0.0.0:0              LISTENING       901
  TCP    127.0.0.1:50233        127.0.0.1:3102         ESTABLISHED     902
  TCP    [::1]:8080             [::]:0                 LISTENING       903
  TCP    [fe80::1%12]:1234      [fe80::1%12]:443       ESTABLISHED     904
  UDP    0.0.0.0:5353           *:*                                    905
  UDP    [::]:3702              *:*                                    906
"@
$parsed = @(ConvertFrom-NetstatOutput -Text $table)
Assert-Equal 7 $parsed.Count "the header lines are skipped and every socket row is read"
Assert-Equal "TCP" $parsed[0].Proto "the protocol is read"
Assert-Equal 135 $parsed[0].LocalPort "a wildcard listener's local port is read"
Assert-Equal "0.0.0.0" $parsed[0].LocalAddress "a wildcard listener's local address is read"
Assert-Equal "ESTABLISHED" $parsed[2].State "an outbound connection's state is read"
Assert-Equal "::1" $parsed[3].LocalAddress "IPv6 brackets are removed"
Assert-Equal 8080 $parsed[3].LocalPort "an IPv6 port is read"
Assert-Equal "fe80::1%12" $parsed[4].LocalAddress "an IPv6 zone is kept"
Assert-Equal "UDP" $parsed[5].Proto "UDP is read"
Assert-Equal "*" $parsed[5].ForeignAddress "UDP's wildcard peer is read"
Assert-Equal 0 $parsed[5].ForeignPort "UDP's wildcard peer is port zero"
Assert-Equal "" $parsed[5].State "UDP has no state"

Assert-Equal 0 @(ConvertFrom-NetstatOutput -Text "").Count "empty output has no rows"
Assert-Equal 0 @(ConvertFrom-NetstatOutput -Text "Active Connections`r`n`r`n  Proto  Local Address").Count "localized headers are skipped"

$mixed = "  tcp    127.0.0.1:5000         0.0.0.0:0              LISTENING       7   `r`n  udp    127.0.0.1:5001         *:*                                    8"
$mixedRows = @(ConvertFrom-NetstatOutput -Text $mixed)
Assert-Equal 2 $mixedRows.Count "CRLF, extra spaces and lower-case protocol names are read"
Assert-Equal "TCP" $mixedRows[0].Proto "a lower-case protocol is normalized"
Assert-Equal 7 $mixedRows[0].OwningProcess "a pid with trailing spaces is read"

Assert-Throws { ConvertFrom-NetstatOutput -Text "  TCP    127.0.0.1:80" } "a truncated TCP row is an error, not a clean read"
Assert-Throws { ConvertFrom-NetstatOutput -Text "  TCP    127.0.0.1:80        0.0.0.0:0              LISTENING       abc" } "a non-numeric pid is an error"
Assert-Throws { ConvertFrom-NetstatOutput -Text "  TCP    127.0.0.1:99999     0.0.0.0:0              LISTENING       5" } "a port out of range is an error"
Assert-Throws { ConvertFrom-NetstatOutput -Text "  UDP    127.0.0.1:53         *:*" } "a truncated UDP row is an error, not a clean read"
Assert-Throws { ConvertFrom-NetstatOutput -Text "  TCP    :80                 0.0.0.0:0              LISTENING       5" } "a row with no address is an error"

# --- the decision ----------------------------------------------------------

$clean = Get-Verdict "  TCP    127.0.0.1:50233        127.0.0.1:443          ESTABLISHED     777"
Assert-Equal "CLEAN" $clean.Status "a process with only an outbound connection is clean"
Assert-Equal 1 $clean.Outbound.Count "the outbound connection is recorded"
Assert-Equal 0 $clean.Listening.Count "a clean process owns no TCP listener"
Assert-Equal 0 $clean.Endpoints.Count "a clean process owns no UDP endpoint"

$loopback = Get-Verdict "  TCP    127.0.0.1:6000         0.0.0.0:0              LISTENING       777"
Assert-Equal "LISTENER" $loopback.Status "a loopback TCP listener is caught"
Assert-Equal 6000 $loopback.Listening[0].LocalPort "the loopback listener's port is named"

$wildcard = Get-Verdict "  TCP    0.0.0.0:7000           0.0.0.0:0              LISTENING       777"
Assert-Equal "LISTENER" $wildcard.Status "a wildcard TCP listener is caught"
Assert-Equal "0.0.0.0" $wildcard.Listening[0].LocalAddress "the wildcard listener's address is named"

# The state name is localized on some builds; a wildcard peer is enough.
$localized = Get-Verdict "  TCP    127.0.0.1:6001         0.0.0.0:0              ABHOEREN        777"
Assert-Equal "LISTENER" $localized.Status "a listener is caught without relying on an English state name"

$ipv6 = Get-Verdict "  TCP    [::]:7001              [::]:0                 LISTENING       777"
Assert-Equal "LISTENER" $ipv6.Status "an IPv6 wildcard listener is caught"
Assert-Equal "::" $ipv6.Listening[0].LocalAddress "the IPv6 wildcard address is named"

$udp = Get-Verdict "  UDP    0.0.0.0:6002           *:*                                    777"
Assert-Equal "LISTENER" $udp.Status "a UDP endpoint is caught"
Assert-Equal 6002 $udp.Endpoints[0].LocalPort "the UDP endpoint's port is named"

# A listener the cross-check saw and netstat omitted is still caught. The
# cmdlet rows carry a null state on build 26300; the peer is what decides.
$crossCheckOnly = @([pscustomobject]@{
    Proto = "TCP"; LocalAddress = "127.0.0.1"; LocalPort = 6003
    ForeignAddress = "0.0.0.0"; ForeignPort = 0; State = ""; OwningProcess = 777
  })
$merged = Get-NoListenerVerdict -Rows (@(New-FixedRows "  TCP    127.0.0.1:50233        127.0.0.1:443          ESTABLISHED     777") + $crossCheckOnly) `
  -ProcessId 777 -ControlProcessId 4242 -ControlTcpPort 50505 -ControlUdpPort 50506
Assert-Equal "LISTENER" $merged.Status "a listener only the cross-check saw is never hidden"

# PID 0 is the kernel's stale placeholder, not the process under test.
$pidZero = Get-Verdict "  TCP    127.0.0.1:50233        127.0.0.1:443          ESTABLISHED     777`n  TCP    0.0.0.0:6004           0.0.0.0:0              LISTENING       0`n  UDP    0.0.0.0:6005           *:*                                    0"
Assert-Equal "CLEAN" $pidZero.Status "PID 0 rows are not attributed to the process under test"

# The control is the proof the read worked. Without it, nothing is clean.
$unobserved = Get-NoListenerVerdict -Rows @(ConvertFrom-NetstatOutput -Text "  TCP    127.0.0.1:50233        127.0.0.1:443          ESTABLISHED     777") `
  -ProcessId 777 -ControlProcessId 4242 -ControlTcpPort 50505 -ControlUdpPort 50506
Assert-Equal "CONTROL_UNOBSERVED" $unobserved.Status "a table without the control gives no verdict"
Assert-True ($unobserved.Detail -match "not in the socket table") "an unobservable control says why"

# --- the live control: netstat really sees a socket this process opened ----

if (Get-Command netstat.exe -ErrorAction SilentlyContinue) {
  $control = New-NoListenerControl
  try {
    $live = Get-NoListenerObservation -ProcessId $PID -ControlProcessId $control.ProcessId `
      -ControlTcpPort $control.TcpPort -ControlUdpPort $control.UdpPort
    Assert-Equal "LISTENER" $live.Status "a real loopback listener in this process is detected from the merged table"
    Assert-True ($live.Sources -match "netstat") "netstat is read"
    Assert-True (@($live.Listening | Where-Object { $_.LocalPort -eq $control.TcpPort }).Count -ge 1) "the control's TCP row is in the table"
    Assert-True (@($live.Endpoints | Where-Object { $_.LocalPort -eq $control.UdpPort }).Count -ge 1) "the control's UDP row is in the table"
  } finally {
    Close-NoListenerControl $control
  }
} else {
  Write-Host "skip: netstat.exe is not available here, so the live control cannot run."
}

Write-Host ""
Write-Host "no-listener-evidence: $script:passed passed, $script:failed failed."
if ($script:failed -gt 0) { exit 1 }
exit 0
