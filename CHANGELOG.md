# Changelog

## [Unreleased]

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
