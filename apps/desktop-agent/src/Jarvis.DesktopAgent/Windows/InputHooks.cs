// ---------------------------------------------------------------------------
// Phase 19.6 — the kill switch, and telling a person from injected input.
//
// One low-level keyboard hook and one low-level mouse hook, on the UI thread.
// Every event Windows marks as injected — by SendInput, by this agent or by
// any other program — is ignored for both purposes:
//   * Ctrl+Alt+Shift+F12 ends control only when every key of it was pressed
//     on a real keyboard, so no command (and no other program) can press it,
//     and no command can stop a person from pressing it;
//   * the consent screen's Allow button acts only when the click or key press
//     that reached it was physical — injected input can never give consent.
// The hooks see key codes only to recognise those keys; nothing is recorded.
// ---------------------------------------------------------------------------

using System.Runtime.InteropServices;
using static Jarvis.DesktopAgent.Windows.NativeMethods;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class InputHooks : IDisposable
{
    private const uint VkShift = 0x10, VkControl = 0x11, VkMenu = 0x12, VkF12 = 0x7B;
    private const uint VkLShift = 0xA0, VkRShift = 0xA1, VkLControl = 0xA2, VkRControl = 0xA3, VkLMenu = 0xA4, VkRMenu = 0xA5;

    private readonly Action killSwitch;
    private readonly HookProc keyboardProc;
    private readonly HookProc mouseProc;
    private nint keyboardHook;
    private nint mouseHook;
    private bool ctrl, alt, shift;
    private volatile bool lastWasPhysical;

    public InputHooks(Action killSwitch)
    {
        this.killSwitch = killSwitch;
        // Held in fields: the hook must not be collected while Windows calls it.
        keyboardProc = OnKeyboard;
        mouseProc = OnMouse;
        var module = GetModuleHandle(null);
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
        if (keyboardHook == 0 || mouseHook == 0)
        {
            Dispose();
            throw new InvalidOperationException("The kill switch could not be installed; the agent will not run without it.");
        }
    }

    /// <summary>The most recent key press or mouse button press came from a person's hardware.</summary>
    public bool LastInputWasPhysical => lastWasPhysical;

    private nint OnKeyboard(int code, nint wParam, nint lParam)
    {
        if (code >= 0)
        {
            var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var injected = (info.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
            var message = (int)wParam;
            var down = message is WM_KEYDOWN or WM_SYSKEYDOWN;
            var up = message is WM_KEYUP or WM_SYSKEYUP;
            if (down) lastWasPhysical = !injected;
            if (!injected && (down || up))
            {
                switch (info.vkCode)
                {
                    case VkControl or VkLControl or VkRControl: ctrl = down; break;
                    case VkMenu or VkLMenu or VkRMenu: alt = down; break;
                    case VkShift or VkLShift or VkRShift: shift = down; break;
                    case VkF12 when down && ctrl && alt && shift: killSwitch(); break;
                }
            }
        }
        return CallNextHookEx(0, code, wParam, lParam);
    }

    private nint OnMouse(int code, nint wParam, nint lParam)
    {
        if (code >= 0 && (int)wParam is WM_LBUTTONDOWN or WM_RBUTTONDOWN or WM_MBUTTONDOWN)
        {
            var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            lastWasPhysical = (info.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) == 0;
        }
        return CallNextHookEx(0, code, wParam, lParam);
    }

    public void Dispose()
    {
        if (keyboardHook != 0) UnhookWindowsHookEx(keyboardHook);
        if (mouseHook != 0) UnhookWindowsHookEx(mouseHook);
        keyboardHook = 0;
        mouseHook = 0;
    }
}
