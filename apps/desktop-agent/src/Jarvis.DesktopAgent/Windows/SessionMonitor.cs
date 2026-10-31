// ---------------------------------------------------------------------------
// Phase 19.6 — lock, sign-out and shutdown end control (U5b).
//
// A hidden message window receives the session's lock notifications; Windows
// Forms reports sign-out and shutdown. Each ends the grant at once, with its
// reason. Between notifications, a command also checks that the input desktop
// is the ordinary one: on the secure desktop (UAC, Ctrl+Alt+Del, the lock
// screen) nothing runs.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Microsoft.Win32;
using static Jarvis.DesktopAgent.Windows.NativeMethods;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class SessionMonitor : NativeWindow, ISessionState, IDisposable
{
    private readonly GrantManager grants;
    private volatile bool locked;

    public SessionMonitor(GrantManager grants)
    {
        this.grants = grants;
        CreateHandle(new CreateParams { Caption = "JARVIS session monitor", Parent = new nint(-3) /* HWND_MESSAGE */ });
        if (!WTSRegisterSessionNotification(Handle, NOTIFY_FOR_THIS_SESSION))
        {
            // Without lock notifications the agent cannot keep its promise: treat as locked.
            locked = true;
        }
        SystemEvents.SessionEnding += OnSessionEnding;
    }

    public bool IsLocked => locked || !InputDesktopIsDefault();

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            switch ((int)m.WParam)
            {
                case WTS_SESSION_LOCK:
                    locked = true;
                    grants.End("lock");
                    break;
                case WTS_SESSION_UNLOCK:
                    locked = false;
                    break;
                case WTS_SESSION_LOGOFF:
                    locked = true;
                    grants.End("sign-out");
                    break;
            }
        }
        base.WndProc(ref m);
    }

    private void OnSessionEnding(object? sender, SessionEndingEventArgs e)
    {
        locked = true;
        grants.End(e.Reason == SessionEndReasons.Logoff ? "sign-out" : "shutdown");
    }

    /// <summary>True only when input goes to the ordinary "Default" desktop of this session.</summary>
    private static bool InputDesktopIsDefault()
    {
        var desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == 0) return false;
        try
        {
            var name = new char[64];
            if (!GetUserObjectInformation(desktop, UOI_NAME, name, (uint)(name.Length * 2), out _)) return false;
            return new string(name).TrimEnd('\0') == "Default";
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }

    public void Dispose()
    {
        SystemEvents.SessionEnding -= OnSessionEnding;
        if (Handle != 0)
        {
            WTSUnRegisterSessionNotification(Handle);
            DestroyHandle();
        }
    }
}
