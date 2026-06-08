import { parseFeed } from "./parser.js";
import type { ParsedFeed } from "./types.js";

// ────────────────────────────────────────
// Feed fetching logic
// ────────────────────────────────────────
// Stateless - no store dependency. Returns parsed feed data
// for the cache layer or subscribe flow to use.

/**
 * Validate a feed URL to prevent SSRF attacks.
 * Only http/https to public hostnames are allowed.
 * Exported for testing.
 */
export function validateFeedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid feed URL: "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Feed URL must use http or https (got "${parsed.protocol}").`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block RFC-1918, loopback, and private IPv6 ranges to prevent SSRF.
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./, // link-local / AWS metadata (IPv4)
    /^metadata\.google\.internal$/,
    // IPv6 loopback (bare and bracket forms)
    /^::1$/,
    /^\[::1\]$/,
    // IPv4-mapped IPv6
    /^\[::ffff:/i,
    // IPv6 unique-local (fc00::/7)
    /^\[f[cd][0-9a-f]{2}:/i,
    // IPv6 link-local (fe80::/10)
    /^\[fe[89ab][0-9a-f]:/i,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Feed URL "${url}" resolves to a private/reserved address and is not allowed.`
      );
    }
  }
}

/**
 * Fetch a single feed URL and return the parsed result.
 * Uses native fetch (Node 18+).
 */
export async function fetchFeedContent(url: string): Promise<ParsedFeed> {
  validateFeedUrl(url);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "FoundersOS-RSS/0.2 (+https://github.com/ourthinktank/founders-os)",
      Accept: "application/rss+xml, application/atom+xml, application/json, text/xml, */*",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} fetching ${url}`);
  }

  // Guard against memory exhaustion from unexpectedly large feeds.
  const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MB
  const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
  if (!isNaN(contentLength) && contentLength > MAX_FEED_BYTES) {
    throw new Error(
      `Feed response too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Maximum allowed is 5 MB.`
    );
  }

  // Stream the body and enforce the cap even when Content-Length is absent.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`Unable to read response body from ${url}`);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error(
        `Feed response exceeded 5 MB size limit while streaming from ${url}`
      );
    }
    chunks.push(value);
  }
  const body = new TextDecoder().decode(
    chunks.reduce((acc, chunk) => {
      const merged = new Uint8Array(acc.length + chunk.length);
      merged.set(acc);
      merged.set(chunk, acc.length);
      return merged;
    }, new Uint8Array(0))
  );

  return parseFeed(body, url);
}

/**
 * Split an array into chunks of a given size.
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
