// Plugin config for the cluster acceptance app: every provider points at the
// local fake server (synthetic accounts only), sends are allowed in bulk.
const fake = `http://127.0.0.1:${process.env.MG_CLUSTER_FAKE_PORT || 1481}`;
module.exports = ({ env }) => ({
  'magic-messagegate': {
    enabled: true,
    config: {
      encryptionKey: env('MG_ENCRYPTION_KEY'),
      publicUrl: `http://127.0.0.1:${env('MG_CLUSTER_BALANCER_PORT', '1480')}`,
      worker: { intervalMs: 1000 },
      rateLimits: { adminWritePerMinute: 5000, sendPerMinute: 5000 },
      providers: {
        meta: {
          baseUrl: `${fake}/meta`,
          embeddedSignup: {
            appId: '100000000000001',
            configId: '200000000000002',
            appSecret: env('MG_SIGNUP_SECRET'),
            verifyToken: env('MG_SIGNUP_VERIFY'),
          },
        },
        telegram: { baseUrl: `${fake}/telegram` },
        seven: { baseUrl: `${fake}/seven` },
        twilio: { baseUrl: `${fake}/twilio`, lookupBaseUrl: `${fake}/lookup` },
      },
    },
  },
});
