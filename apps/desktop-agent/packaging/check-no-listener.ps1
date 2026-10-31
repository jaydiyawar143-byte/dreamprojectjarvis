<#
.SYNOPSIS
  Phase 19.6: proves the running agent opens no inbound port.

.DESCRIPTION
  Reads the sockets of the agent that is ALREADY running: the installed agent,
  started from the Start menu, paired, polling and with control allowed
  (docs/DEPLOYMENT.md). For -Seconds it samples every TCP connection and UDP
  endpoint that one process owns.

  It never starts the agent, and must not. The agent is single-instance, so a
  copy started beside a paired agent exits at once: a check of that copy
  inspects nothing and passes.

  It fails, and says why, when:
    - no agent is running, or more than one is;
    - the agent owns a TCP socket in the Listen state, or any UDP endpoint;
    - the agent stops during the check;
    - the agent never holds an established connection: it is not paired and
      polling, so nothing has been proven;
    - the socket tables cannot be read. A failed read is never "no sockets".

  This is the proof for the "no inbound port" exit criterion, and it needs a
  Windows 11 test machine. CI cannot run it: the Windows Server runner stops the
  agent at its platform check, so CI's own step shows only that start-up opens
  nothing.

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

$agentName = "Jarvis.DesktopAgent"

function Fail([string]$message) {
  Write-Host "check-no-listener: FAILED - $message"
  exit 1
}

foreach ($cmdlet in @("Get-NetTCPConnection", "Get-NetUDPEndpoint")) {
  if (-not (Get-Command $cmdlet -ErrorAction SilentlyContinue)) { Fail "$cmdlet is not available here, so the sockets cannot be read." }
}

$agents = @(Get-Process -Name $agentName -ErrorAction SilentlyContinue)
if ($agents.Count -eq 0) { Fail "no running agent. Start it from the Start menu, pair it and allow control; this check never starts one." }
if ($agents.Count -gt 1) { Fail "$($agents.Count) agents are running (pids $(($agents | ForEach-Object { $_.Id }) -join ', ')). Sign out every other account first." }

$agent = $agents[0]
$agentId = $agent.Id
$startedAt = $agent.StartTime
Write-Host "check-no-listener: inspecting the running agent, pid $agentId, started $startedAt, for $Seconds seconds."

$established = @{}
$samples = 0
$deadline = (Get-Date).AddSeconds($Seconds)
while ($true) {
  try {
    # The whole table, then this process's rows. Asked for one process, Windows
    # answers with an error when it owns nothing, and hiding that error would
    # hide a read that really failed.
    $tcp = @(Get-NetTCPConnection -ErrorAction Stop)
    $udp = @(Get-NetUDPEndpoint -ErrorAction Stop)
  } catch {
    Fail "the sockets could not be read: $($_.Exception.Message)"
  }
  # Windows always has listeners of its own. None at all means this was not a real read.
  if (@($tcp | Where-Object { $_.State -eq "Listen" }).Count -eq 0) { Fail "no listener anywhere on this computer, so the sockets were not really read." }

  $current = Get-Process -Id $agentId -ErrorAction SilentlyContinue
  if (-not $current -or $current.StartTime -ne $startedAt) { Fail "the agent (pid $agentId) stopped during the check." }

  $owned = @($tcp | Where-Object { $_.OwningProcess -eq $agentId })
  $listening = @($owned | Where-Object { $_.State -eq "Listen" })
  $endpoints = @($udp | Where-Object { $_.OwningProcess -eq $agentId })
  foreach ($c in $listening) { Write-Host "LISTENING: $($c.LocalAddress):$($c.LocalPort)" }
  foreach ($u in $endpoints) { Write-Host "UDP: $($u.LocalAddress):$($u.LocalPort)" }
  if ($listening.Count -gt 0 -or $endpoints.Count -gt 0) { Fail "the agent (pid $agentId) opened an inbound port." }

  foreach ($c in @($owned | Where-Object { $_.State -eq "Established" })) { $established["$($c.RemoteAddress):$($c.RemotePort)"] = $true }

  $samples += 1
  Write-Host "check-no-listener: sample $samples clean."
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds 1
}

if ($established.Count -eq 0) { Fail "the agent (pid $agentId) held no connection to a server for $Seconds seconds: it is not paired and polling, so nothing is proven." }
Write-Host "check-no-listener: PASS - the running agent (pid $agentId) owned no TCP listener and no UDP endpoint across $samples samples in $Seconds seconds. Its connections: $(($established.Keys | Sort-Object) -join ', ')."
