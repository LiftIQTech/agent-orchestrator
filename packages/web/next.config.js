/** @type {import('next').NextConfig} */

/**
 * Normalize and validate the basePath from NEXT_PUBLIC_BASE_PATH env var.
 *
 * - Empty string → no basePath (root deployment)
 * - "ao", "/ao", "/ao/" → "/ao"
 * - "/", "///" → throws error (Next.js rejects "/" as invalid)
 *
 * Next.js requires basePath to be a sub-path (e.g., "/ao"), not the root "/".
 * Raw fetch/EventSource calls need manual prepending of this basePath.
 */
function normalizeBasePath(raw) {
  if (!raw) return "";

  // Strip leading/trailing slashes, then prepend one
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  const basePath = normalized ? `/${normalized}` : "";

  // Next.js explicitly rejects basePath: "/" as invalid
  if (basePath === "/") {
    throw new Error(
      `Invalid NEXT_PUBLIC_BASE_PATH: "${raw}" normalizes to "/" which is not allowed. ` +
        `basePath must be a sub-path like "/ao", not the root. ` +
        `Set NEXT_PUBLIC_BASE_PATH to a non-empty value like "ao" or "/ao", or leave unset for root deployment.`,
    );
  }

  return basePath;
}

const normalizedBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH ?? "");

const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  basePath: normalizedBasePath || undefined,
};

export default nextConfig;
