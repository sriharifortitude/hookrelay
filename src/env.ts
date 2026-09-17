import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(4000),
  ALLOW_INSECURE_ENDPOINTS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  throw new Error(
    `Invalid environment:\n${result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
  );
}

export const env = result.data;
