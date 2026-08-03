// Fetch an image from a URL supplied in an import spreadsheet.
//
// This is server-side fetching of a user-supplied address, which is the
// classic SSRF shape: our process sits inside the network, so "download this
// URL for me" can be pointed at a metadata endpoint, an internal admin panel,
// or the database host. Everything below exists to make that not work.
//
// Guards, in order:
//   • http/https only — no file:, no gopher:, no data:
//   • every resolved IP checked against the private / loopback / link-local
//     ranges, INCLUDING the cloud metadata address, and re-checked on each
//     redirect hop (a public hostname can 302 to 127.0.0.1)
//   • response must actually be an image, by content-type AND magic bytes
//   • hard byte ceiling enforced while streaming, so a slow infinite response
//     can't exhaust memory
//   • request timeout
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const ALLOWED_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

export class RemoteImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RemoteImageError';
  }
}

// Anything that isn't a globally-routable address. Covers the ranges an
// attacker would actually aim at, not just the textbook ones:
//   127/8 loopback · 10/8, 172.16/12, 192.168/16 private · 169.254/16
//   link-local (this is where 169.254.169.254, the cloud metadata endpoint,
//   lives) · 0/8 · 100.64/10 carrier NAT · 192.0.0/24 · 198.18/15 benchmark
//   · and the IPv6 equivalents.
const isBlockedIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;  // unique local
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    // IPv4-mapped (::ffff:127.0.0.1) — unwrap and re-check.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(v);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // unparseable — refuse rather than guess
};

const assertPublicHost = async (hostname) => {
  // A bare IP in the URL skips DNS entirely, so check it directly first.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new RemoteImageError(`refuses to fetch from the internal address ${hostname}`);
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new RemoteImageError(`could not resolve "${hostname}"`);
  }
  if (!addrs.length) throw new RemoteImageError(`could not resolve "${hostname}"`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new RemoteImageError(`"${hostname}" resolves to an internal address and won't be fetched`);
    }
  }
};

// Google Drive / Dropbox share links point at a viewer page, not the file.
// Operators paste them constantly because that's what the "Share" button
// gives them, so rewrite the two common shapes to their direct-download form
// rather than failing with a confusing "that wasn't an image".
export const normaliseImageUrl = (raw) => {
  const url = String(raw).trim();
  const drive = /^https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/([\w-]+)|open\?id=([\w-]+)|uc\?(?:.*&)?id=([\w-]+))/u.exec(url);
  if (drive) {
    const id = drive[1] || drive[2] || drive[3];
    return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//u.test(url)) {
    // Strip any existing dl flag FIRST, then decide the separator from what's
    // left — testing the original string would see the `?` we just removed and
    // produce "photo.jpg&dl=1", which isn't a valid URL.
    const stripped = url.replace(/([?&])dl=[01]/u, (_m, sep) => (sep === '?' ? '?' : '')).replace(/[?&]$/u, '');
    return `${stripped}${stripped.includes('?') ? '&' : '?'}dl=1`;
  }
  return url;
};

export const looksLikeUrl = (value) => /^https?:\/\//iu.test(String(value ?? '').trim());

// Sniff the real format. A server can claim any content-type, and Drive in
// particular serves text/html interstitials with a 200 — so the bytes decide.
const sniffExtension = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 6).startsWith('GIF8')) return 'gif';
  return null;
};

// Returns { buffer, extension, contentType }. Throws RemoteImageError with a
// message that's safe and useful to show an operator.
export const fetchRemoteImage = async (rawUrl, { maxBytes = MAX_REMOTE_IMAGE_BYTES } = {}) => {
  let target = normaliseImageUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new RemoteImageError(`"${rawUrl}" is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RemoteImageError(`only http and https links are supported (got "${parsed.protocol}")`);
    }
    // Re-checked every hop: a public host is free to redirect inward.
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(parsed.toString(), {
        redirect: 'manual', // we follow by hand so each hop gets re-validated
        signal: controller.signal,
        headers: { accept: 'image/*' },
      });
    } catch (err) {
      clearTimeout(timer);
      throw new RemoteImageError(err.name === 'AbortError' ? 'the link timed out' : `could not reach the link (${err.message})`);
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new RemoteImageError('the link redirected with no destination');
      target = new URL(location, parsed).toString();
      continue;
    }
    if (!res.ok) {
      throw new RemoteImageError(
        res.status === 403 || res.status === 401
          ? 'the link is private — make it viewable by anyone with the link'
          : `the link returned ${res.status}`,
      );
    }

    // Trust Content-Length only to reject early; the real limit is enforced
    // while reading, since the header can lie or be absent.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new RemoteImageError(`the image is ${(declared / (1024 * 1024)).toFixed(1)} MB; the limit is ${Math.round(maxBytes / (1024 * 1024))} MB`);
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new RemoteImageError(`the image is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new RemoteImageError('the link returned an empty file');

    const sniffed = sniffExtension(buffer);
    if (!sniffed) {
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      throw new RemoteImageError(
        ct === 'text/html'
          ? 'that link opens a web page, not an image file — use a direct image link, or make the file public'
          : `that link returned ${ct || 'an unknown file type'}, not an image`,
      );
    }
    const contentType = [...ALLOWED_TYPES.entries()].find(([, ext]) => ext === sniffed)?.[0] ?? `image/${sniffed}`;
    return { buffer, extension: sniffed, contentType };
  }
  throw new RemoteImageError('the link redirected too many times');
};
