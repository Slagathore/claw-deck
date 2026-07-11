/*
 * Claw Deck starter YARA rules — conservative, high-confidence indicators meant
 * to run in the upgrade/plugin scan gate with a low false-positive rate. Swap in
 * a broader ruleset (e.g. the Yara-Rules community repo) via
 * Settings → yaraRulesPath when you want deeper coverage.
 *
 * Deliberately avoids embedding known-malware byte strings (like EICAR) so this
 * file itself isn't quarantined by antivirus.
 */

rule ClawDeck_PowerShell_DownloadCradle
{
    meta:
        description = "PowerShell download-and-execute cradle (Net.WebClient + IEX)"
        author      = "Claw Deck starter rules"
        severity    = "high"
    strings:
        $net  = "Net.WebClient" nocase
        $dl   = "DownloadString" nocase
        $iex1 = "IEX" nocase fullword
        $iex2 = "Invoke-Expression" nocase
    condition:
        $net and $dl and ($iex1 or $iex2)
}

rule ClawDeck_Base64_PE_In_Text
{
    meta:
        description = "Base64-encoded Windows PE header embedded in a text/script file"
        author      = "Claw Deck starter rules"
        severity    = "high"
    strings:
        $mz_b64 = "TVqQAA"   /* base64 of the MZ..PE header */
    condition:
        $mz_b64
}

rule ClawDeck_Curl_Pipe_Shell
{
    meta:
        description = "Downloaded payload piped straight into a shell"
        author      = "Claw Deck starter rules"
        severity    = "high"
    strings:
        $c1 = /curl\s+[^\n|]+\|\s*(ba)?sh/ nocase
        $c2 = /wget\s+[^\n|]+\|\s*(ba)?sh/ nocase
        $c3 = /iwr\s+[^\n|]+\|\s*iex/ nocase
    condition:
        any of them
}
