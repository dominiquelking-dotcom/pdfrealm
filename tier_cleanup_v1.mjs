#!/usr/bin/env node
import fs from "fs";

const appPath = "public/app.js";
const htmlPath = "public/index.html";

function cleanAppJs(src) {
  // Remove any previous injected tier blocks (best-effort)
  // - deletes blocks with START/END markers that are NOT FINAL_V1
  src = src.replace(
    /\/\*\s*={2,}\s*PDFREALM_TIER_[A-Z0-9_]+_START\s*={2,}\s*\*\/[\s\S]*?\/\*\s*={2,}\s*PDFREALM_TIER_[A-Z0-9_]+_END\s*={2,}\s*\*\//g,
    (block) => (block.includes("PDFREALM_TIER_FINAL_V1_START") ? block : "")
  );

  // Remove older tier patch markers that might not have START/END wrappers
  const killMarkers = [
    "PDFREALM_TIER_FILTER_V1",
    "PDFREALM_TIER_TABS_FILTER_RUNTIME_V5",
    "PDFREALM_TIER_DEDUPE_FILTER_V1",
    "PDFREALM_TIER_TABS_SIDEBAR_HEADER",
    "PDFREALM_TIER_FILTER_FORCE",
    "PDFREALM_TIER_TABS_PATCH",
    "PDFREALM_TIERBAR",
  ];

  // If any of these appear AFTER the FINAL block, strip from the earliest one to end
  const finalIdx = src.indexOf("PDFREALM_TIER_FINAL_V1_START");
  let cut = -1;
  for (const m of killMarkers) {
    const i = src.indexOf(m);
    if (i !== -1 && (finalIdx === -1 || i < finalIdx)) {
      cut = (cut === -1) ? i : Math.min(cut, i);
    }
  }

  // Only cut if it's clearly appended near the end (avoid deleting core app)
  if (cut !== -1 && cut > Math.floor(src.length * 0.60)) {
    src = src.slice(0, cut);
  }

  return src;
}

function cleanIndexHtml(src) {
  // Remove any static tier bar markup that earlier patches may have injected
  // (server HTML should NOT contain these strings; runtime injection will add them)
  const patterns = [
    /<div[^>]*(pdfrealm-tier-tabs|tier-tabs|tier-switcher)[^>]*>[\s\S]*?Secure Suite[\s\S]*?<\/div>/gi,
    /<button[^>]*>\s*Standard Tools[\s\S]*?<\/button>[\s\S]*?<button[^>]*>\s*Premium Tools[\s\S]*?<\/button>[\s\S]*?<button[^>]*>\s*Secure Suite[\s\S]*?<\/button>/gi,
    /Standard Tools[\s\S]{0,400}Premium Tools[\s\S]{0,400}Secure Suite/gi,
  ];

  let out = src;
  for (const re of patterns) out = out.replace(re, "");
  return out;
}

const app = fs.readFileSync(appPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");

const appClean = cleanAppJs(app);
const htmlClean = cleanIndexHtml(html);

fs.writeFileSync(appPath, appClean, "utf8");
fs.writeFileSync(htmlPath, htmlClean, "utf8");

console.log("[cleanup] cleaned:", appPath, "and", htmlPath);
console.log("[cleanup] Now re-apply your FINAL tier patch (PDFREALM_TIER_FINAL_V1) if needed.");
