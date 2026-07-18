#!/usr/bin/env node
// One-time setup: seed the gitignored working files from their committed *.example
// counterparts, but only when the real file does not already exist (never overwrites
// your real data). Run after `npm install`, before `npm run dashboard`.

import { copyFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const seeds = [
  ["config/candidate.example.json", "config/candidate.json"],
  ["tracking/search_results.example.json", "tracking/search_results.json"],
  ["tracking/dashboard_requests.example.json", "tracking/dashboard_requests.json"]
];

const exists = async (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

for (const [example, real] of seeds) {
  const realPath = resolve(root, real);
  if (await exists(realPath)) {
    console.log(`skip  ${real}  (already present — leaving your data untouched)`);
    continue;
  }
  await mkdir(dirname(realPath), { recursive: true });
  await copyFile(resolve(root, example), realPath);
  console.log(`seed  ${real}  <-  ${example}`);
}

// Ensure generated-output dirs exist for the dashboard's first write.
for (const dir of ["reports/agent_runs", "cover_letters"]) {
  await mkdir(resolve(root, dir), { recursive: true });
}

console.log("\nSetup complete. Edit config/candidate.json with your details, then: npm run dashboard");
