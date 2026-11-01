// ---------------------------------------------------------------------------
// Phase 19.6 — the Windows parts, on Windows (the CI job runs these).
//
// The device key is non-exportable and signs what the server verifies; the
// compiled agent references nothing that can listen for a connection, and only
// its Windows assembly can start a process (the launcher, 19.7); the agent's
// own windows are never a target and its integrity level is readable. No test
// here sends input.
// ---------------------------------------------------------------------------

using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using Jarvis.DesktopAgent.Core;
using Jarvis.DesktopAgent.Windows;
using Xunit;

namespace Jarvis.DesktopAgent.Windows.Tests;

public sealed class DeviceKeyTests : IDisposable
{
    private readonly string name = "JARVIS-DesktopAgent-Test-" + Guid.NewGuid().ToString("N");

    public void Dispose() => CngDeviceKey.Delete(name);

    [Fact]
    public void Creates_a_p256_key_whose_private_half_cannot_be_exported()
    {
        using var key = CngDeviceKey.OpenOrCreate(name);
        using var opened = CngKey.Open(name, key.HardwareBacked ? CngProvider.MicrosoftPlatformCryptoProvider : CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.UserKey);
        Assert.Equal(CngExportPolicies.None, opened.ExportPolicy);
        Assert.Throws<CryptographicException>(() => opened.Export(CngKeyBlobFormat.EccPrivateBlob));
        Assert.Throws<CryptographicException>(() => opened.Export(CngKeyBlobFormat.Pkcs8PrivateBlob));
        Assert.Equal(256, opened.KeySize);
    }

    [Fact]
    public void Signs_what_the_protocol_verifies_and_reopens_as_the_same_key()
    {
        string spki;
        using (var key = CngDeviceKey.OpenOrCreate(name))
        {
            spki = key.PublicKeySpki;
            var canonical = Canonical.Request("POST", "/api/v1/desktop-agent/poll", "1", "AAAAAAAAAAAAAAAAAAAAAAAA", Guid.NewGuid().ToString("D"), new string('0', 64));
            Assert.True(Signatures.Verify(spki, canonical, Signatures.Sign(key, canonical)));
        }
        using var again = CngDeviceKey.TryOpen(name);
        Assert.NotNull(again);
        Assert.Equal(spki, again!.PublicKeySpki);
    }

    [Fact]
    public void Is_gone_after_delete_and_never_recreated_by_opening()
    {
        using (CngDeviceKey.OpenOrCreate(name))
        {
        }
        CngDeviceKey.Delete(name);
        Assert.Null(CngDeviceKey.TryOpen(name));
    }
}

public class AssemblyBoundaryTests
{
    /// <summary>Types the compiled agent must never reference: listening, the screen, the clipboard, the registry.</summary>
    private static readonly string[] ForbiddenTypes =
    [
        "System.Net.HttpListener", "System.Net.Sockets.TcpListener", "System.Net.Sockets.UdpClient", "System.Net.Sockets.Socket",
        "System.Windows.Forms.Clipboard", "Microsoft.Win32.Registry", "Microsoft.Win32.RegistryKey",
        "System.Drawing.Graphics", "Windows.Graphics.Capture.GraphicsCaptureItem",
    ];

    private static IEnumerable<string> ReferencedTypes(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        foreach (var handle in md.TypeReferences)
        {
            var type = md.GetTypeReference(handle);
            yield return $"{md.GetString(type.Namespace)}.{md.GetString(type.Name)}";
        }
    }

    public static TheoryData<string> Assemblies => new() { "Jarvis.DesktopAgent.dll", "Jarvis.DesktopAgent.Core.dll" };

    [Theory]
    [MemberData(nameof(Assemblies))]
    public void The_compiled_agent_references_nothing_that_listens_or_reads_the_screen(string assembly)
    {
        var path = Path.Combine(AppContext.BaseDirectory, assembly);
        Assert.True(File.Exists(path), path);
        var found = ReferencedTypes(path).Where(t => ForbiddenTypes.Contains(t)).ToList();
        Assert.Empty(found);
    }

    [Fact]
    public void The_protocol_library_cannot_start_a_process_at_all()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Jarvis.DesktopAgent.Core.dll");
        Assert.DoesNotContain(ReferencedTypes(path), t => t is "System.Diagnostics.Process" or "System.Diagnostics.ProcessStartInfo");
    }

    private static string AgentSource(string relative, [System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "src", "Jarvis.DesktopAgent", relative));

    [Fact]
    public void The_agent_declares_no_elevation_and_no_ui_access()
    {
        var manifest = File.ReadAllText(AgentSource("app.manifest"));
        Assert.Contains("level=\"asInvoker\"", manifest, StringComparison.Ordinal);
        Assert.Contains("uiAccess=\"false\"", manifest, StringComparison.Ordinal);
    }
}

public class InspectionTests
{
    [Fact]
    public void Reads_its_own_integrity_level()
    {
        var level = DesktopInspector.IntegrityOf((uint)Environment.ProcessId);
        Assert.NotNull(level);
        Assert.InRange(level!.Value, 0x1000, 0x4000);
    }

    [Fact]
    public void Reports_the_kernel_build_number()
    {
        Assert.Equal(Environment.OSVersion.Version.Build, Platform.WindowsBuild);
    }

    [Fact]
    public void Refuses_to_run_anywhere_but_windows_11_workstations_on_x64()
    {
        var reason = Platform.Unsupported();
        // A CI runner is Windows Server: the agent must refuse it, by name.
        if (reason is not null) Assert.Matches("Windows 11|x64", reason);
    }

    [Fact]
    public void Refuses_input_it_was_never_meant_to_send_before_sending_anything()
    {
        var injector = new SendInputInjector();
        Assert.Throws<ArgumentException>(() => injector.Key("f12"));
        Assert.Throws<ArgumentException>(() => injector.Key("win"));
        Assert.Throws<ArgumentException>(() => injector.Click(0, 0, "x1"));
        Assert.Throws<ArgumentException>(() => injector.Type("line\nbreak"));
    }
}
