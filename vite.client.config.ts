import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/static",
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
