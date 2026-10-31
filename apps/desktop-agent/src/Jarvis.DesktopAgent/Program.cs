// ---------------------------------------------------------------------------
// Phase 19.6 — the JARVIS desktop agent.
//
// One instance per signed-in person, as that person, never elevated. It refuses
// to start anywhere but Windows 11 x64, and without its kill switch.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.UI;
using Jarvis.DesktopAgent.Windows;

namespace Jarvis.DesktopAgent;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        using var single = new Mutex(initiallyOwned: true, @"Local\JARVIS-DesktopAgent", out var first);
        if (!first) return 0;

        ApplicationConfiguration.Initialize();
        if (Platform.Unsupported() is { } reason)
        {
            MessageBox.Show(reason, "JARVIS", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }

        TrayApp app;
        try
        {
            app = new TrayApp();
        }
        catch (InvalidOperationException e)
        {
            MessageBox.Show(e.Message, "JARVIS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        using (app)
        {
            Application.Run(app);
        }
        return 0;
    }
}
