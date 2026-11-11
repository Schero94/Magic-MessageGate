# Changelog

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
