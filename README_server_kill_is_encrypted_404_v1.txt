PDFRealm - Kill /api/is-encrypted 404s (v1)

Symptom:
- Tool works, but console still shows:
  POST /api/is-encrypted 404

Cause:
- Some code path still calls /api/is-encrypted, but Express is returning 404
  (route shadowed, wrong method, middleware order, or duplicate server versions).

Fix:
- Adds an EARLY app.all("/api/is-encrypted", ...) handler right after app creation.
- Guarantees 200 for GET/OPTIONS/POST so you never see 404 noise again.
- POST continues to correctly detect encryption via pdf-lib, but fails open on errors.

Install:
  cd ~/Desktop/projects/pdfrealm
  unzip -o ~/Downloads/pdfrealm_server_kill_is_encrypted_404_v1.zip
  cp -v server.js server.js.bak_kill_is_encrypted_404_v1
  node patch_server_kill_is_encrypted_404_v1.mjs server.js
  node --check server.js
  node server.js
