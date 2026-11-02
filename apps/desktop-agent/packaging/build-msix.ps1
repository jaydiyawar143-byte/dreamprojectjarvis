<#
.SYNOPSIS
  Phase 19.6: builds, checks, packs, signs and verifies the desktop agent MSIX.

.DESCRIPTION
  1. Publishes the agent self-contained for win-x64 (no runtime to install).
  2. Fills in AppxManifest.xml and refuses to pack unless it is exactly what
     was approved: per-user, Windows 11 (10.0.22000.0+) x64, capabilities
     internetClient and runFullTrust only, no extensions, no elevation.
  3. Packs with makeappx and signs with signtool (Windows SDK).
  4. Verifies the signature and that the signer is the manifest's Publisher.
  5. With -BaseUri, writes the App Installer update file (https only).

  -TestCertificate makes a throwaway self-signed code-signing certificate for
  CI and local checks. A package signed with it is for testing only and must
  never be distributed. Real releases pass -CertificatePath (a code-signing
  certificate whose subject is the Publisher).

.EXAMPLE
  ./build-msix.ps1 -Publisher "CN=JARVIS Test Signing" -TestCertificate -TrustTestCertificate
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$Configuration = "Release",
  [ValidatePattern('^\d+\.\d+\.\d+\.0$')][string]$Version = "1.1.0.0",
  [ValidatePattern('^CN=')][string]$Publisher = "CN=JARVIS Test Signing",
  [string]$CertificatePath,
  [SecureString]$CertificatePassword,
  [switch]$TestCertificate,
  [switch]$TrustTestCertificate,
  [string]$BaseUri,
  [string]$OutDir = (Join-Path $PSScriptRoot "..\artifacts"),
  [string]$Dotnet = "dotnet"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$message) { throw "build-msix: $message" }

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$publish = Join-Path $OutDir "publish"
$layout = Join-Path $OutDir "layout"
$msix = Join-Path $OutDir "JARVIS.DesktopAgent.msix"
foreach ($dir in @($publish, $layout)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
New-Item -ItemType Directory -Force $publish, $layout | Out-Null

# The package version and the agent's own version are the same release.
$agentVersion = ($Version -split '\.')[0..2] -join '.'
$props = [xml](Get-Content (Join-Path $root "Directory.Build.props"))
if ($props.Project.PropertyGroup.Version -ne $agentVersion) { Fail "Version $Version does not match Directory.Build.props ($($props.Project.PropertyGroup.Version))." }

# ---- 1. Publish ------------------------------------------------------------
& $Dotnet publish (Join-Path $root "src\Jarvis.DesktopAgent\Jarvis.DesktopAgent.csproj") -c $Configuration -r win-x64 --self-contained true -o $publish -nologo
if ($LASTEXITCODE -ne 0) { Fail "dotnet publish failed." }
Copy-Item -Recurse (Join-Path $publish "*") $layout

# ---- 2. Manifest -----------------------------------------------------------
$manifestText = (Get-Content -Raw (Join-Path $PSScriptRoot "AppxManifest.xml")).Replace("__PUBLISHER__", [System.Security.SecurityElement]::Escape($Publisher)).Replace("__VERSION__", $Version)
$manifestPath = Join-Path $layout "AppxManifest.xml"
[System.IO.File]::WriteAllText($manifestPath, $manifestText, (New-Object System.Text.UTF8Encoding $false))

function Assert-Manifest([xml]$m) {
  $ns = New-Object System.Xml.XmlNamespaceManager $m.NameTable
  $ns.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
  $ns.AddNamespace("rescap", "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities")
  $identity = $m.SelectSingleNode("/f:Package/f:Identity", $ns)
  if ($identity.ProcessorArchitecture -ne "x64") { Fail "the package must be x64 only." }
  if ($identity.Publisher -ne $Publisher) { Fail "the manifest Publisher is not $Publisher." }
  $family = $m.SelectSingleNode("/f:Package/f:Dependencies/f:TargetDeviceFamily", $ns)
  if ($family.Name -ne "Windows.Desktop" -or [version]$family.MinVersion -lt [version]"10.0.22000.0") { Fail "the package must require Windows 11 (10.0.22000.0) or later." }
  $capabilities = @($m.SelectNodes("/f:Package/f:Capabilities/*", $ns) | ForEach-Object { $_.Name }) | Sort-Object
  if (($capabilities -join ",") -ne "internetClient,runFullTrust") { Fail "capabilities must be exactly internetClient and runFullTrust, found: $($capabilities -join ', ')." }
  if ($m.SelectNodes("//*[local-name()='Extensions']").Count -gt 0) { Fail "the package declares extensions (services, startup tasks, protocols...); v1 has none." }
  $apps = $m.SelectNodes("/f:Package/f:Applications/f:Application", $ns)
  if ($apps.Count -ne 1 -or $apps[0].EntryPoint -ne "Windows.FullTrustApplication" -or $apps[0].Executable -ne "Jarvis.DesktopAgent.exe") { Fail "the package must contain exactly the agent executable." }
  if ($m.OuterXml -match "allowElevation|uiAccess|packageWriteRedirectionCompatibilityShim|unvirtualizedResources") { Fail "the package asks for elevation or unvirtualized access." }
}
Assert-Manifest ([xml]$manifestText)

# Logos: generated, plain - no binary files in the repository.
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $layout "Assets"
New-Item -ItemType Directory -Force $assets | Out-Null
foreach ($logo in @(@{ Name = "StoreLogo.png"; Size = 50 }, @{ Name = "Square150x150Logo.png"; Size = 150 }, @{ Name = "Square44x44Logo.png"; Size = 44 })) {
  $bitmap = New-Object System.Drawing.Bitmap $logo.Size, $logo.Size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.Clear([System.Drawing.Color]::FromArgb(176, 32, 32))
  $font = New-Object System.Drawing.Font "Segoe UI", ([float]($logo.Size / 3)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = "Center"; $format.LineAlignment = "Center"
  $g.DrawString("J", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, $logo.Size, $logo.Size), $format)
  $bitmap.Save((Join-Path $assets $logo.Name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $font.Dispose(); $bitmap.Dispose()
}

# ---- 3. Pack and sign ------------------------------------------------------
$kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$sdk = Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { Fail "the Windows SDK (makeappx.exe, signtool.exe) was not found under $kits." }
$makeappx = Join-Path $sdk.FullName "x64\makeappx.exe"
$signtool = Join-Path $sdk.FullName "x64\signtool.exe"

& $makeappx pack /o /d $layout /p $msix | Out-Host
if ($LASTEXITCODE -ne 0) { Fail "makeappx failed." }

$pfx = $CertificatePath
$password = $CertificatePassword
if ($TestCertificate) {
  Write-Warning "Signing with a throwaway TEST certificate. This package is for testing only - never distribute it."
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 `
    -FriendlyName "JARVIS desktop agent TEST signing" -CertStoreLocation "Cert:\CurrentUser\My" `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") -NotAfter (Get-Date).AddDays(2)
  $plain = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $password = ConvertTo-SecureString $plain -AsPlainText -Force
  $pfx = Join-Path $OutDir "test-signing.pfx"
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
  Export-Certificate -Cert $cert -FilePath (Join-Path $OutDir "test-signing.cer") | Out-Null
  Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"
  if ($TrustTestCertificate) {
    # CI only (an administrator runner): trust the test publisher so the signature verifies.
    Import-Certificate -FilePath (Join-Path $OutDir "test-signing.cer") -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
    Import-Certificate -FilePath (Join-Path $OutDir "test-signing.cer") -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
  }
}
if (-not $pfx) { Fail "pass -CertificatePath (a code-signing certificate for $Publisher) or -TestCertificate." }
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try {
  $plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  & $signtool sign /fd SHA256 /f $pfx /p $plainPassword $msix | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "signtool sign failed." }
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plainPassword -ErrorAction SilentlyContinue
}

# ---- 4. Verify -------------------------------------------------------------
$signature = Get-AuthenticodeSignature $msix
if (-not $signature.SignerCertificate) { Fail "the package is not signed." }
if ($signature.SignerCertificate.Subject -ne $Publisher) { Fail "the signer ($($signature.SignerCertificate.Subject)) is not the Publisher ($Publisher)." }
if (-not $TestCertificate -or $TrustTestCertificate) {
  & $signtool verify /pa /v $msix | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "signtool verify failed." }
  if ($signature.Status -ne "Valid") { Fail "the signature is $($signature.Status)." }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($msix)
try {
  $entry = $zip.GetEntry("AppxManifest.xml")
  $reader = New-Object System.IO.StreamReader $entry.Open()
  try { Assert-Manifest ([xml]$reader.ReadToEnd()) } finally { $reader.Dispose() }
  if ($zip.GetEntry("AppxSignature.p7x") -eq $null) { Fail "the package has no signature block." }
} finally { $zip.Dispose() }

# ---- 5. Update source ------------------------------------------------------
if ($BaseUri) {
  if (-not $BaseUri.StartsWith("https://")) { Fail "the update source must be https://." }
  $installer = (Get-Content -Raw (Join-Path $PSScriptRoot "JARVIS.DesktopAgent.appinstaller.template")).Replace("__BASE_URI__", $BaseUri.TrimEnd('/')).Replace("__PUBLISHER__", [System.Security.SecurityElement]::Escape($Publisher)).Replace("__VERSION__", $Version)
  [System.IO.File]::WriteAllText((Join-Path $OutDir "JARVIS.DesktopAgent.appinstaller"), $installer, (New-Object System.Text.UTF8Encoding $false))
}

Write-Host "build-msix: $msix - signed by $Publisher, verified."
