# Magic MessageGate for Strapi 5

Send template messages over **WhatsApp (Cloud API)**, **Telegram** and **SMS** (seven.io, Twilio) from Strapi 5, with a durable outbox, delivery and read tracking, consent handling and automatic fallback.

> Status: the server core is complete and tested; the admin interface and the full guide (screenshots, GitHub Pages) follow before the first release. The design contract is [CONCEPT.md](./CONCEPT.md).

## Install

```bash
npm install strapi-plugin-magic-messagegate
```

```js
// config/plugins.js
module.exports = ({ env }) => ({
  'magic-messagegate': {
    enabled: true,
    config: {
      encryptionKey: env('MESSAGEGATE_ENCRYPTION_KEY'),
      publicUrl: env('PUBLIC_URL'), // used for webhook URLs
    },
  },
});
```

Requirements: Strapi `^5.38.0`, Node.js `^22.21.0 || >=24.9.0`, PostgreSQL, MySQL 8 or SQLite.

## Send a message

```js
await strapi
  .plugin('magic-messagegate')
  .service('messages')
  .send({
    to: '+4915123456789',
    template: 'order_shipped',
    language: 'de',
    variables: { name: 'Ana', order: 'A-1' },
    idempotencyKey: 'order-A-1-shipped',
  });
// → { id, status: 'queued', channel: 'whatsapp', duplicate: false }
```

From another service, use an API token with the MessageGate permissions:

```http
POST /api/magic-messagegate/messages
Authorization: Bearer <api token>
Content-Type: application/json

{ "to": "+4915123456789", "template": "order_shipped", "variables": { "name": "Ana", "order": "A-1" } }
```

`GET /api/magic-messagegate/messages/:id` returns the status and the timeline (`queued → sent → delivered → read`).

## Development

```bash
npm ci
npm run lint && npm run format:check
npm test          # unit, contract (fake providers), 8-process SQLite
npm run test:pg   # PostgreSQL multi-process (MG_TEST_PG_URL)
npm run build && npm run verify
```

## License

MIT
