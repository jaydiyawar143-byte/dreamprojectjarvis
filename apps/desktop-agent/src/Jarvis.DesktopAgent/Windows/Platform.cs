// ---------------------------------------------------------------------------
// Phase 19.6 — where the agent agrees to run (U6a), and where it keeps things.
//
// Windows 11 (build 22000 or later), a workstation edition, on x64 — read
// from the kernel (RtlGetVersion), which compatibility shims cannot change.
// The server enforces its own minimum build and agent version on top; this
// check only stops the agent from starting somewhere it was never meant for.
// Files live under the person's local application data — inside an MSIX that
// is the package's own private folder.
// ---------------------------------------------------------------------------

using System.Runtime.InteropServices;
using Jarvis.DesktopAgent.Core;
using static Jarvis.DesktopAgent.Windows.NativeMethods;

namespace Jarvis.DesktopAgent.Windows;

internal static class Platform
{
    public static int WindowsBuild
    {
        get
        {
            var info = new OSVERSIONINFOEXW { dwOSVersionInfoSize = Marshal.SizeOf<OSVERSIONINFOEXW>(), szCSDVersion = "" };
            return RtlGetVersion(ref info) == 0 ? info.dwBuildNumber : 0;
        }
    }

    /// <summary>Null when the agent may run here; otherwise a sentence for the person.</summary>
    public static string? Unsupported()
    {
        if (RuntimeInformation.OSArchitecture != Architecture.X64 || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            return "The JARVIS desktop agent runs only on 64-bit (x64) Windows 11.";
        var info = new OSVERSIONINFOEXW { dwOSVersionInfoSize = Marshal.SizeOf<OSVERSIONINFOEXW>(), szCSDVersion = "" };
        if (RtlGetVersion(ref info) != 0) return "The Windows version could not be read.";
        if (info.dwMajorVersion != 10 || info.dwBuildNumber < ProtocolConstants.Windows11FirstBuild)
            return "The JARVIS desktop agent runs only on Windows 11.";
        if (info.wProductType != VER_NT_WORKSTATION)
            return "The JARVIS desktop agent runs only on Windows 11, not Windows Server.";
        return null;
    }

    public static string DataDirectory
    {
        get
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JARVIS", "DesktopAgent");
            Directory.CreateDirectory(directory);
            return directory;
        }
    }
}
