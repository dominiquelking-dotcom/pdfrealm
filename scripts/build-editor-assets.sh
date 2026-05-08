#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="public/assets/editor-vendor.js"
APP="public/assets/editor-app.js"

if [ ! -f "$APP" ]; then
  echo "Missing $APP"
  exit 1
fi

# Pick vendor files (prefer legacy pdfjs)
PDFJS="$(find node_modules -type f \( \
  -path "*/pdfjs-dist/legacy/build/pdf.min.js" -o \
  -path "*/pdfjs-dist/build/pdf.min.js" \
\) 2>/dev/null | head -n 1)"

PDFLIB="$(find node_modules -type f \( \
  -path "*/pdf-lib/dist/pdf-lib.min.js" -o \
  -path "*/pdf-lib/dist/pdf-lib.js" \
\) 2>/dev/null | head -n 1)"

JSZIP="$(find node_modules -type f -path "*/jszip/dist/jszip.min.js" 2>/dev/null | head -n 1)"

if [ -z "${PDFJS:-}" ]; then echo "pdfjs-dist not found (npm i pdfjs-dist)"; exit 1; fi
if [ -z "${PDFLIB:-}" ]; then echo "pdf-lib not found (npm i pdf-lib)"; exit 1; fi
if [ -z "${JSZIP:-}" ]; then echo "jszip not found (npm i jszip)"; exit 1; fi

# Build vendor with HARD semicolon boundaries (prevents 'expected expression, got const')
{
  printf ';\n'
  printf '/*__PDFJS_BUNDLE_BEGIN__*/\n'
  cat "$PDFJS"
  printf '\n/*__PDFJS_BUNDLE_END__*/\n;\n'

  printf '/*__PDFLIB_BUNDLE_BEGIN__*/\n'
  cat "$PDFLIB"
  printf '\n/*__PDFLIB_BUNDLE_END__*/\n;\n'

  printf '/*__JSZIP_BUNDLE_BEGIN__*/\n'
  cat "$JSZIP"
  printf '\n/*__JSZIP_BUNDLE_END__*/\n;\n'
} > "$OUT"

echo "Built $OUT"
echo "  pdfjs:  $PDFJS"
echo "  pdflib: $PDFLIB"
echo "  jszip:  $JSZIP"
