import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Endpoint URL screening. The service posts to URLs its customers give it,
 * from inside whatever network it is deployed in. Unscreened, that is a
 * server-side request forgery relay: register an endpoint at
 * http://169.254.169.254/ and the delivery worker fetches the cloud metadata
 * endpoint on the attacker's behalf.
 *
 * https is required outside development: a webhook body frequently carries
 * personal or financial data, and the signature protects integrity, not
 * confidentiality.
 */

export class EndpointUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointUrlError';
  }
}

const RESERVED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) >>> 0;
}

export function isReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = v4(address);
    return RESERVED_V4.some(([base, prefix]) => {
      const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
      return (value & mask) >>> 0 === (v4(base) & mask) >>> 0;
    }) || address === '255.255.255.255';
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isReservedAddress(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

export interface UrlGuardOptions {
  readonly allowInsecure: boolean;
  readonly resolve?: (hostname: string) => Promise<Array<{ address: string }>>;
}

export async function assertEndpointUrlAllowed(raw: string, options: UrlGuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointUrlError('Endpoint URL is not a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new EndpointUrlError('Endpoint URL must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new EndpointUrlError('Endpoint URL must not contain credentials.');
  }

  if (options.allowInsecure) return url;

  const addresses = isIP(url.hostname) !== 0
    ? [{ address: url.hostname }]
    : await (options.resolve ?? ((h) => lookup(h, { all: true })))(url.hostname).catch(() => {
        throw new EndpointUrlError(`Endpoint hostname ${url.hostname} could not be resolved.`);
      });

  if (addresses.length === 0) throw new EndpointUrlError(`Endpoint hostname ${url.hostname} did not resolve.`);
  for (const { address } of addresses) {
    if (isReservedAddress(address)) {
      throw new EndpointUrlError(`Endpoint hostname ${url.hostname} resolves to ${address}, a reserved address.`);
    }
  }
  return url;
}
