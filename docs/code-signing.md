# Code signing Aegis (killing the SmartScreen warning)

Unsigned installers trigger Windows SmartScreen's "Windows protected your PC"
wall, and most people close it right there. Signing requires a certificate that
only you (the publisher) can buy — this doc lists the realistic options and the
exact wiring, which is already in place: **once you have a certificate, no code
changes are needed.**

## Options (cheapest realistic first)

| Option | Cost | Notes |
|---|---|---|
| **Certum Open Source Code Signing** | ~€69/yr (+ ~€35 card reader once) | The classic budget option for open-source devs. OV-level cert on a smart card. SmartScreen reputation builds over days–weeks of downloads. |
| **Azure Trusted Signing** | ~$9.99/mo | Microsoft's own signing service; integrates with electron-builder (`win.azureSignOptions`). Individual-developer validation available. Reputation builds fast because Microsoft vouches for identity. |
| **SignPath Foundation (free)** | Free for OSS | They sign builds of approved open-source projects via CI. Publisher shows "SignPath Foundation," not your name. Application process; CI-based builds required. |
| **Standard OV cert (Sectigo/SSL.com resellers)** | ~$85–200/yr | Works, but same slow reputation ramp as Certum at a higher price. |
| **EV certificate** | ~$250–400/yr | Instant SmartScreen reputation, no ramp-up. Only worth it once Aegis has real download volume. |

**Recommendation:** Certum OSS cert if you want cheapest, Azure Trusted Signing
if you want simplest (no hardware token, works in CI later).

## Wiring (already done — just add secrets)

electron-builder picks up certificates from environment variables at build
time. Nothing in `package.json` needs to change for a PFX-style cert:

```powershell
# PFX / P12 file (Certum exports one via their tool):
$env:CSC_LINK = "C:\path\to\aegis-cert.pfx"
$env:CSC_KEY_PASSWORD = "the-pfx-password"
npm run dist
```

For **Azure Trusted Signing**, add to `package.json` → `build.win`:

```json
"azureSignOptions": {
  "endpoint": "https://eus.codesigning.azure.net",
  "certificateProfileName": "<your-profile>",
  "codeSigningAccountName": "<your-account>"
}
```

and set `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` env vars
before `npm run dist`.

## After the first signed release

1. Add `"publisherName": "<exact name on the cert>"` to `build.win` — this
   lets the auto-updater verify downloaded updates are signed by you.
2. Keep the same cert for renewals; SmartScreen reputation is tied to it.
3. Until reputation builds (except EV/Azure), some users may still see the
   warning — the landing page's "More info → Run anyway" note stays useful.

## What NOT to do

- Self-signed certificates don't help — SmartScreen ignores them.
- Don't switch certificates casually; reputation resets.
