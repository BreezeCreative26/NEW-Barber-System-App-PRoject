import { defineConfig } from "vite";

// Builds the React app into public/static/. Two entries so a phone opening a shop page never
// downloads the owner's workspace:
//   shop.tsx → the customer app (shop page, booking, account, offers, manage)
//   main.tsx → the owner/admin workspace
// Output file names carry a content hash and public/static/manifest.json maps entry → files; the
// Hono HTML shells read that manifest so every deploy is picked up immediately (assets are
// immutable, HTML is never cached). Shared code lands in a common chunk both entries import.
export default defineConfig({
  publicDir: false,
  base: "/static/",
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "public/static",
    emptyOutDir: false,
    minify: true,
    manifest: "manifest.json",
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { app: "src/client/main.tsx", shop: "src/client/shop.tsx" },
      output: {
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "chunk-[name]-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("node_modules/lucide-react")) return "icons";
        },
      },
    },
  },
});
