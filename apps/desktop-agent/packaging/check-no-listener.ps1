<#
.SYNOPSIS
  Phase 19.6: proves the running agent opens no inbound port.

.DESCRIPTION
  Reads the sockets of the agent that is ALREADY running: the installed agent,
  started from the Start menu, paired, polling and with control allowed
  (docs/DEPLOYMENT.md). For -Seconds it samples every TCP connection and UDP
  endpoint that one process owns.

  The evidence is `netstat -ano` and, as a cross-check, the Get-NetTCPConnection
  and Get-NetUDPEndpoint cmdlets (packaging/NoListenerEvidence.ps1). On Windows
  11 build 26300 netstat omits TCP listeners owned by a user-session process,
  and Get-NetTCPConnection lists them with a null State - so the old
  `State -eq "Listen"` filter reported none, and the check passed while a port
  was open. Both tables are read; a finding from either is a finding.

  Every sample also has to show a loopback TCP listener and a loopback UDP
  socket that this check opened in its own process. If neither source can show
  them, the sample is FAILED / INCONCLUSIVE - a clean sample from a table that
  cannot see a socket opened a moment ago proves nothing.

  It never starts the agent, and must not. The agent is single-instance, so a
  copy started beside a paired agent exits at once: a check of that copy
  inspects nothing and passes.

  It fails, and says why, when:
    - no agent is running, or more than one is;
    - the agent owns a TCP socket in the Listen state, or any UDP endpoint;
    - the agent stops during the check;
    - the agent never holds an established connection: it is not paired and
      polling, so nothing has been proven;
    - the socket table cannot be read, or cannot show the positive control.

  This is the proof for the "no inbound port" exit criterion, and it needs a
  Windows 11 test machine. CI runs the same parser and the same decision
  (packaging/no-listener-evidence.tests.ps1 and the start-up step), but it
  cannot run this check: the Windows Server runner stops the agent at its
  platform check, so CI's own step shows only that start-up opens nothing.

.EXAMPLE
  ./check-no-listener.ps1
#>
[CmdletBinding()]
param(
  # One full long-poll (held up to 20 seconds) and a margin.
  [ValidateRange(1, 600)][int]$Seconds = 25
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "NoListenerEvidence.ps1")

$agentName = "Jarvis.DesktopAgent"
$script:control = $null

function Fail([string]$message) {
  if ($null -ne $script:control) {
    Close-NoListenerControl $script:control
    $script:control = $null
  }
  Write-Host "check-no-listener: FAILED - $message"
  exit 1
}

if (-not (Get-Command netstat.exe -ErrorAction SilentlyContinue)) {
  Fail "netstat.exe is not available here, so the socket table cannot be read."
}

$agents = @(Get-Process -Name $agentName -ErrorAction SilentlyContinue)
if ($agents.Count -eq 0) { Fail "no running agent. Start it from the Start menu, pair it and allow control; this check never starts one." }
if ($agents.Count -gt 1) { Fail "$($agents.Count) agents are running (pids $(($agents | ForEach-Object { $_.Id }) -join ', ')). Sign out every other account first." }

$agent = $agents[0]
$agentId = $agent.Id
$startedAt = $agent.StartTime
Write-Host "check-no-listener: inspecting the running agent, pid $agentId, started $startedAt, for $Seconds seconds."

$script:control = New-NoListenerControl
$control = $script:control
Write-Host "check-no-listener: positive control - loopback tcp port $($control.TcpPort) and udp port $($control.UdpPort) opened by this check (pid $($control.ProcessId)); every sample must show both."

# The control may take a moment to appear in the table. Wait for one sample
# that shows it before the check makes any claim, then keep checking it in
# every sample.
$observation = $null
$controlDeadline = (Get-Date).AddSeconds(5)
while ($true) {
  try {
    $observation = Get-NoListenerObservation -ProcessId $agentId -ControlProcessId $control.ProcessId -ControlTcpPort $control.TcpPort -ControlUdpPort $control.UdpPort
  } catch {
    Fail "the socket table could not be read: $($_.Exception.Message)"
  }
  if ($observation.Status -ne "CONTROL_UNOBSERVED") { break }
  if ((Get-Date) -ge $controlDeadline) {
    Fail "INCONCLUSIVE - $($observation.Detail). A clean sample from a table that cannot see a socket opened a moment ago proves nothing."
  }
  Start-Sleep -Milliseconds 250
}
Write-Host "check-no-listener: positive control observed (sources: $($observation.Sources))."

$established = @{}
$samples = 0
$deadline = (Get-Date).AddSeconds($Seconds)
while ($true) {
  $current = Get-Process -Id $agentId -ErrorAction SilentlyContinue
  if (-not $current -or $current.StartTime -ne $startedAt) { Fail "the agent (pid $agentId) stopped during the check." }

  try {
    $observation = Get-NoListenerObservation -ProcessId $agentId -ControlProcessId $control.ProcessId -ControlTcpPort $control.TcpPort -ControlUdpPort $control.UdpPort
  } catch {
    Fail "the socket table could not be read: $($_.Exception.Message)"
  }
  if ($observation.Status -eq "CONTROL_UNOBSERVED") {
    Fail "INCONCLUSIVE - $($observation.Detail). This sample proves nothing."
  }

  foreach ($row in $observation.Listening) { Write-Host "LISTENING: $($row.LocalAddress):$($row.LocalPort)" }
  foreach ($row in $observation.Endpoints) { Write-Host "UDP: $($row.LocalAddress):$($row.LocalPort)" }
  if ($observation.Status -eq "LISTENER") { Fail "the agent (pid $agentId) opened an inbound port." }

  foreach ($row in $observation.Outbound) { $established["$($row.ForeignAddress):$($row.ForeignPort)"] = $true }

  $samples += 1
  Write-Host "check-no-listener: sample $samples clean."
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds 1
}

if ($established.Count -eq 0) {
  Fail "the agent (pid $agentId) held no connection to a server for $Seconds seconds: it is not paired and polling, so nothing is proven."
}
Close-NoListenerControl $control
$script:control = $null
Write-Host "check-no-listener: PASS - the running agent (pid $agentId) owned no TCP listener and no UDP endpoint across $samples samples in $Seconds seconds, and the positive control was seen in every sample. Its connections: $(($established.Keys | Sort-Object) -join ', ')."
