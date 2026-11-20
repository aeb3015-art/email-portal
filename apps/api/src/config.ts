import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Comma-separated list of "keyId:base64key" (32-byte keys). The first entry encrypts new data. */
  ENCRYPTION_KEYS: z.string().min(1),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Optional server-side transcription (OpenAI-compatible Whisper endpoint). */
  TRANSCRIPTION_API_URL: z.string().optional(),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  SYNC_BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  SYNC_BACKFILL_MAX: z.coerce.number().int().positive().default(2000),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.coerce.number().int().default(1),
});

export type Config = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config: Config = parsed.data;
