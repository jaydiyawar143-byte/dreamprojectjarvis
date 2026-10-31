// ---------------------------------------------------------------------------
// Phase 19.6 — Windows Hello, for each typing command (D1).
//
// Asked fresh for every command, attached to the agent's own window so it
// appears in front of the person, with a message naming the program that will
// receive the typing and how many characters — never the text. If Hello is not
// set up, not available, or anything goes wrong, the answer is "unavailable"
// or "failed": typing is refused. There is no fallback to a password, a PIN
// typed into the agent, or the in-app approval alone.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Windows.Security.Credentials.UI;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class WindowsHelloVerifier(Func<nint> owner) : IHelloVerifier
{
    public async Task<HelloResult> VerifyAsync(string message, CancellationToken cancellationToken)
    {
        UserConsentVerifierAvailability availability;
        try
        {
            availability = await UserConsentVerifier.CheckAvailabilityAsync().AsTask(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // Any failure to reach Hello is "unavailable" — a refusal.
        catch (Exception)
#pragma warning restore CA1031
        {
            return HelloResult.Unavailable;
        }
        if (availability != UserConsentVerifierAvailability.Available) return HelloResult.Unavailable;

        try
        {
            var result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(owner(), message).AsTask(cancellationToken).ConfigureAwait(false);
            return result switch
            {
                UserConsentVerificationResult.Verified => HelloResult.Verified,
                UserConsentVerificationResult.DeviceNotPresent or UserConsentVerificationResult.NotConfiguredForUser
                    or UserConsentVerificationResult.DisabledByPolicy => HelloResult.Unavailable,
                _ => HelloResult.Failed,
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // A prompt that could not be shown is a refusal, never a pass.
        catch (Exception)
#pragma warning restore CA1031
        {
            return HelloResult.Failed;
        }
    }
}
