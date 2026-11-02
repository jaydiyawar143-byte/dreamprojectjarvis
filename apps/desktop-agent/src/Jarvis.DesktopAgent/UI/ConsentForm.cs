// ---------------------------------------------------------------------------
// Phase 19.6 — consent, on this computer only (U5c).
//
// The person chooses how long (1–60 minutes, 15 by default) and what JARVIS
// may do; the screen shows the exact versioned text those choices produce,
// and that exact text is what is hashed and sent. Typing and opening
// applications are off unless they tick them. Allow acts only on physical input: a click or key press injected
// by any program — this agent included — is ignored.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Jarvis.DesktopAgent.Windows;

namespace Jarvis.DesktopAgent.UI;

internal sealed class ConsentForm : Form
{
    private readonly Pairing pairing;
    private readonly InputHooks hooks;
    private readonly NumericUpDown minutes = new() { Minimum = 1, Maximum = ProtocolConstants.GrantMaxMinutes, Value = ProtocolConstants.GrantDefaultMinutes, Width = 70 };
    private readonly CheckBox click = new() { Text = "Click", Checked = true, AutoSize = true };
    private readonly CheckBox keys = new() { Text = "Press keys (Enter, Tab, Escape, Backspace, Delete, arrows)", Checked = true, AutoSize = true };
    private readonly CheckBox type = new() { Text = "Type approved text (Windows Hello every time)", Checked = false, AutoSize = true };
    private readonly CheckBox apps = new() { Text = "Open approved applications", Checked = false, AutoSize = true };
    private readonly TextBox text = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Width = 520, Height = 300, TabStop = false };
    private readonly Label notice = new() { AutoSize = true, ForeColor = Color.Firebrick };
    private readonly Button allow = new() { Text = "Allow", AutoSize = true };
    private readonly Button deny = new() { Text = "Don't allow", AutoSize = true, DialogResult = DialogResult.Cancel };

    public ConsentForm(Pairing pairing, InputHooks hooks, bool extending)
    {
        this.pairing = pairing;
        this.hooks = hooks;
        Text = extending ? "JARVIS — extend control" : "JARVIS — allow control";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        TopMost = true;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        CancelButton = deny;

        var duration = new FlowLayoutPanel { AutoSize = true };
        duration.Controls.Add(new Label { Text = "For", AutoSize = true, Padding = new Padding(0, 6, 0, 0) });
        duration.Controls.Add(minutes);
        duration.Controls.Add(new Label { Text = "minutes", AutoSize = true, Padding = new Padding(0, 6, 0, 0) });

        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill };
        buttons.Controls.Add(deny);
        buttons.Controls.Add(allow);

        var layout = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        layout.Controls.Add(duration);
        layout.Controls.Add(click);
        layout.Controls.Add(keys);
        layout.Controls.Add(type);
        layout.Controls.Add(apps);
        layout.Controls.Add(text);
        layout.Controls.Add(notice);
        layout.Controls.Add(buttons);
        Controls.Add(layout);

        minutes.ValueChanged += (_, _) => Render();
        click.CheckedChanged += (_, _) => Render();
        keys.CheckedChanged += (_, _) => Render();
        type.CheckedChanged += (_, _) => Render();
        apps.CheckedChanged += (_, _) => Render();
        allow.Click += OnAllow;
        Render();
    }

    public int Minutes => (int)minutes.Value;

    public IReadOnlyList<string> Scope
    {
        get
        {
            var scope = new List<string>();
            if (click.Checked) scope.Add(ProtocolConstants.Click);
            if (keys.Checked) scope.Add(ProtocolConstants.Key);
            if (type.Checked) scope.Add(ProtocolConstants.Type);
            if (apps.Checked) scope.Add(ProtocolConstants.AppLaunch);
            return scope;
        }
    }

    /// <summary>Exactly the text on screen when Allow was pressed.</summary>
    public string ShownText { get; private set; } = "";

    private void Render()
    {
        var scope = Scope;
        allow.Enabled = scope.Count > 0;
        ShownText = scope.Count > 0 ? ConsentText.Render(pairing.UserLabel, pairing.OrganizationLabel, Minutes, scope) : "";
        text.Text = ShownText.Replace("\n", Environment.NewLine, StringComparison.Ordinal);
    }

    private void OnAllow(object? sender, EventArgs e)
    {
        if (!hooks.LastInputWasPhysical)
        {
            notice.Text = "Use your own mouse or keyboard to allow control.";
            return;
        }
        Render();
        DialogResult = DialogResult.OK;
        Close();
    }
}
