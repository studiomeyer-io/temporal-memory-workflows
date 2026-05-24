import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/tests/**/*.test.ts",
      "templates/**/tests/**/*.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Temporal's worker uses native Neon bindings + WebAssembly. Vitest's default
    // worker_threads pool can crash with `WebAssembly.instantiate(): Out of memory`
    // when multiple test files boot TestWorkflowEnvironment in parallel. Forks pool
    // gives each test file a fresh process so native state never crosses boundaries.
    // See: github.com/temporalio/sdk-typescript/issues/876
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
