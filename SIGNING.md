# Signing Claw Deck builds

Windows builds are signed with **Azure Artifact Signing** (account
`Slagathores-Apps`, profile `public`, publisher `CN=Charles Chambers`).

All account details, machine setup, VPN/IPv6 gotchas, auth commands, and the CI
recipe live in the shared playbook:
**`C:\Users\dev\CodeStuff\CODE-SIGNING-PLAYBOOK.md`** (reference implementation:
`job_finder_v2`). Don't duplicate those details here — read that.

## This repo's wiring

- [scripts/azure-sign.js](scripts/azure-sign.js) — electron-builder Windows sign
  hook (endpoint/account/profile constants at the top). Gated behind
  **`CLAW_SIGN=1`**, so plain `npm run dist` stays unsigned.
- `package.json` → `build.win.signtoolOptions.sign` points at that hook.

## Produce a signed build

```powershell
az account show   # confirm you're logged in (az login --tenant <tenant>-… if not)
npm run dist:signed
Get-AuthenticodeSignature .\dist-installer\*.exe | Format-List Status, SignerCertificate
# Expect: Status Valid, CN=Charles Chambers  (on both the NSIS installer and portable exe)
```

macOS/Linux release artifacts are built unsigned by
[.github/workflows/release-builds.yml](.github/workflows/release-builds.yml).
