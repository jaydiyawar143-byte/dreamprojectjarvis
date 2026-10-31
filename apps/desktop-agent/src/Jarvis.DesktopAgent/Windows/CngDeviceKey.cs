// ---------------------------------------------------------------------------
// Phase 19.6 — the device key, in Windows' own key storage.
//
// An ECDSA P-256 key created by Windows CNG for this user, with an export
// policy of None: the private key can sign and cannot be read out — not by the
// agent, not by anything else running as the person. In the TPM (the Microsoft
// Platform Crypto Provider) whenever the computer has one that can hold it;
// otherwise in the software key storage provider, still non-exportable. Only
// the public key ever leaves, and the server stores only that.
// ---------------------------------------------------------------------------

using System.Security.Cryptography;
using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.Windows;

internal sealed class CngDeviceKey : IDeviceKey, IDisposable
{
    internal const string DefaultKeyName = "JARVIS-DesktopAgent-DeviceKey-v1";

    private readonly CngKey key;
    private readonly ECDsaCng signer;

    private CngDeviceKey(CngKey key)
    {
        this.key = key;
        signer = new ECDsaCng(key);
        PublicKeySpki = Convert.ToBase64String(signer.ExportSubjectPublicKeyInfo());
    }

    public string PublicKeySpki { get; }

    /// <summary>True when the key lives in the TPM.</summary>
    public bool HardwareBacked => key.Provider == CngProvider.MicrosoftPlatformCryptoProvider;

    public byte[] Sign(byte[] data) => signer.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    /// <summary>Opens this user's device key, or creates it — TPM first.</summary>
    public static CngDeviceKey OpenOrCreate(string name = DefaultKeyName)
    {
        if (TryOpen(name) is { } existing) return existing;
        foreach (var provider in Providers)
        {
            try
            {
                return new CngDeviceKey(CngKey.Create(CngAlgorithm.ECDsaP256, name, new CngKeyCreationParameters
                {
                    Provider = provider,
                    KeyCreationOptions = CngKeyCreationOptions.None,
                    ExportPolicy = CngExportPolicies.None,
                    KeyUsage = CngKeyUsages.Signing,
                }));
            }
            catch (CryptographicException)
            {
                // No TPM, or one that cannot hold this key: fall back to software storage.
            }
        }
        throw new CryptographicException("No key storage provider could create the device key.");
    }

    /// <summary>Opens this user's existing device key, or null — never creates one.</summary>
    public static CngDeviceKey? TryOpen(string name = DefaultKeyName)
    {
        foreach (var provider in Providers)
        {
            try
            {
                if (CngKey.Exists(name, provider, CngKeyOpenOptions.UserKey))
                    return new CngDeviceKey(CngKey.Open(name, provider, CngKeyOpenOptions.UserKey));
            }
            catch (CryptographicException)
            {
                // Not usable from that provider.
            }
        }
        return null;
    }

    /// <summary>Deletes this user's device key wherever it is; a revoked or unpaired device starts over.</summary>
    public static void Delete(string name = DefaultKeyName)
    {
        foreach (var provider in Providers)
        {
            try
            {
                if (!CngKey.Exists(name, provider, CngKeyOpenOptions.UserKey)) continue;
                using var existing = CngKey.Open(name, provider, CngKeyOpenOptions.UserKey);
                existing.Delete();
            }
            catch (CryptographicException)
            {
                // Nothing usable there.
            }
        }
    }

    private static IEnumerable<CngProvider> Providers =>
        [CngProvider.MicrosoftPlatformCryptoProvider, CngProvider.MicrosoftSoftwareKeyStorageProvider];

    public void Dispose()
    {
        signer.Dispose();
        key.Dispose();
    }
}
