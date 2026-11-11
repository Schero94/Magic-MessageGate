// One Strapi process per PORT; the runner starts eight of them.
module.exports = ({ env }) => ({
  host: '127.0.0.1',
  port: env.int('PORT', 1491),
  url: `http://127.0.0.1:${env.int('PORT', 1491)}`,
  app: { keys: env.array('APP_KEYS') },
  logger: { updates: { enabled: false } },
});
