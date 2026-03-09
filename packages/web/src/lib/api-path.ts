export function getBasePath(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!raw) return "";
  const stripped = raw.trim().replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "";
}

export function apiPath(path: string): string {
  const base = getBasePath();
  if (!base) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
