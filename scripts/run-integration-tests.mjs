import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const rawUrl = process.env.INTEGRATION_DATABASE_URL;
let databaseUrl;
try { databaseUrl = rawUrl ? new URL(rawUrl) : null; } catch { databaseUrl = null; }
if (!databaseUrl || databaseUrl.protocol !== "postgresql:" || databaseUrl.hostname !== "127.0.0.1" || databaseUrl.port !== "55432" || databaseUrl.pathname !== "/legends_os_integration") {
  console.error("Refusing integration tests: INTEGRATION_DATABASE_URL must target the approved disposable local Legends OS database.");
  process.exit(1);
}

const outputDirectory = mkdtempSync(join(process.cwd(), ".legends-os-integration-"));
const outputFile = join(outputDirectory, "commerce.integration.cjs");
const workspaceDirectory = process.cwd().replaceAll("\\", "/");
try {
  await build({
    absWorkingDir: workspaceDirectory, stdin: { contents: 'import "./tests/commerce.integration.ts";', resolveDir: workspaceDirectory, sourcefile: "integration-entry.ts" }, outfile: outputFile,
    bundle: true, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "legends-path-alias", setup(builder) {
      builder.onResolve({ filter: /^@\// }, (args) => ({ path: `${workspaceDirectory}/${args.path.slice(2)}.ts` }));
    } }],
  });
  const result = spawnSync(process.execPath, ["--test", outputFile], {
    cwd: process.cwd(), stdio: "inherit", env: { ...process.env, DATABASE_URL: rawUrl, LEGENDS_INTEGRATION_TEST: "disposable-local-postgres" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
