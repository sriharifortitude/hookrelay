import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys are shown once and stored hashed. The prefix makes a leaked key
 * recognisable to secret scanners, which is the reason every serious API
 * key format has one.
 */
export const KEY_PREFIX = 'hr_live_';

export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}
