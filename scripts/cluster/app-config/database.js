// PostgreSQL for the cluster acceptance app (DATABASE_URL is set by the runner).
module.exports = ({ env }) => ({
  connection: {
    client: 'postgres',
    connection: { connectionString: env('DATABASE_URL') },
    pool: { min: 0, max: 4 },
  },
});
