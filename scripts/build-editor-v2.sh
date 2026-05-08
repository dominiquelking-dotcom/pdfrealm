#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="public/assets/editor-v2.js"
APP="public/assets/editor-app.js"

if [ ! -f "$APP" ]; then
  echo "Missing $APP"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
import glob, sys

def pick(patterns):
    for pat in patterns:
        c = glob.glob(pat, recursive=True)
        if c:
            return c[0]
    return None

pdfjs = pick([
    "**/node_modules/**/pdfjs-dist/legacy/build/pdf.min.js",
    "**/node_modules/**/pdfjs-dist/build/pdf.min.js",
])
pdflib = pick([
    "**/node_modules/**/pdf-lib/dist/pdf-lib.min.js",
    "**/node_modules/**/pdf-lib/dist/pdf-lib.js",
])
jszip = pick([
    "**/node_modules/**/jszip/dist/jszip.min.js",
])

if not pdfjs:
    print("ERROR: pdfjs-dist pdf.min.js not found. Run: npm i pdfjs-dist", file=sys.stderr); sys.exit(1)
if not pdflib:
    print("ERROR: pdf-lib dist not found. Run: npm i pdf-lib", file=sys.stderr); sys.exit(1)
if not jszip:
    print("ERROR: jszip.min.js not found. Run: npm i jszip", file=sys.stderr); sys.exit(1)

pdfjs_txt = Path(pdfjs).read_text(encoding="utf-8", errors="ignore")
pdflib_txt = Path(pdflib).read_text(encoding="utf-8", errors="ignore")
jszip_txt = Path(jszip).read_text(encoding="utf-8", errors="ignore")
app_txt = Path("public/assets/editor-app.js").read_text(encoding="utf-8", errors="ignore")

# HARD semicolon boundaries between bundles + app to prevent "expected expression, got const"
rebuilt = (
    ";\n"
    "/*__PDFJS_BUNDLE_BEGIN__*/\n" + pdfjs_txt + "\n/*__PDFJS_BUNDLE_END__*/\n;\n"
    "/*__PDFLIB_BUNDLE_BEGIN__*/\n" + pdflib_txt + "\n/*__PDFLIB_BUNDLE_END__*/\n;\n"
    "/*__JSZIP_BUNDLE_BEGIN__*/\n" + jszip_txt + "\n/*__JSZIP_BUNDLE_END__*/\n;\n"
    + (app_txt.lstrip() if app_txt.lstrip().startswith(";") else ";\n" + app_txt.lstrip())
)

Path("public/assets/editor-v2.js").write_text(rebuilt, encoding="utf-8")
print("rebuilt public/assets/editor-v2.js")
print("pdfjs:", pdfjs)
print("pdflib:", pdflib)
print("jszip:", jszip)
PY
