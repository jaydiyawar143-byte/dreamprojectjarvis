// ---------------------------------------------------------------------------
// Phase 19.6 — input, through SendInput only (M4).
//
// A click is a move and a press and release at absolute virtual-desktop
// coordinates. A key is one of the nine named keys. Text is Unicode keystrokes
// (KEYEVENTF_UNICODE), so the keyboard layout cannot turn it into anything
// else. SendInput reports how many events it inserted: all, none, or some —
// "some" is the uncertain outcome the server records as UNKNOWN.
// ---------------------------------------------------------------------------

using System.Runtime.InteropServices;
using Jarvis.DesktopAgent.Core;
using static Jarvis.DesktopAgent.Windows.NativeMethods;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class SendInputInjector : IInputInjector
{
    private static readonly Dictionary<string, (ushort Vk, bool Extended)> Keys = new(StringComparer.Ordinal)
    {
        ["enter"] = (0x0D, false),
        ["tab"] = (0x09, false),
        ["escape"] = (0x1B, false),
        ["backspace"] = (0x08, false),
        ["delete"] = (0x2E, true),
        ["arrowup"] = (0x26, true),
        ["arrowdown"] = (0x28, true),
        ["arrowleft"] = (0x25, true),
        ["arrowright"] = (0x27, true),
    };

    public InjectionResult Click(int screenX, int screenY, string button)
    {
        var (down, up) = button switch
        {
            "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => throw new ArgumentException("Not a mouse button.", nameof(button)),
        };
        var left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var width = Math.Max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        var height = Math.Max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        var nx = (int)(((long)(screenX - left) * 65535) / (width - 1));
        var ny = (int)(((long)(screenY - top) * 65535) / (height - 1));
        const uint Absolute = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        return Send(
        [
            Mouse(nx, ny, MOUSEEVENTF_MOVE | Absolute),
            Mouse(nx, ny, down | Absolute),
            Mouse(nx, ny, up | Absolute),
        ]);
    }

    public InjectionResult Key(string key)
    {
        if (!Keys.TryGetValue(key, out var k)) throw new ArgumentException("Not an allowed key.", nameof(key));
        var extended = k.Extended ? KEYEVENTF_EXTENDEDKEY : 0;
        return Send([Keyboard(k.Vk, 0, extended), Keyboard(k.Vk, 0, extended | KEYEVENTF_KEYUP)]);
    }

    public InjectionResult Type(string text)
    {
        if (!TypeableText.IsValid(text)) throw new ArgumentException("Not typeable text.", nameof(text));
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (var unit in text)
        {
            inputs.Add(Keyboard(0, unit, KEYEVENTF_UNICODE));
            inputs.Add(Keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        return Send([.. inputs]);
    }

    private static InjectionResult Send(INPUT[] inputs)
    {
        var inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (inserted == 0) return InjectionResult.NothingSent;
        return inserted == inputs.Length ? InjectionResult.Completed : InjectionResult.Partial;
    }

    private static INPUT Mouse(int x, int y, uint flags) =>
        new() { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dx = x, dy = y, dwFlags = flags } } };

    private static INPUT Keyboard(ushort vk, ushort scan, uint flags) =>
        new() { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } } };
}
