process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://inbox:inbox@localhost:5432/inbox_test';
process.env.ENCRYPTION_KEYS ??= `k2:${Buffer.alloc(32, 2).toString('base64')},k1:${Buffer.alloc(32, 1).toString('base64')}`;
process.env.REDIS_URL ??= 'redis://localhost:6379';
