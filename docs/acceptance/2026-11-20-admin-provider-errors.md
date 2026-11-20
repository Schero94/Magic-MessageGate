# Admin UI acceptance: provider error explanations and webhook hints (2026-11-20)

Build under test: `npm pack` of a local merge of #13 (provider fixes, incl. the per-provider webhook hints), #15 (contract and live tests) and this branch (provider error explanations), installed from the tarball into an isolated host.

## Host

- Strapi 5.63.0 and `@strapi/plugin-users-permissions` 5.63.0, SQLite, loopback port 1490, `server.url` `https://cms.example.test`.
- `providers.mode: 'sandbox'`, worker off; `NODE_OPTIONS=-r block-egress.cjs` (only loopback sockets) and a browser context that aborts every non-loopback request.
- Secrets generated with `crypto.randomBytes` into a mode-600 `.env`; admin `admin@example.test` registered through `POST /admin/register-admin`.
- Synthetic fixtures (bootstrap seed): four accounts (Meta, Telegram, seven.io with health `SEVEN_501`, Twilio), an approved WhatsApp and an SMS template, ten contacts `+49 1555 0100 001…010`, ten messages with the codes `SEVEN_407004`, `TWILIO_21610`, `META_131030`, `TWILIO_21408`, `SEVEN_402`, `SEVEN_600` (uncertain), `META_132015`, `SEVEN_EXPIRED`, plus one sent and one delivered message.

## Matrix

Playwright 1.65.1 (Chromium headless), own context per run. Six screens (messages, message details of a failed message, accounts, settings, inbox, templates) × 1440/1024/768/390/320 × light/dark = 60 runs with the workbench `measure.js`.

| Check                                                             | Result                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentOverflow`                                                | 0 in all 60 runs                                                                                                                                                     |
| `rowHeightMismatch`, `offScaleGaps`, `clippedText`, `lowContrast` | none                                                                                                                                                                 |
| `elementsOutsideViewport`                                         | only at 768: the last section tab ("Settings") of the horizontally scrolling section strip, reachable with its next button (same as 2026-11-11)                      |
| `smallTargets`                                                    | only the accepted native exceptions from 2026-11-11: DS `Field.Action` copy icon (16 × 16) in the webhook URL fields, DS Tag remove buttons (28 × 28) below 768 px   |
| Plugin console errors or warnings                                 | 0                                                                                                                                                                    |
| Message details                                                   | the failed message shows the code and its explanation ("The recipient unsubscribed at seven.io. Consent for SMS was revoked.") in light and dark at every width      |
| Accounts                                                          | seven.io shows "request method JSON" next to its webhook URL, Twilio shows where the URL goes, the unhealthy seven.io account shows `SEVEN_501` with its explanation |

Screenshots (30, synthetic data only) were kept outside the repository with the run; they are not README images.
