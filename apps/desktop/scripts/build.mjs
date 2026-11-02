import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.MOSS_BUILD_DIR ? resolve(process.env.MOSS_BUILD_DIR) : `${desktop}dist`;
const args = ["run", "build", "-w", "@moss/web", ...(process.env.MOSS_BUILD_DIR ? ["--", "--outDir", `${output}/web`] : [])];
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: root, stdio: "inherit" });
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}apps/service/src/index.ts`], outfile: `${output}/service.mjs`,
  platform: "node", format: "esm", bundle: true, target: "node22", sourcemap: true });
await cp(`${desktop}src/main.mjs`, `${output}/main.mjs`);
if (!process.env.MOSS_BUILD_DIR) await cp(`${root}apps/web/dist`, `${output}/web`, { recursive: true });
await cp(`${root}THIRD_PARTY_NOTICES.md`, `${output}/THIRD_PARTY_NOTICES.md`);
