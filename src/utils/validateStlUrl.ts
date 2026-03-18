/**
 * Validates that an STL URL belongs to a trusted storage origin.
 *
 * Allowed criteria:
 *  - Must use the `https:` scheme.
 *  - Hostname must exactly match the hostname of `allowedBaseUrl`.
 *
 * This prevents SSRF by ensuring the server only fetches STL files
 * from the configured R2 storage CDN (R2_PUBLIC_BASE_URL).
 *
 * @param stlUrl        The STL URL supplied by the API caller.
 * @param allowedBaseUrl The trusted base URL (e.g. `https://uploads.example.com`).
 * @returns `true` when the URL is safe to fetch; `false` otherwise.
 */
export function isAllowedStlUrl(
  stlUrl: string,
  allowedBaseUrl: string,
): boolean {
  let parsed: URL;
  let allowedParsed: URL;

  try {
    parsed = new URL(stlUrl);
  } catch {
    return false;
  }

  try {
    allowedParsed = new URL(allowedBaseUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  return parsed.hostname === allowedParsed.hostname;
}
