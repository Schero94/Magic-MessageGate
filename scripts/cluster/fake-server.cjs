'use strict';
// Fake providers for the cluster acceptance run (synthetic numbers only):
// provider APIs on MG_CLUSTER_FAKE_PORT, a control endpoint on
// MG_CLUSTER_FAKE_CONTROL_PORT. POST /queue {route, answer, times} queues a
// special answer; GET /sends lists every WhatsApp and SMS send request.
const http = require('node:http');

process.env.FAKE_PORT = process.env.MG_CLUSTER_FAKE_PORT || '1481';
const control = Number(process.env.MG_CLUSTER_FAKE_CONTROL_PORT || 1482);
const { startFakeProviders } = require('./fake-providers.cjs');

startFakeProviders().then((fake) => {
  console.log('fake providers on', fake.url);
  http
    .createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/queue') {
          const { route, answer, times = 1 } = JSON.parse(raw);
          for (let i = 0; i < times; i += 1) fake.queue(route, answer);
          return res.end('ok');
        }
        if (req.url === '/sends') {
          const sends = fake.requests
            .filter((r) => ['meta.send', 'seven.send'].includes(r.route))
            .map((r) => ({
              route: r.route,
              to: r.route === 'meta.send' ? r.json?.to : r.json?.to || r.form?.to,
              id: r.answer?.json?.messages?.[0]?.id,
              status: r.answer?.status,
            }));
          return res.end(JSON.stringify(sends));
        }
        res.statusCode = 404;
        return res.end();
      });
    })
    .listen(control, '127.0.0.1');
});
