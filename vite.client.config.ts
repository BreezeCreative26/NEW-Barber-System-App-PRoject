import { defineConfig } from "vite";

// Builds the React app to public/static/app.js + app.css, which the Hono HTML shells reference.
export default defineConfig({
  publicDir: false,
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "public/static",
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: "src/client/main.tsx",
      formats: ["es"],
      fileName: () => "app.js",
      cssFileName: "app",
    },
  },
});
