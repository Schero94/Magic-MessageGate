# Live tests against the real provider APIs

`npm run test:live` runs `tests/live/*.live.test.js` against the real Meta, Twilio, seven.io and Telegram APIs. It is never part of `npm test` and never runs in CI. Every test is skipped, with the reason, until its keys exist.

## Credentials file

Create `~/.config/magic-messagegate-live/.env` yourself and give it mode 600 (`chmod 600 ~/.config/magic-messagegate-live/.env`); the suites refuse a file other users can read. One `KEY=value` per line, `#` starts a comment. Values are only kept in memory; no test prints them, and the request log masks bot tokens, account SIDs, message SIDs, phone numbers and numeric ids.

`LIVE_PROVIDERS` (environment first, then the file) picks providers: a comma-separated list of `telegram`, `twilio`, `meta`, `seven`. Without it, every provider whose required keys are complete runs.

```sh
LIVE_PROVIDERS=telegram npm run test:live
```

Requests can only reach `api.telegram.org`, `api.twilio.com`, `lookups.twilio.com`, `content.twilio.com`, `graph.facebook.com`, `gateway.seven.io` (and Meta's media CDN hosts in the Meta suite); anything else is refused.

## Keys per provider

| Provider | Required (free, safe)                                                                                                                                                                     | What runs                                                                                                                                                                                                             | Optional keys and switches                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (a private chat you opened with the bot; send it `/start` once and read the id from `getUpdates`)                                                | getMe; text with HTML entities through the full send path; 4096 visible characters with entities; inline buttons; unknown chat and wrong token refused                                                                | `LIVE_WEBHOOKS=1` + `LIVE_INTERACTIVE=1`: webhook through a tunnel, you tap a button within 2 minutes. If the bot already has a webhook, also `TELEGRAM_RESTORE_SECRET` (its secret token) so it can be restored                                                                                                                                                                                        |
| Twilio   | `TWILIO_TEST_ACCOUNT_SID`, `TWILIO_TEST_AUTH_TOKEN` ([test credentials](https://www.twilio.com/docs/iam/test-credentials), Console → Account → API keys & tokens)                         | full send path with the magic numbers: success, 21211, 21612, 21408, 21610 (consent revoked), 21614, sender 21212 (account flagged) and 21611 (retried), wrong token 20003, account check refused with 403, Lookup v2 | `LIVE_ALLOW_PAID=1` + `LIVE_WEBHOOKS=1` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (your Twilio number), `TWILIO_LIVE_TO` (your own phone): one real SMS with a signed status callback through a tunnel                                                                                                                                                                                 |
| Meta     | `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID` (App Dashboard → WhatsApp → API Setup, test number), `META_TEST_RECIPIENT` (your own phone on the test number's allowed list) | phone number check; template list; template send through the full send path (wamid); free text (accepted in the 24-hour window, 131047 outside); malformed recipient and wrong token (190) refused                    | `META_TEMPLATE`, `META_TEMPLATE_LANGUAGE` (default `hello_world`, `en_US`). `LIVE_WEBHOOKS=1` + `META_APP_SECRET`: the test number's webhook override points at a tunnel; Meta verifies it, status webhooks arrive signed; the override is removed afterwards. Skipped when the number already has an override                                                                                          |
| seven.io | `SEVEN_API_KEY`                                                                                                                                                                           | balance check; wrong key refused                                                                                                                                                                                      | seven.io has no SMS sandbox. `LIVE_ALLOW_PAID=1` + `SEVEN_LIVE_TO` (your own phone): HLR check (0.01 EUR) and one SMS through the full send path; `SEVEN_SENDER` sets the sender ID. Plus `LIVE_WEBHOOKS=1` + `SEVEN_SIGNING_KEY`: two `dlr` webhooks (request method JSON and the form default) are created for a tunnel, the delivery report must arrive signed, both webhooks are deleted afterwards |

Switches: `LIVE_ALLOW_PAID=1` allows sends that cost money, `LIVE_WEBHOOKS=1` allows a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) quick tunnel (`cloudflared` on `PATH`) and temporary webhook configuration, `LIVE_INTERACTIVE=1` allows tests that wait for you to act in a messenger.

## Webhook tests

The webhook tests run MessageGate's real webhook controller (raw body, signature check, dedupe) in a local server behind a `https://<random>.trycloudflare.com` tunnel. They change only configuration they can restore and restore it in a `finally` block:

- Telegram: `setWebhook` through MessageGate's own "Test connection"; afterwards `deleteWebhook`, or the previous URL with `TELEGRAM_RESTORE_SECRET`.
- Meta: the phone number's `webhook_configuration.override_callback_uri` (not the app's callback URL); afterwards set to `""`, which falls back to the app callback.
- seven.io: two new webhooks; afterwards deleted by id. Existing webhooks are not touched.
- Twilio: a per-message `StatusCallback`; no account configuration changes.

## Results

Runs are recorded in `docs/acceptance/<date>-live.md` with the request log (masked) and what was and was not proven.
