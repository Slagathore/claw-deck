/**
 * electron-builder custom Windows sign hook → Azure Artifact Signing.
 * Copied from the proven job_finder_v2 implementation — see
 * C:\Users\dev\CodeStuff\job_finder_v2\SIGNING.md and the shared playbook
 * (CODE-SIGNING-PLAYBOOK.md) for the account details and machine gotchas.
 *
 * Why a hook instead of electron-builder's built-in azureSignOptions:
 *  1. The built-in path can't pass the -Exclude*Credential switches, and on
 *     this machine DefaultAzureCredential's ManagedIdentity probe black-holes
 *     into the VPN tunnel and hangs signing for ~20 minutes.
 *  2. We need DOTNET_SYSTEM_NET_DISABLEIPV6=1 (the VPN blocks IPv6; .NET
 *     picks IPv6 first and won't fall back) and az on PATH for the process.
 *
 * Gated behind CLAW_SIGN=1 so plain `npm run dist` stays unsigned.
 * Auth: `az login` locally, or AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET in CI
 * (drop the -ExcludeEnvironmentCredential switch below for CI).
 */
const { execFileSync } = require('child_process');

const ENDPOINT = 'https://cus.codesigning.azure.net/';
const ACCOUNT = 'Slagathores-Apps';
const PROFILE = 'public';
const AZ_PATH = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin';

exports.default = async function sign(config) {
  if (process.env.CLAW_SIGN !== '1') return; // unsigned build — skip silently

  const file = config.path.replace(/'/g, "''");
  const cmd = [
    'Invoke-TrustedSigning',
    `-Endpoint '${ENDPOINT}'`,
    `-CodeSigningAccountName '${ACCOUNT}'`,
    `-CertificateProfileName '${PROFILE}'`,
    `-Files '${file}'`,
    "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
    "-TimestampDigest 'SHA256'",
    "-FileDigest 'SHA256'",
    '-ExcludeEnvironmentCredential',
    '-ExcludeWorkloadIdentityCredential',
    '-ExcludeManagedIdentityCredential',
    '-ExcludeSharedTokenCacheCredential',
    '-ExcludeVisualStudioCredential',
    '-ExcludeVisualStudioCodeCredential',
    '-ExcludeAzurePowerShellCredential',
    '-ExcludeAzureDeveloperCliCredential',
    '-ExcludeInteractiveBrowserCredential',
  ].join(' ');

  console.log(`  • azure-sign: ${config.path}`);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DOTNET_SYSTEM_NET_DISABLEIPV6: '1',
      PATH: `${AZ_PATH};${process.env.PATH ?? ''}`,
    },
  });
};
