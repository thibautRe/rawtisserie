/**
 * Talking to another instance (sending side): its address, checked before every request
 * (no private addresses unless allowed: the server makes these requests), and the
 * token the user brought from there.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { config } from '../config.ts';
import { HttpError, badRequest } from '../errors.ts';
import { Hello, PROTOCOL } from './protocol.ts';

export interface Remote {
  url: string;
  token: string;
}

/** Addresses only reachable from where the server runs. */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv6');

export const isPrivate = (address: string) => {
  // IPv4 written as IPv6 (::ffff:10.0.0.1).
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return v4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
};

/** An instance's base URL as given by a user: its origin, checked. */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw badRequest('That isn’t an address');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.allowPrivateInstances))
    throw badRequest('The other instance must be reached over HTTPS');
  return url.origin;
}

/** Refuse addresses only the server can reach (resolved now: every request checks again). */
async function checkAddress(url: string) {
  if (config.allowPrivateInstances) return;
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivate))
    throw badRequest('That address is private: this server can’t send there');
}

/** Why a request to another instance failed, in words. */
export class RemoteError extends HttpError {
  /** Nothing else will work either (the token, the versions): the transfer stops. */
  fatal: boolean;
  // 422 rather than 502: the error handler hides 5xx messages, and these are the user's to read.
  constructor(message: string, fatal = false, status = 422) {
    super(status, message);
    this.fatal = fatal;
  }
}

/** A request to `remote` (`path` under its origin), with its token. */
export async function remoteFetch(
  remote: Remote,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  await checkAddress(remote.url);
  let res: Response;
  try {
    res = await fetch(remote.url + path, {
      ...init,
      // A redirect could lead anywhere: not followed.
      redirect: 'manual',
      headers: { ...init.headers, authorization: `Bearer ${remote.token}` },
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new RemoteError(`Couldn’t reach ${remote.url}${cause ? ` (${cause})` : ''}`);
  }
  if (res.status === 401) throw new RemoteError('The other instance refused the token (revoked?)', true);
  if (res.status >= 300 && res.status < 400) throw new RemoteError(`${remote.url} redirects elsewhere`, true);
  return res;
}

/** The error a response from another instance carries. */
export async function remoteError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The other instance answered ${res.status}`;
}

/** Who's there: checked to speak the same protocol. */
export async function hello(remote: Remote): Promise<Hello> {
  const res = await remoteFetch(remote, '/api/transfer/hello');
  if (!res.ok) {
    throw new RemoteError(
      res.status === 404
        ? 'That isn’t a RAWtisserie instance (or it’s too old to receive photos)'
        : await remoteError(res),
      true,
    );
  }
  const parsed = Hello.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new RemoteError('That isn’t a RAWtisserie instance', true);
  if (parsed.data.protocol !== PROTOCOL)
    throw new RemoteError(
      parsed.data.protocol > PROTOCOL
        ? 'The other instance is newer: update this one first'
        : 'The other instance is older: update it first',
      true,
    );
  return parsed.data;
}
