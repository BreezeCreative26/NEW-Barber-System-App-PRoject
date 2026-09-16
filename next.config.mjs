/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The React client is built by Vite into public/static/app.js (see vite.client.config.ts) and
  // served as a static asset; Next only hosts the Hono app.
  outputFileTracingIncludes: { "/[[...path]]": ["./src/db/schema.sql", "./docs/CUSTOMER-PLAN.md"] },
};
export default config;
