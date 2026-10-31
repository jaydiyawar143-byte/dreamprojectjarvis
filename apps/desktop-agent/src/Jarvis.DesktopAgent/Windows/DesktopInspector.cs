// ---------------------------------------------------------------------------
// Phase 19.6 — which window input would reach, and whether it may (M4).
//
// The top-level window in front, or under a point; the process that owns it;
// that process's integrity level against the agent's own. A window is
// "elevated" when its process runs above the agent — or when its level cannot
// be read, which is treated the same: refused. "Protected" is the agent's own
// windows and the system's credential and consent prompts, which no command
// may ever click or type into — that is how injected input can never answer a
// Windows Hello prompt, a UAC prompt, or the agent's consent screen.
// It reads names and handles; it never reads what a window shows.
// ---------------------------------------------------------------------------

using System.Runtime.InteropServices;
using Jarvis.DesktopAgent.Core;
using static Jarvis.DesktopAgent.Windows.NativeMethods;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class DesktopInspector : IDesktopInspector
{
    /// <summary>System prompts that collect credentials or consent. Never a target.</summary>
    private static readonly HashSet<string> ProtectedPrograms = new(StringComparer.OrdinalIgnoreCase)
    {
        "CredentialUIBroker.exe",
        "consent.exe",
        "LogonUI.exe",
        "LockApp.exe",
        "UserAccountBroker.exe",
    };

    private readonly uint ownProcessId = (uint)Environment.ProcessId;
    private readonly int ownIntegrity;

    public DesktopInspector()
    {
        ownIntegrity = IntegrityOf(ownProcessId) ?? int.MaxValue;
    }

    public ScreenArea VirtualScreen => new(
        GetSystemMetrics(SM_XVIRTUALSCREEN),
        GetSystemMetrics(SM_YVIRTUALSCREEN),
        GetSystemMetrics(SM_CXVIRTUALSCREEN),
        GetSystemMetrics(SM_CYVIRTUALSCREEN));

    public WindowTarget? Foreground() => Describe(GetForegroundWindow());

    public WindowTarget? At(int screenX, int screenY) => Describe(WindowFromPoint(new POINT { X = screenX, Y = screenY }));

    private WindowTarget? Describe(nint window)
    {
        if (window == 0) return null;
        var root = GetAncestor(window, GA_ROOT);
        if (root == 0) root = window;
        GetWindowThreadProcessId(root, out var processId);
        if (processId == 0) return null;

        var program = ProgramName(processId);
        var integrity = IntegrityOf(processId);
        // Unknown integrity is treated as higher: refused, never assumed safe.
        var elevated = integrity is null || integrity > ownIntegrity;
        var isProtected = processId == ownProcessId || program is null || ProtectedPrograms.Contains(program);
        return new WindowTarget(root, (int)processId, program ?? "an unknown program", Title(root), elevated, isProtected);
    }

    private static string Title(nint window)
    {
        var buffer = new char[256];
        var length = GetWindowText(window, buffer, buffer.Length);
        return length > 0 ? new string(buffer, 0, length) : "";
    }

    private static string? ProgramName(uint processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == 0) return null;
        try
        {
            var buffer = new char[1024];
            var size = (uint)buffer.Length;
            return QueryFullProcessImageName(process, 0, buffer, ref size) ? Path.GetFileName(new string(buffer, 0, (int)size)) : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /// <summary>The process's mandatory integrity level RID (0x2000 medium, 0x3000 high, 0x4000 system), or null.</summary>
    internal static int? IntegrityOf(uint processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == 0) return null;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return null;
            try
            {
                GetTokenInformation(token, TokenIntegrityLevel, 0, 0, out var needed);
                if (needed == 0 || needed > 4096) return null;
                var buffer = Marshal.AllocHGlobal((int)needed);
                try
                {
                    if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, needed, out _)) return null;
                    // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label } — the SID pointer comes first.
                    var sid = Marshal.ReadIntPtr(buffer);
                    var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    if (count == 0) return null;
                    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }
}
