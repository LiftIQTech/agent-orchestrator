/**
 * Utility for prepending basePath to API routes.
 *
 * Next.js only auto-prefixes basePath for next/link and next/router;
 * Raw `fetch()` and `EventSource` calls require manual prepending of this basePath.
 */
export function getBasePath(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!raw) return "";
  const stripped = raw.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "";
}

export function apiPath(path: string): string {
  const base = getBasePath();
  if (!base) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
