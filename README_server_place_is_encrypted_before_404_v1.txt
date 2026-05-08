PDFRealm - Fix /api/is-encrypted still 404 (v1)

You verified:
- POST /api/is-encrypted is still returning 404 (text/html), even though tools work.

That means the route isn't being hit at all (not registered, or registered AFTER a 404 catch-all).

This patch:
- Inserts an app.all("/api/is-encrypted") handler BEFORE the first 404 middleware (or before app.listen).
- Guarantees 200 for POST/GET/OPTIONS so you never see 404 noise again.

Install:
  cd ~/Desktop/projects/pdfrealm
  unzip -o ~/Downloads/pdfrealm_server_place_is_encrypted_before_404_v1.zip
  cp -v server.js server.js.bak_place_is_encrypted_before_404_v1
  node patch_server_place_is_encrypted_before_404_v1.mjs server.js
  node --check server.js
  node server.js

Verify:
- Network POST /api/is-encrypted should be 200 with JSON (not 404 text/html).
