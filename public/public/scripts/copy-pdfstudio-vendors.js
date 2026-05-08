/**
 * Copy PDFStudio vendor files from node_modules into public/vendor.
 *
 * Usage:
 *   node scripts/copy-pdfstudio-vendors.js
 */
const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source file: ${src}`);
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log("Copied:", src, "->", dst);
}

function projectRoot() {
  // scripts/ -> project root
  return path.resolve(__dirname, "..");
}

function main() {
  const root = projectRoot();
  const nm = path.join(root, "node_modules");
  const out = path.join(root, "public", "vendor");

  // ---- PDF.js (pdfjs-dist) ----
  // pdfjs-dist v4+ ships ESM bundles in build/ or legacy/build/
  // We'll prefer ESM `build/pdf.min.mjs` + `build/pdf.worker.min.mjs`,
  // and fall back to `legacy/build/` if needed.
  const pdfjsCandidates = [
    { pdf: path.join(nm, "pdfjs-dist", "build", "pdf.min.mjs"),
      worker: path.join(nm, "pdfjs-dist", "build", "pdf.worker.min.mjs") },
    { pdf: path.join(nm, "pdfjs-dist", "legacy", "build", "pdf.min.mjs"),
      worker: path.join(nm, "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs") },
  ];

  let pdfjsPick = null;
  for (const c of pdfjsCandidates) {
    if (fs.existsSync(c.pdf) && fs.existsSync(c.worker)) {
      pdfjsPick = c;
      break;
    }
  }
  if (!pdfjsPick) {
    throw new Error(
      "Could not find pdfjs-dist ESM bundles. " +
      "Make sure `npm install pdfjs-dist` succeeded."
    );
  }

  copyFile(pdfjsPick.pdf, path.join(out, "pdfjs", "pdf.min.mjs"));
  copyFile(pdfjsPick.worker, path.join(out, "pdfjs", "pdf.worker.min.mjs"));

  // Optional: cmaps and standard fonts (recommended for full fidelity)
  // If present, copy directories.
  const cMapSrc = path.join(nm, "pdfjs-dist", "cmaps");
  const stdFontsSrc = path.join(nm, "pdfjs-dist", "standard_fonts");
  const copyDir = (srcDir, dstDir) => {
    if (!fs.existsSync(srcDir)) return;
    ensureDir(dstDir);
    for (const entry of fs.readdirSync(srcDir)) {
      const s = path.join(srcDir, entry);
      const d = path.join(dstDir, entry);
      const st = fs.statSync(s);
      if (st.isDirectory()) copyDir(s, d);
      else copyFile(s, d);
    }
  };
  copyDir(cMapSrc, path.join(out, "pdfjs", "cmaps"));
  copyDir(stdFontsSrc, path.join(out, "pdfjs", "standard_fonts"));

  // ---- Fabric.js ----
  // fabric v6+ provides dist in `dist/index.min.js` (ESM) AND sometimes `dist/fabric.min.js` (UMD).
  // We’ll try common paths and write a single `fabric.min.js` for browser use.
  const fabricCandidates = [
    path.join(nm, "fabric", "dist", "fabric.min.js"),
    path.join(nm, "fabric", "dist", "index.min.js"),
  ];
  const fabricSrc = fabricCandidates.find(p => fs.existsSync(p));
  if (!fabricSrc) {
    throw new Error("Could not find Fabric dist file. Make sure `npm install fabric` succeeded.");
  }
  copyFile(fabricSrc, path.join(out, "fabric", "fabric.min.js"));

  // ---- pdf-lib ----
  const pdfLibCandidates = [
    path.join(nm, "pdf-lib", "dist", "pdf-lib.min.js"),
    path.join(nm, "pdf-lib", "dist", "pdf-lib.min.cjs"),
    path.join(nm, "pdf-lib", "dist", "pdf-lib.min.mjs"),
  ];
  const pdfLibSrc = pdfLibCandidates.find(p => fs.existsSync(p));
  if (!pdfLibSrc) {
    throw new Error("Could not find pdf-lib dist file. Make sure `npm install pdf-lib` succeeded.");
  }
  // Normalize to .js for browser script tag; if it's .mjs it still works as module, but we keep name stable.
  copyFile(pdfLibSrc, path.join(out, "pdf-lib", "pdf-lib.min.js"));

  console.log("\n✅ Vendor files are ready under: public/vendor/");
  console.log("   - /vendor/pdfjs/pdf.min.mjs");
  console.log("   - /vendor/pdfjs/pdf.worker.min.mjs");
  console.log("   - /vendor/fabric/fabric.min.js");
  console.log("   - /vendor/pdf-lib/pdf-lib.min.js");
}

main();
