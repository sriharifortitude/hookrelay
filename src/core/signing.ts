import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signatures (https://www.standardwebhooks.com).
 *
 * The spec is followed rather than a home-grown scheme because the receiver
 * is somebody else's code. A consumer who already has a Standard Webhooks
 * verifier -- Svix's, Stripe-compatible libraries, their framework's -- can
 * verify these deliveries without reading our documentation, and a scheme
 * of our own would be one more thing they had to get right.
 *
 * Three headers:
 *   webhook-id         unique per message, stable across retries
 *   webhook-timestamp  unix seconds, for replay protection
 *   webhook-signature  "v1,<base64 hmac>" -- may carry several, space-separated,
 *                      during secret rotation
 *
 * Signed content is `${id}.${timestamp}.${body}` with HMAC-SHA256 under the
 * raw secret bytes. Including the id and timestamp is what stops a captured
 * body being replayed under a different message id or outside the tolerance.
 */

export const SECRET_PREFIX = 'whsec_';
export const SIGNATURE_VERSION = 'v1';

/** 24 random bytes, base64: the spec's recommended shape. */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString('base64')}`;
}

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(raw, 'base64');
}

export type SignedHeaders = Readonly<Record<'webhook-id' | 'webhook-timestamp' | 'webhook-signature', string>>;

export function sign(
  secrets: readonly string[],
  messageId: string,
  timestamp: Date,
  body: string,
): SignedHeaders {
  const ts = Math.floor(timestamp.getTime() / 1000).toString();
  const toSign = `${messageId}.${ts}.${body}`;

  // Every current secret signs. During rotation the receiver holds the new
  // one, the old one or both, and any single match verifies.
  const signatures = secrets.map(
    (secret) => `${SIGNATURE_VERSION},${createHmac('sha256', secretBytes(secret)).update(toSign, 'utf8').digest('base64')}`,
  );

  return { 'webhook-id': messageId, 'webhook-timestamp': ts, 'webhook-signature': signatures.join(' ') };
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

export interface VerifyOptions {
  /** Seconds either side of now that a timestamp is accepted. Spec default: 300. */
  readonly toleranceSeconds?: number;
  readonly now?: Date;
}

/**
 * The receiver's side. Shipped in this package so the integration tests
 * verify deliveries with the same code a consumer would, and so the CLI can
 * print a verifier snippet that is known to match.
 */
export function verify(
  secret: string,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
  options: VerifyOptions = {},
): void {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (id === undefined || ts === undefined || signatureHeader === undefined) {
    throw new SignatureError('Missing webhook-id, webhook-timestamp or webhook-signature header.');
  }

  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp)) throw new SignatureError('webhook-timestamp is not an integer.');

  const tolerance = options.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new SignatureError(`webhook-timestamp is outside the ${tolerance}s tolerance.`);
  }

  const expected = createHmac('sha256', secretBytes(secret)).update(`${id}.${ts}.${body}`, 'utf8').digest();

  for (const candidate of signatureHeader.split(' ')) {
    const [version, encoded] = candidate.split(',', 2);
    if (version !== SIGNATURE_VERSION || encoded === undefined) continue;
    const provided = Buffer.from(encoded, 'base64');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return;
  }

  throw new SignatureError('No signature matched.');
}
