// ---------------------------------------------------------------------------
// Phase 19.7 — opening one application from the fixed list.
//
// The only file in the agent that starts a process, by the owner's decision.
// A command carries an id and nothing else, so the path comes from this table:
// a place the agent chose, under folders only an administrator can change,
// found through Windows' known-folder API and not an environment variable, a
// search path or the registry. A per-user install is not looked for: anything
// running as the person could replace it.
//
// The process gets no arguments, starts in its own folder, and starts with no
// shell. Started means Windows created it; whether a window appeared cannot be
// seen from here, and that is what is reported. It never types: typing is a
// command of its own.
// ---------------------------------------------------------------------------

using System.ComponentModel;
using System.Diagnostics;
using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.Windows;

/// <summary>One place an application may be: a known folder and a fixed path under it.</summary>
internal sealed record AppLocation(Environment.SpecialFolder Root, string RelativePath);

internal static class AppCatalog
{
    private const string EdgePath = @"Microsoft\Edge\Application\msedge.exe";
    private const string ChromePath = @"Google\Chrome\Application\chrome.exe";

    /// <summary>The same ids as the protocol's list; a test holds them equal.</summary>
    public static readonly IReadOnlyDictionary<string, AppLocation[]> Locations = new Dictionary<string, AppLocation[]>(StringComparer.Ordinal)
    {
        ["notepad"] = [new(Environment.SpecialFolder.System, "notepad.exe"), new(Environment.SpecialFolder.Windows, "notepad.exe")],
        ["calculator"] = [new(Environment.SpecialFolder.System, "calc.exe")],
        ["edge"] = [new(Environment.SpecialFolder.ProgramFilesX86, EdgePath), new(Environment.SpecialFolder.ProgramFiles, EdgePath)],
        ["chrome"] = [new(Environment.SpecialFolder.ProgramFiles, ChromePath), new(Environment.SpecialFolder.ProgramFilesX86, ChromePath)],
        ["explorer"] = [new(Environment.SpecialFolder.Windows, "explorer.exe")],
    };
}

/// <summary>Creates a process. A failure to create one is a <see cref="Win32Exception"/>.</summary>
internal interface IProcessStarter
{
    void Start(string path, string workingDirectory);
}

internal sealed class NoShellProcessStarter : IProcessStarter
{
    public void Start(string path, string workingDirectory)
    {
        using var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false, WorkingDirectory = workingDirectory });
    }
}

internal sealed class WindowsAppLauncher(IProcessStarter starter, Func<Environment.SpecialFolder, string> folderOf, Func<string, bool> isPlainFile) : IAppLauncher
{
    public WindowsAppLauncher()
        : this(new NoShellProcessStarter(), Environment.GetFolderPath, IsPlainFile)
    {
    }

    public LaunchResult Launch(string app)
    {
        if (!ProtocolConstants.AppIds.Contains(app) || !AppCatalog.Locations.TryGetValue(app, out var locations)) return LaunchResult.Failed;
        var path = Resolve(locations);
        if (path is null) return LaunchResult.NotInstalled;
        try
        {
            starter.Start(path, Path.GetDirectoryName(path)!);
            return LaunchResult.Started;
        }
        catch (Win32Exception)
        {
            // CreateProcess itself refused, elevation required included: nothing ran.
            return LaunchResult.Failed;
        }
    }

    private string? Resolve(AppLocation[] locations)
    {
        foreach (var location in locations)
        {
            var folder = folderOf(location.Root);
            if (folder.Length == 0) continue;
            var path = Path.Combine(folder, location.RelativePath);
            if (isPlainFile(path)) return path;
        }
        return null;
    }

    /// <summary>A file, and not a link to somewhere else.</summary>
    internal static bool IsPlainFile(string path)
    {
        try
        {
            return File.Exists(path) && IsNotALink(File.GetAttributes(path));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal static bool IsNotALink(FileAttributes attributes) => (attributes & FileAttributes.ReparsePoint) == 0;
}
