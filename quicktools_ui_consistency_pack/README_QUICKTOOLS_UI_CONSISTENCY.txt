PDFRealm — QuickTools UI Consistency Pack

What this pack does
- Normalizes Decrypt / Unlock UI styling (fixes remaining btn-outline unlock buttons)
- Adds Decrypt / Unlock support to Compare PDFs (client-side, server decrypt via /api/decrypt)
- Makes Pop-out Preview universal:
  - Auto-adds a Pop-out button to any iframe preview inside .viewer-card (Merge/Split/etc)
  - Adds Pop-out support for image previews (Delete / Rotate)
  - Adds Pop-out support for canvas/composite previews (Quick Sign / Redact)
- Upgrades legacy preview-card blocks (Repair / Blank / Resize) to standard viewer-card previews

Install
1) Put quicktools_ui_consistency_pack.zip in your project root (same folder as server.js).
2) Stop the server.
3) Backup:
   mkdir -p backups/qt_ui_consistency_$(date +%F_%H%M)
   cp public/index.html public/app.js backups/qt_ui_consistency_$(date +%F_%H%M)/
4) Unzip into the project root:
   unzip -o quicktools_ui_consistency_pack.zip -d .
5) Apply:
   node patch_quicktools_ui_consistency.mjs
6) Sanity:
   node --check public/app.js
   grep -n "compareUnlockABtn" public/index.html | head
   grep -n "Auto-add Pop-out" public/index.html | head
7) Start:
   node server.js

Notes
- Hard refresh the browser after deploying (Ctrl+Shift+R).
- If you use a different web root (not /public), you can pass file paths:
    node patch_quicktools_ui_consistency.mjs path/to/index.html path/to/app.js
