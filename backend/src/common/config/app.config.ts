export const appConfig = () => {
  return {
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    rabbitmqUrl: process.env.RABBITMQ_URL,
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET,
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      adminAccessSecret: process.env.JWT_ADMIN_ACCESS_SECRET,
      adminAccessTtl: process.env.JWT_ADMIN_ACCESS_TTL ?? '1d',
      accessTtl: process.env.JWT_ACCESS_TTL ?? '1d',
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    },
  };
};