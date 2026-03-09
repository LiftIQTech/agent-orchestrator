/** @type {import('next').NextConfig} */

export function normalizeBasePath(raw) {
  if (raw == null) return "";

  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  const stripped = trimmed.replace(/^\/+|\/+$/g, "");
  if (!stripped) {
    throw new Error(
      `Invalid NEXT_PUBLIC_BASE_PATH: "${raw}" must include a non-root path segment like "ao" or "/ao".`,
    );
  }

  return `/${stripped}`;
}

const normalizedBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH ?? "");

const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  basePath: normalizedBasePath || undefined,
};

export default nextConfig;
