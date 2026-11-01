// ---------------------------------------------------------------------------
// Phase 19.7 — where an application comes from, and how it is started.
//
// The process starter is injected throughout: these tests open none of the
// approved applications. The one test that starts anything real runs
// hostname.exe, which has no window and exits at once, to prove the no-shell
// starter works on Windows.
// ---------------------------------------------------------------------------

using System.ComponentModel;
using Jarvis.DesktopAgent.Core;
using Jarvis.DesktopAgent.Windows;
using Xunit;

namespace Jarvis.DesktopAgent.Windows.Tests;

public sealed class AppLauncherTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("jarvis-apps-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private sealed class RecordingStarter : IProcessStarter
    {
        public List<(string Path, string Folder)> Started { get; } = [];

        public Exception? Throws { get; set; }

        public void Start(string path, string workingDirectory)
        {
            if (Throws is not null) throw Throws;
            Started.Add((path, workingDirectory));
        }
    }

    private readonly RecordingStarter starter = new();

    private static string Folder(Environment.SpecialFolder folder) => folder switch
    {
        Environment.SpecialFolder.System => @"C:\Windows\System32",
        Environment.SpecialFolder.Windows => @"C:\Windows",
        Environment.SpecialFolder.ProgramFiles => @"C:\Program Files",
        Environment.SpecialFolder.ProgramFilesX86 => @"C:\Program Files (x86)",
        _ => throw new ArgumentOutOfRangeException(nameof(folder)),
    };

    private WindowsAppLauncher With(params string[] present) =>
        new(starter, Folder, path => present.Contains(path, StringComparer.Ordinal));

    [Fact]
    public void Knows_exactly_the_protocols_applications()
    {
        Assert.Equal(ProtocolConstants.AppIds.Order(StringComparer.Ordinal), AppCatalog.Locations.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Looks_only_in_folders_an_administrator_controls_for_a_fixed_exe()
    {
        Environment.SpecialFolder[] protectedFolders =
        [
            Environment.SpecialFolder.System, Environment.SpecialFolder.Windows,
            Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86,
        ];
        foreach (var location in AppCatalog.Locations.Values.SelectMany(l => l))
        {
            Assert.Contains(location.Root, protectedFolders);
            Assert.False(Path.IsPathRooted(location.RelativePath), location.RelativePath);
            Assert.DoesNotContain("..", location.RelativePath, StringComparison.Ordinal);
            Assert.DoesNotContain("%", location.RelativePath, StringComparison.Ordinal);
            Assert.EndsWith(".exe", location.RelativePath, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("notepad", @"C:\Windows\System32\notepad.exe", @"C:\Windows\System32")]
    [InlineData("calculator", @"C:\Windows\System32\calc.exe", @"C:\Windows\System32")]
    [InlineData("edge", @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", @"C:\Program Files (x86)\Microsoft\Edge\Application")]
    [InlineData("chrome", @"C:\Program Files\Google\Chrome\Application\chrome.exe", @"C:\Program Files\Google\Chrome\Application")]
    [InlineData("explorer", @"C:\Windows\explorer.exe", @"C:\Windows")]
    public void Starts_each_application_from_its_fixed_place_in_its_own_folder(string app, string path, string folder)
    {
        Assert.Equal(LaunchResult.Started, With(path).Launch(app));
        Assert.Equal((path, folder), Assert.Single(starter.Started));
    }

    [Fact]
    public void Falls_back_to_the_next_fixed_place()
    {
        Assert.Equal(LaunchResult.Started, With(@"C:\Windows\notepad.exe").Launch("notepad"));
        Assert.Equal(@"C:\Windows\notepad.exe", Assert.Single(starter.Started).Path);
    }

    [Fact]
    public void Prefers_the_first_fixed_place_when_both_exist()
    {
        With(@"C:\Windows\System32\notepad.exe", @"C:\Windows\notepad.exe").Launch("notepad");
        Assert.Equal(@"C:\Windows\System32\notepad.exe", Assert.Single(starter.Started).Path);
    }

    [Theory]
    [InlineData("cmd")]
    [InlineData("cmd.exe")]
    [InlineData("powershell")]
    [InlineData("regedit")]
    [InlineData("Notepad")]
    [InlineData("notepad.exe")]
    [InlineData(@"C:\Windows\System32\cmd.exe")]
    [InlineData(@"..\..\Windows\System32\cmd.exe")]
    [InlineData(@"\\server\share\run.exe")]
    [InlineData("notepad && calc")]
    [InlineData("")]
    public void Starts_nothing_for_anything_that_is_not_an_id_on_the_list(string app)
    {
        var everything = new WindowsAppLauncher(starter, Folder, _ => true);
        Assert.Equal(LaunchResult.Failed, everything.Launch(app));
        Assert.Empty(starter.Started);
    }

    [Fact]
    public void Says_not_installed_and_starts_nothing_when_no_fixed_place_has_it()
    {
        Assert.Equal(LaunchResult.NotInstalled, With().Launch("chrome"));
        Assert.Empty(starter.Started);
    }

    [Fact]
    public void Skips_a_known_folder_windows_cannot_name()
    {
        var launcher = new WindowsAppLauncher(starter, _ => "", _ => true);
        Assert.Equal(LaunchResult.NotInstalled, launcher.Launch("notepad"));
        Assert.Empty(starter.Started);
    }

    [Fact]
    public void Reports_a_process_windows_would_not_create_as_failed()
    {
        starter.Throws = new Win32Exception(740);
        Assert.Equal(LaunchResult.Failed, With(@"C:\Windows\System32\calc.exe").Launch("calculator"));
    }

    [Fact]
    public void Lets_an_unexpected_failure_escape_so_it_is_reported_uncertain_and_not_as_a_refusal()
    {
        starter.Throws = new InvalidOperationException("no step expected this");
        Assert.Throws<InvalidOperationException>(() => With(@"C:\Windows\System32\calc.exe").Launch("calculator"));
    }

    [Fact]
    public void A_plain_file_is_a_file_and_not_a_folder_or_nothing()
    {
        var file = Path.Combine(directory, "app.exe");
        File.WriteAllText(file, "");
        Assert.True(WindowsAppLauncher.IsPlainFile(file));
        Assert.False(WindowsAppLauncher.IsPlainFile(directory));
        Assert.False(WindowsAppLauncher.IsPlainFile(Path.Combine(directory, "missing.exe")));
    }

    [Theory]
    [InlineData(FileAttributes.ReparsePoint)]
    [InlineData(FileAttributes.Archive | FileAttributes.ReparsePoint)]
    public void A_reparse_point_is_a_link_whatever_else_is_set(FileAttributes attributes)
    {
        Assert.False(WindowsAppLauncher.IsNotALink(attributes));
    }

    [Theory]
    [InlineData(FileAttributes.Normal)]
    [InlineData(FileAttributes.Archive)]
    [InlineData(FileAttributes.Archive | FileAttributes.ReadOnly)]
    public void A_plain_file_is_not_a_link(FileAttributes attributes)
    {
        Assert.True(WindowsAppLauncher.IsNotALink(attributes));
    }

    [Fact]
    public void A_real_link_is_not_a_plain_file()
    {
        // Windows' app execution aliases are real reparse points, and reading one
        // needs no privilege. A computer with none has nothing to prove here;
        // the decision itself is pinned above either way.
        var aliases = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps");
        var alias = Directory.Exists(aliases) ? Directory.EnumerateFiles(aliases, "*.exe").FirstOrDefault() : null;
        if (alias is not null) Assert.False(WindowsAppLauncher.IsPlainFile(alias));
    }

    [Fact]
    public void The_no_shell_starter_creates_a_real_process()
    {
        var hostname = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "HOSTNAME.EXE");
        new NoShellProcessStarter().Start(hostname, Path.GetDirectoryName(hostname)!);
    }

    [Fact]
    public void The_no_shell_starter_fails_as_windows_fails_for_a_file_that_is_not_there()
    {
        Assert.Throws<Win32Exception>(() => new NoShellProcessStarter().Start(Path.Combine(directory, "missing.exe"), directory));
    }

    [Fact]
    public void The_real_launcher_finds_notepad_where_windows_keeps_it()
    {
        // Resolution only: the starter is the recording one, so nothing opens.
        var launcher = new WindowsAppLauncher(starter, Environment.GetFolderPath, WindowsAppLauncher.IsPlainFile);
        Assert.Equal(LaunchResult.Started, launcher.Launch("notepad"));
        var (path, _) = Assert.Single(starter.Started);
        Assert.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows), path, StringComparison.OrdinalIgnoreCase);
    }
}
