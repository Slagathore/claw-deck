/**
 * Plain-English "why is this risky?" explanations for each scanner rule
 * (electron/lib/scanner RULES). Goes a step beyond the one-line `reason`:
 * what the pattern matches, why it matters, and when it's a likely
 * false-positive — so you can judge whether to ignore it.
 */
export const RULE_INFO: Record<string, string> = {
  'eval-call': "eval() executes a string as live code. It's a favorite way to hide malicious payloads. Legitimate uses in app code are rare — read the snippet; if the input comes from anywhere external, treat it as critical.",
  'new-function': "new Function('…') compiles a string into a function at runtime — the same execute-arbitrary-code risk as eval(). Occasionally used by templating/serialization libraries; verify the source string is a constant.",
  'vm-runincontext': "Node's vm module runs code in a context that is trivially escapable (it is NOT a real sandbox). Legitimate in test/sandbox tooling; suspicious in a plain library or skill.",
  'require-eval': "Imports child_process, which can spawn shell commands. Completely normal for build tools and CLIs; a red flag in something that claims to be a pure/offline skill.",
  'child-spawn': "Spawns an external process (spawn/exec/execSync/fork). Expected in CLIs and dev tools — the question is WHAT command and arguments run. Read the snippet and nearby code.",
  'shell-true': "spawn/exec with shell:true routes the command through a shell, so any unsanitized value becomes shell injection. Safe only if the command and args are constants, not built from input.",
  'powershell-encoded': "Base64-encoded PowerShell (-EncodedCommand / -e) hides the real command — a classic 'living off the land' evasion. Decode it and read what it actually does.",
  'cmd-curl-bash': "Downloads something and pipes it straight into a shell (curl … | bash). This runs unreviewed remote code on your machine — high risk almost regardless of context.",
  'iex-download': "PowerShell download-and-execute (Invoke-Expression of a downloaded string). Runs remote code with no review step — a common malware delivery pattern.",
  'fetch-call': "Makes an outbound HTTPS request. Extremely common and usually benign — flagged so you can see where the code talks to and whether any local data goes with it.",
  'http-request': "Opens a raw network request/socket (http/https/net/dns). Common; note the destination host and whether it's user-controlled.",
  'websocket': "Opens a WebSocket — a persistent two-way connection. Normal in realtime apps; note the endpoint it connects to.",
  'suspicious-ip': "A hard-coded IPv4 address. Most of the time this is a version string, an example, or a localhost/LAN address (a false-positive). Occasionally it's a hard-coded command-and-control host — read the snippet to tell which.",
  'tor-onion': "References a .onion (Tor hidden service) address. Very unusual in normal software and a classic covert exfiltration channel — investigate.",
  'discord-webhook': "A Discord webhook URL. These are one of the most common exfiltration endpoints for token/credential stealers. Rarely legitimate inside an installable package.",
  'telegram-bot': "Telegram bot API URL. Legitimate for bots, but also used to quietly exfiltrate data — confirm what gets sent.",
  'pastebin': "Fetches raw text from pastebin. Sometimes used to pull a second-stage payload at runtime; check what's fetched and whether it's executed.",
  'env-secret': "Reads an environment variable whose name looks like a credential (TOKEN/KEY/SECRET/PASSWORD/API). Normal for tools that need an API key — the concern is whether that secret is then sent over the network.",
  'aws-cred-read': "Reads AWS credentials (the ~/.aws/credentials file or AWS_SECRET_ACCESS_KEY). Legitimate for AWS tooling; confirm the credentials aren't transmitted anywhere.",
  'ssh-key-read': "Reads SSH private keys or known_hosts. Legitimate for SSH/git tooling; otherwise a strong red flag for credential theft.",
  'keychain': "Accesses the OS credential store (keychain / Windows Credential Manager / keytar). Legitimate for password managers and auth helpers; verify the intent.",
  'browser-cookie': "Reads browser cookie or login databases. This is a hallmark of info-stealer malware and is almost never legitimate in a skill or plugin.",
  'wallet-files': "References crypto wallet files (wallet.dat, Exodus, MetaMask, Electrum). Typical of wallet-stealer malware — treat with strong suspicion.",
  'base64-eval': "Decodes a long base64 blob and then executes it — a textbook obfuscated payload. Very rarely legitimate.",
  'hex-escape-spam': "A long run of \\xNN hex escapes. Usually obfuscation used to hide strings or code from casual review. Look for what it decodes to.",
  'unicode-escape-spam': "A long run of \\uNNNN unicode escapes — typically obfuscation to evade string-based review.",
  'minified-blob': "A very long single line — likely minified or packed code that's hard to read. Not risky by itself, but it can hide the patterns above; skim it.",
  'fs-unlink': "Deletes files (unlink/rm/rmSync). Normal for cleanup/temp handling — confirm the target path is scoped and not your data or something derived from input.",
  'rm-rf': "An 'rm -rf' style recursive delete. Verify the path is a fixed, scoped location and not built from external input (which could delete the wrong thing).",
  'fs-chmod-777': "Grants world-writable / overly permissive file permissions, weakening security. Check why such broad permissions are needed.",
  'preinstall-script': "An npm lifecycle script (preinstall/install/postinstall) that downloads or runs code at INSTALL time — before you ever import or run the package. High risk; read exactly what it executes.",
  'crypto-miner': "References a cryptocurrency miner (coinhive, stratum+tcp, xmrig/cpuminer, mining pools). Almost always malicious in this context.",
  'os-environ-dump': "Serializes the entire environment block (JSON.stringify(process.env)). Often a prelude to exfiltrating every secret your shell holds — see where the result goes.",
  'large-file': "A file too large (>2 MB) to scan in full, so it was skipped. Not a finding per se — just a heads-up to review it manually if it matters."
};
