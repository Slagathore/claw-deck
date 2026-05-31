<#
.SYNOPSIS
  Generate (or refresh) the self-signed code-signing certificate used to sign
  Claw Deck builds locally.

.DESCRIPTION
  electron-builder is wired (package.json -> build.win.certificateSubjectName =
  "Claw Deck Dev") to sign with a cert found in the CurrentUser\My store whose
  subject contains "Claw Deck Dev". This script creates that cert, exports a
  portable .pfx/.cer into certs/ (gitignored), and trusts it on THIS machine so
  signatures verify as Valid locally.

  This is a TEST identity only. A self-signed cert is NOT trusted by other
  machines, so Windows SmartScreen will still warn end users. To ship for real,
  swap in an OV/EV cert or Azure Trusted Signing (see README -> Code Signing).

.PARAMETER PfxPassword
  Password for the exported .pfx. Defaults to "clawdeck-dev".
#>
[CmdletBinding()]
param(
  [string]$Subject     = 'CN=Claw Deck Dev, O=Claw Deck, C=US',
  [string]$FriendlyName = 'Claw Deck Dev Signing',
  [string]$PfxPassword = 'clawdeck-dev'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$certDir  = Join-Path $repoRoot 'certs'
if (-not (Test-Path $certDir)) { New-Item -ItemType Directory -Path $certDir | Out-Null }

# Remove any prior cert with the same subject so signtool's subject-name lookup
# stays unambiguous (electron-builder selects by certificateSubjectName).
$existing = Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object { $_.Subject -eq $Subject }
foreach ($old in $existing) {
  Write-Host "Removing prior cert $($old.Thumbprint)"
  Remove-Item "Cert:\CurrentUser\My\$($old.Thumbprint)" -Force
}

Write-Host "Creating self-signed code-signing cert: $Subject"
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -FriendlyName $FriendlyName `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(3)

$thumb = $cert.Thumbprint
Write-Host "  thumbprint = $thumb"

# Portable exports (for CI / other machines via CSC_LINK + CSC_KEY_PASSWORD)
$pfxPath = Join-Path $certDir 'clawdeck-dev.pfx'
$cerPath = Join-Path $certDir 'clawdeck-dev.cer'
$secure  = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$thumb" -FilePath $pfxPath -Password $secure | Out-Null
Export-Certificate    -Cert "Cert:\CurrentUser\My\$thumb" -FilePath $cerPath | Out-Null
Write-Host "  exported $pfxPath (password: $PfxPassword)"
Write-Host "  exported $cerPath"

# Trust on THIS machine (no admin needed for CurrentUser stores).
# Use the X509Store API directly so it doesn't pop the interactive Root-store
# confirmation dialog that Import-Certificate triggers.
$pub = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cerPath
foreach ($storeName in 'Root','TrustedPublisher') {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
  $store.Open('ReadWrite')
  if (-not $store.Certificates.Find('FindByThumbprint', $thumb, $false).Count) {
    $store.Add($pub)
    Write-Host "  trusted in CurrentUser\$storeName"
  }
  $store.Close()
}

Write-Host ''
Write-Host 'Done. Now run:  npm run dist'
