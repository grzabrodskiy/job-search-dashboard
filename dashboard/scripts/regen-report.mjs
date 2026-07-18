// One-off: regenerate reports/search_results.md from tracking/search_results.json
// using the SAME generator the dashboard server uses, without hand-editing the report.
// It imports the generator by extracting the relevant functions from server.mjs so we
// never start the HTTP listener.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const serverSrc = readFileSync(resolve(here, "..", "server.mjs"), "utf8");

// Strip the HTTP server creation/listen tail so importing has no side effects.
const cutMarker = "const server = ";
const idx = serverSrc.indexOf(cutMarker);
const safeSrc = (idx >= 0 ? serverSrc.slice(0, idx) : serverSrc) +
  "\nexport { generateMarkdown };\n";

// Write the extracted module to a throwaway file in the OS temp dir (not in the
// repo) and remove it after import, so this utility leaves nothing behind.
const tmpPath = resolve(tmpdir(), `regen_report_${process.pid}_${Date.now()}.mjs`);
writeFileSync(tmpPath, safeSrc, "utf8");
try {
  const mod = await import(pathToFileURL(tmpPath).href);
  const data = JSON.parse(readFileSync(resolve(root, "tracking/search_results.json"), "utf8"));
  const md = mod.generateMarkdown(data);
  writeFileSync(resolve(root, "reports/search_results.md"), md, "utf8");
  console.log("regenerated reports/search_results.md, length", md.length);
} finally {
  try { unlinkSync(tmpPath); } catch { /* already gone */ }
}
