<#
.SYNOPSIS
  Phase 19.6: the one reading of this computer's socket table.

.DESCRIPTION
  No single Windows surface is sufficient. The Phase 19.6 QA record reproduced,
  on Windows 11 build 26300:

    - `netstat -ano` omitted TCP listeners owned by a user-session process
      (node, PowerShell, loopback and wildcard alike), while showing system
      listeners, outbound connections and UDP endpoints;
    - `Get-NetTCPConnection` listed a user-session listener with a null State,
      and invented a peerless 0.0.0.0 row for every outbound client socket too -
      so neither its State nor its mere presence can tell a listener from a
      polling agent.

  So this file reads three things and judges their union:

    1. `netstat -ano` (primary), parsed;
    2. `GetExtendedTcpTable` / `GetExtendedUdpTable` (the IP Helper API through
       iphlpapi.dll), which on build 26300 gives the real rows - a listener is
       state 0 with a wildcard peer there, and a connected client has only its
       Established row;
    3. `Get-NetTCPConnection -State Listen` and `Get-NetUDPEndpoint` as a
       positive-only cross-check: a row from them can add a finding, never
       remove one. The unfiltered TCP cmdlet rows are not used at all, for the
       reason above.

  A facing from any source is a finding. The positive control opens one loopback
  TCP listener and one loopback UDP socket in the calling process; every sample
  must show both from at least one source, so a table that cannot see a socket
  opened a moment ago is INCONCLUSIVE, never PASS.

  Nothing here starts a process. It is dot-sourced by
  packaging/check-no-listener.ps1, by the CI start-up step and by
  no-listener-evidence.tests.ps1, so all three use one parser and one decision.
#>
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;

namespace Jarvis.NoListener
{
    public sealed class SocketRow
    {
        public string Proto;
        public string LocalAddress;
        public int LocalPort;
        public string ForeignAddress;
        public int ForeignPort;
        public int State;
        public int OwningProcess;
    }

    public static class SocketTable
    {
        private const int AF_INET = 2;
        private const int AF_INET6 = 23;
        private const int TCP_TABLE_OWNER_PID_ALL = 5;
        private const int UDP_TABLE_OWNER_PID = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct MIB_TCPROW_OWNER_PID
        {
            public uint state;
            public uint localAddr;
            public uint localPort;
            public uint remoteAddr;
            public uint remotePort;
            public uint owningPid;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MIB_TCP6ROW_OWNER_PID
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] localAddr;
            public uint localScopeId;
            public uint localPort;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] remoteAddr;
            public uint remoteScopeId;
            public uint remotePort;
            public uint state;
            public uint owningPid;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MIB_UDPROW_OWNER_PID
        {
            public uint localAddr;
            public uint localPort;
            public uint owningPid;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MIB_UDP6ROW_OWNER_PID
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] localAddr;
            public uint localScopeId;
            public uint localPort;
            public uint owningPid;
        }

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

        private static int Port(uint value)
        {
            return (int)(ushort)(((value & 0xFF) << 8) | (value >> 8));
        }

        public static SocketRow[] Tcp()
        {
            var rows = new List<SocketRow>();
            ReadTcp4(rows);
            ReadTcp6(rows);
            return rows.ToArray();
        }

        public static SocketRow[] Udp()
        {
            var rows = new List<SocketRow>();
            ReadUdp4(rows);
            ReadUdp6(rows);
            return rows.ToArray();
        }

        private static void ReadTcp4(List<SocketRow> rows)
        {
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
            if (size <= 0) throw new InvalidOperationException("GetExtendedTcpTable (AF_INET) returned no size: " + result);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedTcpTable(buffer, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
                if (result != 0) throw new InvalidOperationException("GetExtendedTcpTable (AF_INET): " + result);
                int count = Marshal.ReadInt32(buffer);
                IntPtr row = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf(typeof(MIB_TCPROW_OWNER_PID));
                for (int i = 0; i < count; i++)
                {
                    var r = (MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(IntPtr.Add(row, i * rowSize), typeof(MIB_TCPROW_OWNER_PID));
                    var target = new SocketRow();
                    target.Proto = "TCP";
                    target.LocalAddress = new IPAddress((long)r.localAddr).ToString();
                    target.LocalPort = Port(r.localPort);
                    target.ForeignAddress = new IPAddress((long)r.remoteAddr).ToString();
                    target.ForeignPort = Port(r.remotePort);
                    target.State = (int)r.state;
                    target.OwningProcess = (int)r.owningPid;
                    rows.Add(target);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static void ReadTcp6(List<SocketRow> rows)
        {
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0);
            if (size <= 0) return;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedTcpTable(buffer, ref size, false, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0);
                if (result != 0) throw new InvalidOperationException("GetExtendedTcpTable (AF_INET6): " + result);
                int count = Marshal.ReadInt32(buffer);
                IntPtr row = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf(typeof(MIB_TCP6ROW_OWNER_PID));
                for (int i = 0; i < count; i++)
                {
                    var r = (MIB_TCP6ROW_OWNER_PID)Marshal.PtrToStructure(IntPtr.Add(row, i * rowSize), typeof(MIB_TCP6ROW_OWNER_PID));
                    var target = new SocketRow();
                    target.Proto = "TCP";
                    target.LocalAddress = new IPAddress(r.localAddr).ToString();
                    target.LocalPort = Port(r.localPort);
                    target.ForeignAddress = new IPAddress(r.remoteAddr).ToString();
                    target.ForeignPort = Port(r.remotePort);
                    target.State = (int)r.state;
                    target.OwningProcess = (int)r.owningPid;
                    rows.Add(target);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static void ReadUdp4(List<SocketRow> rows)
        {
            int size = 0;
            uint result = GetExtendedUdpTable(IntPtr.Zero, ref size, false, AF_INET, UDP_TABLE_OWNER_PID, 0);
            if (size <= 0) throw new InvalidOperationException("GetExtendedUdpTable (AF_INET) returned no size: " + result);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedUdpTable(buffer, ref size, false, AF_INET, UDP_TABLE_OWNER_PID, 0);
                if (result != 0) throw new InvalidOperationException("GetExtendedUdpTable (AF_INET): " + result);
                int count = Marshal.ReadInt32(buffer);
                IntPtr row = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf(typeof(MIB_UDPROW_OWNER_PID));
                for (int i = 0; i < count; i++)
                {
                    var r = (MIB_UDPROW_OWNER_PID)Marshal.PtrToStructure(IntPtr.Add(row, i * rowSize), typeof(MIB_UDPROW_OWNER_PID));
                    var target = new SocketRow();
                    target.Proto = "UDP";
                    target.LocalAddress = new IPAddress((long)r.localAddr).ToString();
                    target.LocalPort = Port(r.localPort);
                    target.ForeignAddress = "*";
                    target.ForeignPort = 0;
                    target.State = 0;
                    target.OwningProcess = (int)r.owningPid;
                    rows.Add(target);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static void ReadUdp6(List<SocketRow> rows)
        {
            int size = 0;
            uint result = GetExtendedUdpTable(IntPtr.Zero, ref size, false, AF_INET6, UDP_TABLE_OWNER_PID, 0);
            if (size <= 0) return;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                result = GetExtendedUdpTable(buffer, ref size, false, AF_INET6, UDP_TABLE_OWNER_PID, 0);
                if (result != 0) throw new InvalidOperationException("GetExtendedUdpTable (AF_INET6): " + result);
                int count = Marshal.ReadInt32(buffer);
                IntPtr row = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf(typeof(MIB_UDP6ROW_OWNER_PID));
                for (int i = 0; i < count; i++)
                {
                    var r = (MIB_UDP6ROW_OWNER_PID)Marshal.PtrToStructure(IntPtr.Add(row, i * rowSize), typeof(MIB_UDP6ROW_OWNER_PID));
                    var target = new SocketRow();
                    target.Proto = "UDP";
                    target.LocalAddress = new IPAddress(r.localAddr).ToString();
                    target.LocalPort = Port(r.localPort);
                    target.ForeignAddress = "*";
                    target.ForeignPort = 0;
                    target.State = 0;
                    target.OwningProcess = (int)r.owningPid;
                    rows.Add(target);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }
}
'@

if (-not ("Jarvis.NoListener.SocketTable" -as [type])) {
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
}

<#
  Reads one "address:port" token from netstat. IPv6 addresses are bracketed
  ("[::1]:443", "[fe80::1%12]:443"); UDP peers are "*:*".
#>
function ConvertFrom-NetstatEndpoint {
  param([Parameter(Mandatory)][string]$Token)

  $index = $Token.LastIndexOf(":")
  if ($index -lt 1 -or $index -eq $Token.Length - 1) { throw "endpoint is not address:port: $Token" }
  $address = $Token.Substring(0, $index)
  $port = $Token.Substring($index + 1)
  if ($address -eq "*" -and $port -eq "*") {
    return [pscustomobject]@{ Address = "*"; Port = 0 }
  }
  if ($address.StartsWith("[") -and $address.EndsWith("]")) {
    $address = $address.Substring(1, $address.Length - 2)
  }
  if ($address -eq "") { throw "endpoint has no address: $Token" }
  if ($port -notmatch "^\d{1,5}$") { throw "endpoint has no numeric port: $Token" }
  $number = [int]$port
  if ($number -gt 65535) { throw "endpoint port is out of range: $Token" }
  return [pscustomobject]@{ Address = $address; Port = $number }
}

<#
  Turns netstat -ano output into rows. Anything that is not a TCP or UDP row is
  skipped, because netstat's header words are localized; a row that starts with
  TCP or UDP but cannot be read in full is an error, never a silent skip, so a
  broken read can never look like "no sockets".
#>
function ConvertFrom-NetstatOutput {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

  $rows = [System.Collections.Generic.List[object]]::new()
  foreach ($raw in ($Text -split "`r?`n")) {
    $line = $raw.Trim()
    $line = $line.TrimStart([char[]]@([char]0xFEFF))
    $line = $line.Trim()
    if ($line -eq "") { continue }
    $parts = @($line -split "\s+")
    $proto = $parts[0].ToUpperInvariant()
    if ($proto -ne "TCP" -and $proto -ne "UDP") { continue }
    if ($parts.Count -lt 4) { throw "socket table row is truncated: $line" }

    $local = ConvertFrom-NetstatEndpoint -Token $parts[1]
    $foreign = ConvertFrom-NetstatEndpoint -Token $parts[2]
    if ($proto -eq "TCP") {
      if ($parts.Count -lt 5) { throw "TCP row is missing its state or pid: $line" }
      $state = $parts[3]
    } else {
      $state = ""
    }
    $pidText = $parts[$parts.Count - 1]
    if ($pidText -notmatch "^\d{1,10}$") { throw "socket table row has no numeric pid: $line" }
    $rows.Add([pscustomobject]@{
      Proto          = $proto
      LocalAddress   = $local.Address
      LocalPort      = $local.Port
      ForeignAddress = $foreign.Address
      ForeignPort    = $foreign.Port
      State          = $state
      OwningProcess  = [int]$pidText
    })
  }
  return @($rows)
}

<#
  Runs netstat -ano and parses it. A non-zero exit, no output, or an unreadable
  row throws: the caller reports FAILED, never a clean sample.
#>
function Get-NetstatEvidence {
  param([string]$NetstatPath = "netstat.exe")

  $output = & $NetstatPath -ano 2>$null
  if ($LASTEXITCODE -ne 0) { throw "netstat -ano could not read the socket table (exit $LASTEXITCODE)" }
  if ($null -eq $output) { throw "netstat -ano printed nothing" }
  return ConvertFrom-NetstatOutput -Text (@($output) -join "`n")
}

<#
  The rows the IP Helper API reports. On build 26300 a listening socket is
  state 0 (MIB_TCP_STATE_LISTEN is 2 on healthy builds) with a wildcard peer;
  a connected client has only its established row, so unlike the cmdlet this
  does not invent a phantom row for a polling agent.
#>
function Get-ExtendedSocketEvidence {
  $rows = [System.Collections.Generic.List[object]]::new()
  foreach ($r in [Jarvis.NoListener.SocketTable]::Tcp()) {
    $state = ""
    if ($r.State -eq 2 -or ($r.State -eq 0 -and $r.ForeignPort -eq 0)) { $state = "LISTENING" }
    $rows.Add([pscustomobject]@{
      Proto          = "TCP"
      LocalAddress   = $r.LocalAddress
      LocalPort      = $r.LocalPort
      ForeignAddress = $r.ForeignAddress
      ForeignPort    = $r.ForeignPort
      State          = $state
      OwningProcess  = $r.OwningProcess
    })
  }
  foreach ($r in [Jarvis.NoListener.SocketTable]::Udp()) {
    $rows.Add([pscustomobject]@{
      Proto          = "UDP"
      LocalAddress   = $r.LocalAddress
      LocalPort      = $r.LocalPort
      ForeignAddress = "*"
      ForeignPort    = 0
      State          = ""
      OwningProcess  = $r.OwningProcess
    })
  }
  return @($rows)
}

<#
  The positive-only cross-check. Get-NetTCPConnection is asked only for rows it
  itself calls Listen: its unfiltered rows include phantom peers on build 26300
  and must never be used to decide. Get-NetUDPEndpoint was accurate there.
  Returns $null when neither cmdlet exists; throws if one that exists fails.
#>
function Get-CmdletSocketEvidence {
  $rows = [System.Collections.Generic.List[object]]::new()
  $available = $false
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $available = $true
    foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
      $rows.Add([pscustomobject]@{
        Proto          = "TCP"
        LocalAddress   = [string]$c.LocalAddress
        LocalPort      = [int]$c.LocalPort
        ForeignAddress = "*"
        ForeignPort    = 0
        State          = "LISTENING"
        OwningProcess  = [int]$c.OwningProcess
      })
    }
  }
  if (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue) {
    $available = $true
    foreach ($u in @(Get-NetUDPEndpoint -ErrorAction Stop)) {
      $rows.Add([pscustomobject]@{
        Proto          = "UDP"
        LocalAddress   = [string]$u.LocalAddress
        LocalPort      = [int]$u.LocalPort
        ForeignAddress = "*"
        ForeignPort    = 0
        State          = ""
        OwningProcess  = [int]$u.OwningProcess
      })
    }
  }
  if (-not $available) { return $null }
  return @($rows)
}

<# A TCP row is a listener when it is LISTENING or its peer is the wildcard zero port; a UDP row always is. #>
function Test-NetstatRowIsListener {
  param([Parameter(Mandatory)]$Row)

  if ($Row.Proto -eq "UDP") { return $true }
  if ($null -ne $Row.State -and ([string]$Row.State).ToUpperInvariant() -eq "LISTENING") { return $true }
  return ($Row.ForeignPort -eq 0 -and $Row.ForeignAddress -in @("0.0.0.0", "::", "*"))
}

<#
  Opens the positive control: one loopback TCP listener and one loopback UDP
  socket, both owned by this process on a free port. Loopback only, so the
  control itself is never an inbound port to the network.
#>
function New-NoListenerControl {
  $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $tcp.Start()
  try {
    $tcpPort = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $udp = [System.Net.Sockets.UdpClient]::new([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, 0))
    try {
      $udpPort = ([System.Net.IPEndPoint]$udp.Client.LocalEndPoint).Port
      return [pscustomobject]@{
        ProcessId = $PID
        Tcp       = $tcp
        TcpPort   = $tcpPort
        Udp       = $udp
        UdpPort   = $udpPort
      }
    } catch {
      $udp.Dispose()
      throw
    }
  } catch {
    $tcp.Stop()
    throw
  }
}

function Close-NoListenerControl {
  param($Control)
  if ($null -eq $Control) { return }
  try { $Control.Tcp.Stop() } catch { }
  try { $Control.Udp.Dispose() } catch { }
}

<#
  Judges one merged table. Status is:
    CONTROL_UNOBSERVED - the control's own loopback sockets are not in the
                         table, so no claim can be made from this sample;
    LISTENER           - the process owns a TCP listener or a UDP endpoint;
    CLEAN              - the control was seen and the process owns neither.

  PID 0 rows are the kernel's stale placeholders (0 is never a user process).
  They are never attributed to the process under test.
#>
function Get-NoListenerVerdict {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ControlProcessId,
    [Parameter(Mandatory)][int]$ControlTcpPort,
    [Parameter(Mandatory)][int]$ControlUdpPort
  )

  $controlTcp = @($Rows | Where-Object {
      $_.Proto -eq "TCP" -and $_.OwningProcess -eq $ControlProcessId -and
      $_.LocalPort -eq $ControlTcpPort -and (Test-NetstatRowIsListener $_)
    })
  $controlUdp = @($Rows | Where-Object {
      $_.Proto -eq "UDP" -and $_.OwningProcess -eq $ControlProcessId -and $_.LocalPort -eq $ControlUdpPort
    })
  if ($controlTcp.Count -eq 0 -or $controlUdp.Count -eq 0) {
    return [pscustomobject]@{
      Status    = "CONTROL_UNOBSERVED"
      Listening = @()
      Endpoints = @()
      Outbound  = @()
      Detail    = "the loopback control opened by this check (pid $ControlProcessId, tcp $ControlTcpPort, udp $ControlUdpPort) is not in the socket table"
    }
  }

  $owned = @($Rows | Where-Object { $_.OwningProcess -eq $ProcessId -and $_.OwningProcess -ne 0 })
  $listening = @($owned | Where-Object { $_.Proto -eq "TCP" -and (Test-NetstatRowIsListener $_) })
  $endpoints = @($owned | Where-Object { $_.Proto -eq "UDP" })
  $outbound = @($owned | Where-Object { $_.Proto -eq "TCP" -and -not (Test-NetstatRowIsListener $_) -and $_.ForeignPort -gt 0 })

  $status = "CLEAN"
  if ($listening.Count -gt 0 -or $endpoints.Count -gt 0) { $status = "LISTENER" }

  return [pscustomobject]@{
    Status    = $status
    Listening = $listening
    Endpoints = $endpoints
    Outbound  = $outbound
    Detail    = ""
  }
}

<#
  One observation: netstat, the extended table, and (unless skipped) the
  positive-only cmdlets, merged and judged. A finding from either source is
  kept. An extended-table failure is recorded but does not by itself decide:
  the control gate decides whether a sample can be claimed at all.

  Returns the verdict plus `Sources` (readers that contributed) and `Warnings`.
#>
function Get-NoListenerObservation {
  param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$ControlProcessId,
    [Parameter(Mandatory)][int]$ControlTcpPort,
    [Parameter(Mandatory)][int]$ControlUdpPort,
    [string]$NetstatPath = "netstat.exe",
    [switch]$SkipSecondary
  )

  $rows = @(Get-NetstatEvidence -NetstatPath $NetstatPath)
  $sources = [System.Collections.Generic.List[string]]::new()
  $sources.Add("netstat")
  $warnings = [System.Collections.Generic.List[string]]::new()

  try {
    $rows = @($rows) + @(Get-ExtendedSocketEvidence)
    $sources.Add("iphlpapi")
  } catch {
    $warnings.Add("the IP Helper table could not be read: $($_.Exception.Message)")
  }

  if (-not $SkipSecondary) {
    $crossCheck = $null
    try { $crossCheck = Get-CmdletSocketEvidence } catch { $crossCheck = $null }
    if ($null -ne $crossCheck) {
      $rows = @($rows) + @($crossCheck)
      $sources.Add("get-net*")
    }
  }

  $rows = @($rows | Sort-Object Proto, LocalAddress, LocalPort, ForeignAddress, ForeignPort, OwningProcess -Unique)

  $verdict = Get-NoListenerVerdict -Rows $rows -ProcessId $ProcessId -ControlProcessId $ControlProcessId `
    -ControlTcpPort $ControlTcpPort -ControlUdpPort $ControlUdpPort

  $detail = $verdict.Detail
  if ($verdict.Status -eq "CONTROL_UNOBSERVED") {
    $detail = "$detail. Sources read: $($sources -join ', ')."
  }
  if ($warnings.Count -gt 0) { $detail = "$detail $($warnings -join ' ')" }

  return $verdict |
    Add-Member -NotePropertyName Sources -NotePropertyValue ($sources -join "+") -PassThru |
    Add-Member -NotePropertyName Detail -NotePropertyValue $detail.Trim() -Force -PassThru
}
