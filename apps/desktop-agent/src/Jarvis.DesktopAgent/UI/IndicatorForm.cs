// ---------------------------------------------------------------------------
// Phase 19.6 — while JARVIS has control, the person can always see it.
//
// A small bar at the top of the main screen, above other windows, shown for
// the whole of a grant: who has control, the time left, the kill switch, and
// Stop. It never takes focus, and no command can reach it — it belongs to the
// agent's own process, which the agent never sends input to.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.UI;

internal sealed class IndicatorForm : Form
{
    private const int WsExToolWindow = 0x00000080;
    private const int WsExNoActivate = 0x08000000;
    private const int WsExTopmost = 0x00000008;

    private readonly IClock clock;
    private readonly Label label = new() { AutoSize = true, ForeColor = Color.White, Font = new Font("Segoe UI", 10f, FontStyle.Bold), Padding = new Padding(8, 8, 8, 0) };
    private readonly Button stop = new() { Text = "Stop", AutoSize = true, BackColor = Color.White };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 1000 };
    private readonly Func<LocalGrant?> current;

    /// <param name="current">The live grant. Reading it each second also ends a grant whose time ran out.</param>
    public IndicatorForm(IClock clock, Func<LocalGrant?> current, Action stopControl)
    {
        this.clock = clock;
        this.current = current;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(176, 32, 32);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        var layout = new FlowLayoutPanel { AutoSize = true, Padding = new Padding(4) };
        layout.Controls.Add(label);
        layout.Controls.Add(stop);
        Controls.Add(layout);
        stop.Click += (_, _) => stopControl();
        timer.Tick += (_, _) => ShowGrant(this.current());
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= WsExToolWindow | WsExNoActivate | WsExTopmost;
            return parameters;
        }
    }

    /// <summary>Shows the bar for a grant, or hides it when there is none.</summary>
    public void ShowGrant(LocalGrant? grant)
    {
        if (grant is null)
        {
            timer.Stop();
            Hide();
            return;
        }
        var left = TimeSpan.FromMilliseconds(Math.Max(0, grant.ExpiresAt - clock.NowMs));
        label.Text = $"JARVIS can control this computer — {(int)left.TotalMinutes}:{left.Seconds:00} left — {ProtocolConstants.KillSwitch} stops it";
        if (!Visible)
        {
            Show();
            timer.Start();
        }
        var screen = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
        Location = new Point(screen.Left + ((screen.Width - Width) / 2), screen.Top);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Dispose();
            label.Font.Dispose();
        }
        base.Dispose(disposing);
    }
}
