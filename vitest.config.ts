import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: "forks",
    fileParallelism: false, // run files sequentially (tests share env state)
    env: {
      // Set dummy tokens so the import of index.ts doesn't bail out in tests
      // that don't care about Standalone Mode. The actual feature-gate
      // tests (standalone_mode_*.test.ts) override these via vi.hoisted.
      SLACK_BOT_TOKEN: "***",
      PORT: "0",
    },
  },
});
