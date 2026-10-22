import path from "node:path";

import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");

  return {
    build: { sourcemap: true },
    define: {
      __LINERFY_BUILD_SUPABASE_URL__: JSON.stringify(env.SUPABASE_URL ?? ""),
      __LINERFY_BUILD_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
        env.SUPABASE_PUBLISHABLE_KEY ?? "",
      ),
      __LINERFY_BUILD_API_URL__: JSON.stringify(
        env.LINERFY_API_URL || "https://linerfy.envorn.com",
      ),
    },
  };
});
