/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["sharp"],
  // The React client is built by Vite into public/static/ (see vite.client.config.ts) with
  // content-hashed file names and served as static assets; Next only hosts the Hono app.
  outputFileTracingIncludes: { "/[[...path]]": ["./src/db/schema.sql", "./docs/CUSTOMER-PLAN.md", "./public/static/manifest.json", "./src/server/sw.template.txt"] },
  async headers() {
    return [
      // Hashed bundles never change under the same name: cache forever.
      { source: "/static/:name(app|shop|chunk-[^/]+|react|icons)-:hash([a-zA-Z0-9_-]+).:ext(js|css)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/static/:name-:hash([a-zA-Z0-9_-]{6,}).:ext(js|css|woff2)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // Hand-written stylesheets are referenced with ?v=<build>; a day at the edge is safe.
      { source: "/static/:file(style|design|theme-fonts|shop-theme|landing).css", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      { source: "/static/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};
export default config;
