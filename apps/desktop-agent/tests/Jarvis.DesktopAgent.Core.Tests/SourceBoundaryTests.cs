// ---------------------------------------------------------------------------
// Phase 19.6 — what the agent's source may never contain.
//
// The agent is click, key, type and opening a fixed list of applications, over
// outbound HTTPS, nothing else (D3, D4; 19.7 added the launch by the owner's
// decision). These checks read every C# file under apps/desktop-agent/src and
// fail on any way to listen for connections, start a shell, read the screen,
// use the clipboard or the registry, weaken TLS, or read files other than the
// agent's own two. One file may start a process, and only without a shell. A
// new capability is a deliberate change to this list, reviewed — never a quiet
// addition.
// ---------------------------------------------------------------------------

using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public partial class SourceBoundaryTests
{
    private static string SourceRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "src"));

    /// <summary>Every C# file's code lines — comments removed, so prose may name what code may not do.</summary>
    private static IEnumerable<(string File, int Line, string Code)> CodeLines()
    {
        foreach (var file in Directory.EnumerateFiles(SourceRoot(), "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(SourceRoot(), file).Replace('\\', '/');
            if (relative.Contains("/obj/", StringComparison.Ordinal) || relative.Contains("/bin/", StringComparison.Ordinal)) continue;
            var number = 0;
            foreach (var raw in File.ReadLines(file))
            {
                number++;
                var line = raw.Trim();
                if (line.StartsWith("//", StringComparison.Ordinal)) continue;
                var comment = line.IndexOf(" //", StringComparison.Ordinal);
                yield return (relative, number, comment >= 0 ? line[..comment] : line);
            }
        }
    }

    public static TheoryData<string, string> Forbidden => new()
    {
        { "a listener", @"\b(HttpListener|TcpListener|UdpClient|Socket\s*\(|Kestrel|WebApplication|WebHost|\.Listen\s*\(|MapGet|UseUrls)\b" },
        { "a process or a shell", @"\b(Process\.Start|ProcessStartInfo|ShellExecute|CreateProcess|WinExec|powershell|cmd\.exe|wscript|cscript|rundll32|mshta)\b" },
        { "elevation", @"\b(runas|Verb\s*=|requireAdministrator|highestAvailable)\b" },
        { "reading the screen", @"\b(BitBlt|CopyFromScreen|PrintWindow|GetDC|GetWindowDC|Graphics\.FromHwnd|GraphicsCapture|Direct3D11CaptureFramePool|DesktopDuplication|IDXGIOutputDuplication|GetPixel|AutomationElement|UIAutomation)\b" },
        // The consent text tells the person JARVIS cannot use the clipboard; code may not name it.
        { "the clipboard", @"\b(Clipboard\s*\.|OpenClipboard|GetClipboardData|SetClipboardData|DataPackage)" },
        { "the registry", @"\b(Microsoft\.Win32\.Registry|RegistryKey|Registry\.|RegOpenKey|RegSetValue|RegCreateKey)\b" },
        { "weakened TLS", @"\b(ServerCertificateCustomValidationCallback|DangerousAcceptAnyServerCertificateValidator|RemoteCertificateValidationCallback|CheckCertificateRevocationList\s*=\s*false|SslProtocols|SecurityProtocol)\b" },
        { "plain HTTP", @"""http://" },
        { "dynamic code", @"\b(Assembly\.Load|LoadLibrary|Activator\.CreateInstance|CSharpScript|DynamicMethod|Reflection\.Emit)\b" },
        { "an exportable or software-made device key", @"\b(AllowExport|AllowPlaintextExport|ExportPkcs8PrivateKey|ExportECPrivateKey|ExportParameters\s*\(\s*true)\b" },
    };

    [Theory]
    [MemberData(nameof(Forbidden))]
    public void The_agent_source_has_no(string what, string pattern)
    {
        var regex = new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var found = CodeLines().Where(l => regex.IsMatch(l.Code) && !(what == "a process or a shell" && l.File == Launcher))
            .Select(l => $"{l.File}:{l.Line}: {l.Code}").ToList();
        Assert.True(found.Count == 0, $"{what}:\n{string.Join('\n', found)}");
    }

    private const string Launcher = "Jarvis.DesktopAgent/Windows/AppLauncher.cs";

    [Fact]
    public void One_file_starts_a_process_and_never_through_a_shell()
    {
        var starts = CodeLines().Where(l => l.Code.Contains("ProcessStartInfo", StringComparison.Ordinal) || l.Code.Contains("Process.Start", StringComparison.Ordinal))
            .Select(l => l.File).Distinct().ToList();
        Assert.Equal([Launcher], starts);

        var launcher = CodeLines().Where(l => l.File == Launcher).Select(l => l.Code).ToList();
        Assert.Contains(launcher, l => l.Contains("UseShellExecute = false", StringComparison.Ordinal));
        Assert.DoesNotContain(launcher, l => l.Contains("UseShellExecute = true", StringComparison.Ordinal));
        var forbidden = new Regex(@"\b(Arguments|ArgumentList|cmd|powershell|pwsh|wscript|cscript|Verb|Environment\.GetEnvironmentVariable|ExpandEnvironmentVariables|Registry)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var found = launcher.Where(l => forbidden.IsMatch(l)).ToList();
        Assert.True(found.Count == 0, string.Join('\n', found));
    }

    [Fact]
    public void A_launch_never_types_and_the_runner_starts_no_process_itself()
    {
        var core = CodeLines().Where(l => l.File == "Jarvis.DesktopAgent.Core/Execution.cs").Select(l => l.Code).ToList();
        Assert.DoesNotContain(core, l => l.Contains("Process", StringComparison.Ordinal) && !l.Contains("ProcessId", StringComparison.Ordinal) && !l.Contains("ProcessName", StringComparison.Ordinal));
        var launcher = CodeLines().Where(l => l.File == Launcher).Select(l => l.Code).ToList();
        Assert.DoesNotContain(launcher, l => l.Contains("injector", StringComparison.OrdinalIgnoreCase) || l.Contains("SendInput", StringComparison.Ordinal));
    }

    [Fact]
    public void Typing_and_opening_applications_are_off_until_the_person_ticks_them()
    {
        var form = CodeLines().Where(l => l.File == "Jarvis.DesktopAgent/UI/ConsentForm.cs").Select(l => l.Code).ToList();
        Assert.Contains(form, l => l.Contains("\"Open approved applications\", Checked = false", StringComparison.Ordinal));
        Assert.Contains(form, l => l.Contains("\"Type approved text (Windows Hello every time)\", Checked = false", StringComparison.Ordinal));
    }

    [Fact]
    public void The_tray_gives_the_person_their_moment_before_typing()
    {
        var tray = CodeLines().Where(l => l.File == "Jarvis.DesktopAgent/UI/TrayApp.cs").Select(l => l.Code).ToList();
        Assert.Contains(tray, l => l.Contains("new WindowsAppLauncher(), TimeSpan.FromMilliseconds(ProtocolConstants.TypeFocusWaitMs))", StringComparison.Ordinal));
    }

    [Fact]
    public void Only_the_agents_own_stores_touch_files()
    {
        var regex = FileAccess();
        string[] allowed = ["Jarvis.DesktopAgent/Windows/FileStores.cs", "Jarvis.DesktopAgent/Windows/Platform.cs", Launcher];
        var found = CodeLines().Where(l => regex.IsMatch(l.Code) && !allowed.Contains(l.File)).Select(l => $"{l.File}:{l.Line}: {l.Code}").ToList();
        Assert.True(found.Count == 0, string.Join('\n', found));
    }

    [Fact]
    public void Sends_input_from_one_file_and_calls_windows_from_one_file()
    {
        var sendInput = CodeLines().Where(l => l.Code.Contains("SendInput(", StringComparison.Ordinal)).Select(l => l.File).Distinct().ToList();
        Assert.Equal(["Jarvis.DesktopAgent/Windows/NativeMethods.cs", "Jarvis.DesktopAgent/Windows/SendInputInjector.cs"], sendInput.Order(StringComparer.Ordinal));
        var imports = CodeLines().Where(l => l.Code.Contains("Import(\"", StringComparison.Ordinal)).Select(l => l.File).Distinct().ToList();
        Assert.Equal(["Jarvis.DesktopAgent/Windows/NativeMethods.cs"], imports);
    }

    [Fact]
    public void The_core_library_touches_no_windows_api_and_no_file()
    {
        var core = CodeLines().Where(l => l.File.StartsWith("Jarvis.DesktopAgent.Core/", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(core);
        Assert.DoesNotContain(core, l => l.Code.Contains("DllImport", StringComparison.Ordinal) || l.Code.Contains("LibraryImport", StringComparison.Ordinal));
        Assert.DoesNotContain(core, l => FileAccess().IsMatch(l.Code));
    }

    [Fact]
    public void A_pairing_is_saved_in_one_place_and_never_by_a_window()
    {
        // The person confirms with the window open: saving once it closes loses the pairing to a crash or a quit.
        var saves = CodeLines().Where(l => l.Code.Contains("store.Save(", StringComparison.Ordinal)).Select(l => l.File).Distinct().ToList();
        Assert.Equal(["Jarvis.DesktopAgent.Core/PairingState.cs"], saves);
    }

    [Fact]
    public void No_log_line_names_a_device_by_its_full_id()
    {
        // AgentLog would drop the field; this catches the call that loses its line.
        var found = CodeLines().Where(l => l.Code.Contains("(\"deviceId\",", StringComparison.Ordinal)).Select(l => $"{l.File}:{l.Line}: {l.Code}").ToList();
        Assert.True(found.Count == 0, string.Join('\n', found));
    }

    [GeneratedRegex(@"\b(File|Directory|FileStream|StreamReader|StreamWriter|FileInfo|DirectoryInfo)\s*[\.(]")]
    private static partial Regex FileAccess();
}
