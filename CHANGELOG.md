# Changelog

## [Unreleased]

### Added

- seven.io: **Test connection** registers the account's webhook at seven.io through the official hooks API ([#17](https://github.com/Schero94/Magic-MessageGate/issues/17)): one hook for status reports (`dlr`) and one for inbound SMS (`sms_mo`), request method JSON, pointing at the account's webhook URL. Existing hooks are listed first, so testing again never creates duplicates; a JSON hook for the same URL that the owner made by hand is reused and left alone, and a form or GET hook for that URL is reported on the account card (MessageGate cannot read those). Registration needs a public https `server.url`; otherwise the card says why nothing was registered. The account card shows the result in all five admin languages, and **Remove webhook** (also run when the account is deleted) deletes only the hooks MessageGate created. Nothing secret reaches the browser or the log: the card gets a status, a reason code and counts, never hook ids, the API key or the signing key. seven.io has no per-hook secret; webhooks stay signed with the account's signing key. **Not live-verified yet:** the request and answer shapes follow seven.io's reference page and official OpenAPI (contract tests), and `tests/live/seven.live.test.js` has a new opt-in case for it, but it has not been run against the real seven.io API; no live credentials were available.

# [1.2.0](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.1.3...messagegate-v1.2.0) (2026-11-20)


### Features

* **admin:** explain every provider error code MessageGate classifies ([#16](https://github.com/Schero94/Magic-MessageGate/issues/16)) ([ee3933c](https://github.com/Schero94/Magic-MessageGate/commit/ee3933c9b507ea4009b173f9ca1805cde6929771))

## [1.1.3](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.1.2...messagegate-v1.1.3) (2026-11-20)


### Bug Fixes

* correct provider edge cases found in the API audit ([#13](https://github.com/Schero94/Magic-MessageGate/issues/13)) ([8cc8097](https://github.com/Schero94/Magic-MessageGate/commit/8cc809726bca902a72495712af059f1aca14e9e7))


### Added

- Plain-language explanations, in all five admin languages, for 42 more provider error codes shown in message details and account health: Meta (allowed-list, registration, policy, payment, permission, rate-limit, template quality and parameter errors), Twilio (throttling, sender, geo permissions, unreachable and non-mobile numbers, blocked, A2P 10DLC), seven.io (every documented return code and delivery report) and Telegram (refused message, rejected token). Texts follow the providers' official error references.

### Fixed

- seven.io: the admin and README now say to set the webhook's request method to **JSON**. seven.io's default sends form fields, which MessageGate cannot read; such a signed webhook now logs a warning instead of being dropped without a trace.
- seven.io: SMS texts are cut at 1520 characters (the documented limit) instead of 1600, so texts between 1521 and 1600 characters no longer fail with code 401.
- seven.io: return code 101 for the single recipient is a rejection with the recipient's own error code instead of `uncertain`; 500 (no credit) and 501 (spending limit) mark the account unhealthy; 407004 (recipient unsubscribed) revokes SMS consent.
- seven.io: inbound SMS keep their real receive time (`time` is a Unix timestamp); HLR checks return `roaming` from the documented object.
- Twilio: error 21610 (recipient replied STOP) and an inbound `OptOutType=STOP` (Advanced Opt-Out) revoke consent for the channel, so later sends stop at the consent check instead of failing at Twilio. Error 21611 (sender queue full) is retried.
- Telegram: long texts with `&`, `<` or `>` are no longer cut inside an HTML entity (the Bot API refused them); the 4096 limit counts visible characters.
- Webhook URLs, Twilio status callbacks, signed file links and the webhook raw-body capture follow `api.rest.prefix`. With a custom prefix every webhook used to fail the signature check.
- Outgoing texts are never cut inside an emoji.
- `Retry-After` given as an HTTP date is honoured (capped at 24 hours).
- WhatsApp template messages send `language.policy: "deterministic"`, which Meta's official OpenAPI requires.

### Documentation

- `docs/audits/2026-11-20-provider-apis.md`: audit of all four provider APIs against their official specs and docs.
- `docs/contract-tests.md` and `docs/live-tests.md`: what the contract and live suites prove, the pinned sources, the defects found in the official specs, and the credential keys per provider.

### Tests

- Contract tests (`tests/contract-*.test.js`, part of `npm test`, offline): every adapter request validated against the provider's pinned official spec (Meta `facebook/openapi`, Twilio `twilio-oai`, seven.io `api-schemes`, Telegram Bot API tables), the specs' examples fed back through adapters and webhook handlers, and Twilio's own signature test vector. `npm run contract:specs` rebuilds the pinned specs; `-- --check` reports upstream changes.
- Opt-in live suites (`npm run test:live`, never in CI): Telegram, Twilio (test credentials and magic numbers), Meta (test number) and seven.io, with credentials only from `~/.config/magic-messagegate-live/.env` (mode 600); paid sends, webhook changes and interactive steps each need their own switch, and webhook end-to-end runs use a cloudflared tunnel and restore what they change.

## [1.1.2](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.1.1...messagegate-v1.1.2) (2026-11-18)


### Bug Fixes

* **admin:** opt the dialogs out of the Radix description warning and add a StrictMode harness ([#9](https://github.com/Schero94/Magic-MessageGate/issues/9)) ([a6e300d](https://github.com/Schero94/Magic-MessageGate/commit/a6e300d2effcc1b0f4d0a3dd6893bb5720e2d9da))


### Fixed

- The message details, send message, contact details, number check and account dialogs no longer log the Radix "Missing `Description`" warning: they state that their title is the only label (`aria-describedby={undefined}`).

### Tests

- `npm run test:admin`: StrictMode tests for every admin entry point (no duplicate requests, no leaked timers, listeners, connections or observers after unmount, no console errors or warnings), also run against React 19 in an informational CI job.

## [1.1.1](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.1.0...messagegate-v1.1.1) (2026-11-17)


### Bug Fixes

* **readme:** make images and links work on the Strapi marketplace ([#5](https://github.com/Schero94/Magic-MessageGate/issues/5)) ([d2e2125](https://github.com/Schero94/Magic-MessageGate/commit/d2e2125f2fd9ca9f20ada678d33aebe8ff385911))

# [1.1.0](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.0.1...messagegate-v1.1.0) (2026-11-11)


### Features

* RCS, attachments, number checks and test APIs (1.1.0) ([#3](https://github.com/Schero94/Magic-MessageGate/issues/3)) ([a1c43cf](https://github.com/Schero94/Magic-MessageGate/commit/a1c43cf9059b4d09c159c910ff2e73da18289818))


### Features

- **RCS through Twilio**: new channel `rcs` (account with the Messaging Service SID of the RCS sender), plain-text templates and rich cards with title, image and buttons as Twilio Content templates ("Create on Twilio"), delivered/read/undelivered status callbacks, SMS fallback inside MessageGate's chain. Capability is learned from error 63036 (Twilio has no RCS lookup).
- **Attachments** in `send()`: `attachment: { fileId }` (media library) or `{ url, mimeType }` (public https). WhatsApp media messages and template header media, RCS media, Telegram `sendPhoto`/`sendDocument`; SMS gets a signed, expiring download link. MIME allow-list, magic-byte check, SSRF-safe URL policy, per-channel size caps; only a reference is stored.
- **Media templates**: IMAGE/DOCUMENT/VIDEO headers upload their sample with Meta's Resumable Upload API (`example.header_handle`) and send the header media at send time (attachment or the template's default file).
- **Number checks**: seven.io HLR lookup (active/inactive, network, ported) cached in the database and sharing the monthly budget; optional `blockInactiveNumbers` (`NUMBER_INACTIVE`, no provider cost); `lookup.capabilities(phone)` and `POST /capabilities`.
- **Inbound messages** for WhatsApp, RCS, Telegram and SMS: text, buttons (quick replies, reply buttons, inline keyboards, RCS suggested replies), media, locations; stored sealed, `messagegate.message.received` exactly once across processes, reply context, `inbound.get/list/markProcessed`, `messages.reply`, `conversations.history`, admin Inbox with unread counter, retention and GDPR export/erasure.
- **Inbound media**: download worker (lease per job, retries until the provider window ends), size cap while streaming, type allow-list, magic bytes, EXIF removal for JPEG/PNG, optional scan hook (`inbound.onMediaScan`), storage in the media library (`inboundMedia.storage`), `inbound.getMedia` (buffer, stream, base64), short-lived signed media URLs, `messagegate.media.ready` / `.failed`.
- **Outgoing webhook** (optional): selected events to an https URL with an HMAC-SHA256 signature, retries and an SSRF-safe URL policy.
- **Test APIs**: `send(input, { dryRun: true })` / `messages.preview`, `templates.render`, Content API `POST /templates/render` and `dryRun` on `POST /messages`, sandbox provider mode (`providers.mode: 'sandbox'`) with magic test numbers, `sandbox.simulateInbound`, and the `strapi-plugin-magic-messagegate/testing` export.
- Reply buttons on free-text messages (`buttons`), WhatsApp quick-reply payloads in templates, Telegram inline buttons in templates.

### Migration

- No action needed for existing data: on start, MessageGate adds the new tables (`mg_inbound`, `mg_number_checks`, `mg_attachment_links`, `mg_webhook_out`) and contact columns. Start one replica first when you deploy, then scale up.
- Settings saved by 1.0 keep their channel chain (`whatsapp → sms`). Add `rcs` in Settings → Routing to use it; new installs default to `whatsapp → rcs → sms`. New settings get their defaults.
- Run **Test** once on existing Telegram accounts so the webhook also receives button presses (`callback_query`).
- New RBAC actions **Inbox: read** and **Inbox: manage**; give them to the roles that should see replies. The new Content API routes for inbound messages are separate token permissions (`inbound-api`).
- Inbound text and files are personal data: review the inbox retention (90 days) and your privacy notice. E-mail stays opt-in and off by default; MessageGate never sends e-mail itself.

## [1.0.1](https://github.com/Schero94/Magic-MessageGate/compare/messagegate-v1.0.0...messagegate-v1.0.1) (2026-11-11)


### Bug Fixes

* **release:** publish the package with public access ([#2](https://github.com/Schero94/Magic-MessageGate/issues/2)) ([1295a68](https://github.com/Schero94/Magic-MessageGate/commit/1295a682ff2aef42776faf2765a9534dcf302031))

# 1.0.0 (2026-11-11)


### Bug Fixes

* align CI installs with lockfile settings ([4ed4c72](https://github.com/Schero94/Magic-MessageGate/commit/4ed4c72e6b498f426b0f31420de8e0832954f60a))
* build before verifying WhatsApp package exports ([bbdf206](https://github.com/Schero94/Magic-MessageGate/commit/bbdf2068aba4c83c2943e4f9ecf02ada0b32c778))
* bundle WhatsApp service for Strapi runtime ([f7306ab](https://github.com/Schero94/Magic-MessageGate/commit/f7306ab58e1abf0cbed8779149fbc701fe3e7ce5))


### Features

* add secure isolated WhatsApp plugin ([1cb39b7](https://github.com/Schero94/Magic-MessageGate/commit/1cb39b7e73c869be5cfcd310b9442d6431d4415b))
* establish isolated WhatsApp service ownership ([b6024af](https://github.com/Schero94/Magic-MessageGate/commit/b6024af40a356e8a91dd118793a9e15ba68cad88))
* scaffold local WhatsApp plugin with disabled routes ([19bbbba](https://github.com/Schero94/Magic-MessageGate/commit/19bbbbad035ae03234ae9ec62f0d9e87e8d01ac0))


### Breaking changes

- The package is now `strapi-plugin-magic-messagegate` (plugin id `magic-messagegate`). The former unofficial WhatsApp Web transport (`baileys`, QR pairing, `magic-whatsapp` routes and permissions) has been removed. Earlier `magic-whatsapp` versions were never published to npm.

### Features

- WhatsApp Cloud API, Telegram Bot API and SMS (seven.io, Twilio) through small fetch adapters, no vendor SDKs.
- Durable outbox with exactly-once dispatch across processes (PostgreSQL `FOR UPDATE SKIP LOCKED`, MySQL, SQLite), lease fencing, 1/5/15 minute backoff, `notAfter` deadlines and an `uncertain` state that is never resent automatically.
- Templates with zod-validated variables, WhatsApp template submission and status sync, SMS segment counting.
- Delivery and read tracking through signed webhooks (Meta, Telegram, seven.io, Twilio) with dedupe and replay protection.
- Consent per channel, STOP keywords, suppressions, learned WhatsApp reachability (error 131026), fallback chain WhatsApp → SMS → e-mail (Magic Mail).
- Number pre-check (E.164, line type) with an optional cached Twilio Lookup and a monthly budget.
- Admin and content API routes with RBAC actions, zod validation and rate limits; GDPR export and erasure; retention jobs.

### Security

- The Content API accepts Strapi API tokens only (`content-api-token` in Strapi 5.61, `api-token` before). Users-permissions logins get `403 FORBIDDEN` unless `contentApi.allowUsersPermissions` is set, because these routes act on any phone number.
- The paid number lookup in the admin needs the `contacts.manage` permission; the free format check stays available with `contacts.read`.
- A send accepts at most 50 variables and 20 metadata keys.

### Documentation

- New README, `AGENTS.md` API contract, GitHub Pages site with `llms.txt` and `llms-full.txt` (`npm run docs:llms` keeps the latter in sync), and an 8-process PostgreSQL acceptance record.

### Migration

- Remove `magic-whatsapp` from `config/plugins.*` and add `magic-messagegate`. Set `MESSAGEGATE_ENCRYPTION_KEY` (32+ random characters); without it the plugin derives keys from `APP_KEYS`.
- Old `magic-whatsapp` permissions disappear; grant the new `plugin::magic-messagegate.*` actions to admin roles.

## Release tags and npm versions

- Release tags use `messagegate-v${version}` (`.releaserc.json` `tagFormat`). Every version on npm has one: `messagegate-v1.0.1`, `messagegate-v1.1.0`, `messagegate-v1.1.1`, ...
- `messagegate-v1.0.0` exists as a tag but 1.0.0 was never published: the first release run failed at the npm step (OIDC token exchange `404 package not found`), after `@semantic-release/git` had pushed the tag. 1.0.1 (#2) is the first version on npm and carries the same code plus public access.
- `v1.0.0` and `v1.0.1` (2026-10-13) are the tags of the private predecessor `strapi-plugin-magic-whatsapp` from this repository's history. They were never published to npm and are not MessageGate versions. They stay in place because they are published GitHub releases.
- `0.0.0-stage` on npm (2026-11-11 08:35, description "Temporary package placeholder for staged publishing", 2 files, no code) is the placeholder npm created when the 1.0.1 run staged the first publish of the new package; 1.0.1 itself went live on approval at 08:37. It has no tag, is not a release and must not be installed; the package owner deprecates it with `npm deprecate strapi-plugin-magic-messagegate@0.0.0-stage "Placeholder created by npm staged publishing. Not a release; install strapi-plugin-magic-messagegate@latest."`.
