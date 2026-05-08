;
(() => {
  const $ = (id) => document.getElementById(id);

  const hud = $("hud");
  const docName = $("docName");
  const fileInput = $("fileInput");
  const pdfFrame = document.getElementById("nativePdf");

  const zoomInBtn = $("zoomIn");
  const zoomOutBtn = $("zoomOut");
  const fitWidthBtn = $("fitWidth");

  const toolButtons = Array.from(document.querySelectorAll("button.tool"));

  const state = { tool: "select", url: null, zoom: 1.0 };

  const log = (m) => (hud.textContent = m);

  function setTool(t){
    state.tool = t;
    toolButtons.forEach(b => b.classList.toggle("active", b.dataset.tool === t));
    log(`Tool: ${t} (native preview)`);
  }

  function setZoom(z){
    state.zoom = Math.max(0.25, Math.min(4, z));
    if (!state.url) return;
    const base = state.url.split("#")[0];
    // Chrome/Edge generally respect #zoom=; Firefox may ignore—fine for now.
    pdfFrame.src = `${base}#zoom=${Math.round(state.zoom * 100)}`;
    log(`Zoom: ${Math.round(state.zoom * 100)}% (native viewer)`);
  }

  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;

    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(f);

    docName.textContent = f.name;
    pdfFrame.src = `${state.url}#view=FitH`;
    log("Loaded (native preview).");
  });

  zoomInBtn.addEventListener("click", () => setZoom(state.zoom * 1.15));
  zoomOutBtn.addEventListener("click", () => setZoom(state.zoom / 1.15));
  fitWidthBtn.addEventListener("click", () => {
    if (!state.url) return;
    const base = state.url.split("#")[0];
    pdfFrame.src = `${base}#view=FitH`;
    log("Fit width (native viewer).");
  });

  toolButtons.forEach(btn => btn.addEventListener("click", () => setTool(btn.dataset.tool)));

  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (k === "v") { setTool("select"); return; }
    });

  // =========================
  // Secure Redact (Rasterize) + Verify
  // =========================
  const pgSecureRaster = document.getElementById("pgSecureRaster");
  const pgVerifyRaster = document.getElementById("pgVerifyRaster");

  function _downloadBytes(bytes, filename, mime="application/pdf") {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function _b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function buildRasterPdfBytes({ jpeg=false, jpegQuality=0.92 } = {}) {
    if (!state.pdfBytes || !window.PDFLib) throw new Error("No PDF loaded (or PDFLib missing).");

    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(state.pdfBytes);
    const out = await PDFDocument.create();

    const pageCount = src.getPageCount();

    for (let pn = 1; pn <= pageCount; pn++) {
      // Make sure the visible canvases exist and are rendered
      const info = state.pages && state.pages.get ? state.pages.get(pn) : null;
      if (typeof renderPage === "function") {
        try { await renderPage(pn); } catch {}
      }
      if (!info || !info.renderCanvas) throw new Error("Missing page canvases; scroll to render pages first.");

      const rc = info.renderCanvas;
      const oc = info.overlayCanvas;

      // Composite (render + overlay) at current viewer resolution
      const cc = document.createElement("canvas");
      cc.width = rc.width;
      cc.height = rc.height;
      const cctx = cc.getContext("2d");
      cctx.drawImage(rc, 0, 0);
      if (oc && oc.width === rc.width && oc.height === rc.height) cctx.drawImage(oc, 0, 0);

      const dataUrl = cc.toDataURL(jpeg ? "image/jpeg" : "image/png", jpeg ? jpegQuality : undefined);
      const b64 = (dataUrl.split(",")[1] || "");
      const imgBytes = _b64ToU8(b64);

      const pageSize = src.getPage(pn - 1).getSize(); // points
      const page = out.addPage([pageSize.width, pageSize.height]);

      const embedded = jpeg ? await out.embedJpg(imgBytes) : await out.embedPng(imgBytes);
      page.drawImage(embedded, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });

      // small yield so UI stays responsive
      if (pn % 2 === 0) await new Promise(r => setTimeout(r, 0));
    }

    return await out.save({ useObjectStreams: true });
  }

  async function verifyPdfBytesText(bytes, needles=[]) {
    const lib = (typeof pdfjs === "function") ? pdfjs() : window.pdfjsLib;
    if (!lib) throw new Error("pdfjsLib missing; cannot verify.");
    const task = lib.getDocument({ data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), disableWorker: true });
    const pdf = await task.promise;

    const lowers = (needles || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
    let anyText = false;
    const hits = [];

    for (let pn = 1; pn <= pdf.numPages; pn++) {
      const page = await pdf.getPage(pn);
      const tc = await page.getTextContent();
      const text = (tc.items || []).map(it => (it && it.str) ? it.str : "").join(" ").replace(/\s+/g," ").trim();
      if (text.length > 0) anyText = true;

      const low = text.toLowerCase();
      for (const n of lowers) {
        if (n && low.includes(n)) hits.push({ needle: n, page: pn });
      }
    }

    return { anyText, hits };
  }

  if (pgSecureRaster) {
    pgSecureRaster.addEventListener("click", async (e) => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        // Tip: user can set zoom higher before raster export for higher DPI.
        log("Secure Redact (Rasterize): building image-only PDF…\nTip: increase zoom before export for higher resolution.\n(Shift-click to export JPEG instead of PNG.)");

        const jpeg = !!e.shiftKey;
        const outBytes = await buildRasterPdfBytes({ jpeg, jpegQuality: 0.90 });

        const base = (state.fileName || "document.pdf").replace(/\.pdf$/i, "");
        const outName = `${base}-secure-redact-${jpeg ? "jpg" : "png"}.pdf`;
        _downloadBytes(outBytes, outName);

        // auto-verify: should have no extracted text
        const v = await verifyPdfBytesText(outBytes, []);
        if (!v.anyText && (!v.hits || v.hits.length === 0)) {
          log("✅ Secure Redact export complete.\nVerify: extracted text is empty (image-only PDF).");
        } else {
          log("⚠️ Export complete, but verify saw extracted text.\nThis should be rare; check the output PDF.\n(If this persists, we’ll switch to full raster rebuild per page via pdf.js render).");
        }
      } catch (err) {
        console.error(err);
        log(String(err && err.message ? err.message : err));
      }
    });
  }

  if (pgVerifyRaster) {
    pgVerifyRaster.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }
        const raw = (document.getElementById("verifyStrings")?.value || "").trim();
        const needles = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
        log("Verifying raster export (build + scan)…");
        const outBytes = await buildRasterPdfBytes({ jpeg: false });
        const v = await verifyPdfBytesText(outBytes, needles);
        if (!v.anyText && (!v.hits || v.hits.length === 0)) {
          log("✅ Verify passed: extracted text is empty and no needle strings found.");
        } else {
          const lines = [];
          if (v.anyText) lines.push("❌ Extracted text was present (not fully image-only).");
          if (v.hits && v.hits.length) {
            for (const h of v.hits.slice(0, 40)) lines.push(`❌ FOUND "${h.needle}" on page ${h.page}`);
          }
          log(lines.join("\n"));
        }
      } catch (err) {
        console.error(err);
        log(String(err && err.message ? err.message : err));
      }
    });
  }


  
  // =========================
  // Autosave (IndexedDB) + Restore
  // =========================
  const saveStatus = document.getElementById("saveStatus");
  const restoreLastBtn = document.getElementById("restoreLast");

  function setSaveStatus(txt){ if (saveStatus) saveStatus.textContent = txt; }

  function openEditorDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("pdfrealm_editor_v1", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(key, value) {
    const db = await openEditorDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await openEditorDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function _annEntriesSafe() {
    try {
      if (state.ann && typeof state.ann.entries === "function") return Array.from(state.ann.entries());
      return [];
    } catch { return []; }
  }

  function _countMarks() {
    try {
      let n = 0;
      for (const [,arr] of _annEntriesSafe()) n += (arr && arr.length) ? arr.length : 0;
      return n;
    } catch { return 0; }
  }

  let _lastSig = "";
  let _saving = false;
  let _pending = false;

  function _calcSig() {
    const bytes = state.pdfBytes ? state.pdfBytes.byteLength : 0;
    const marks = _countMarks();
    const scale = state.scale || 0;
    return `${bytes}:${marks}:${scale}`;
  }

  async function saveNow() {
    if (!state.pdfBytes) { setSaveStatus("Not saved"); return; }
    if (_saving) { _pending = true; return; }
    _saving = true;
    setSaveStatus("Saving…");
    try {
      const payload = {
        v: 1,
        ts: Date.now(),
        fileName: state.fileName || "document.pdf",
        scale: state.scale || 1.25,
        pdfBytes: state.pdfBytes,                 // Uint8Array
        annotations: _annEntriesSafe(),           // [[pageNum, [...]]]
      };
      await idbPut("last", payload);
      setSaveStatus("Saved");
    } catch (e) {
      console.error(e);
      setSaveStatus("Save failed");
    } finally {
      _saving = false;
      if (_pending) { _pending = false; saveNow(); }
    }
  }

  async function restoreLast() {
    try {
      setSaveStatus("Restoring…");
      const payload = await idbGet("last");
      if (!payload || !payload.pdfBytes) { setSaveStatus("No save"); log("No autosave found."); return; }

      // reload PDF
      if (typeof reloadFromBytes === "function") {
        await reloadFromBytes(payload.pdfBytes, payload.fileName || "restored.pdf");
      } else if (typeof loadPdfFromFile === "function") {
        log("restore failed: reloadFromBytes not found");
        setSaveStatus("Restore failed");
        return;
      }

      // restore scale if setter exists
      if (typeof setScale === "function" && payload.scale) {
        try { setScale(payload.scale); } catch {}
      } else if (payload.scale) {
        try { state.scale = payload.scale; } catch {}
      }

      // restore annotations AFTER reload
      try {
        state.ann = new Map(payload.annotations || []);
      } catch {}

      // redraw overlays if available
      try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}

      _lastSig = _calcSig();
      setSaveStatus("Saved");
      log("Restored last session.");
    } catch (e) {
      console.error(e);
      setSaveStatus("Restore failed");
      log("Restore failed.");
    }
  }

  if (restoreLastBtn) restoreLastBtn.addEventListener("click", restoreLast);

  // autosave poller (2s)
  setInterval(() => {
    try {
      if (!state.pdfBytes) return;
      const sig = _calcSig();
      if (sig !== _lastSig) {
        _lastSig = sig;
        saveNow();
      }
    } catch {}
  }, 2000);

  // =========================
  // Find (search extracted text) + flash match box
  // =========================
  const findQuery = document.getElementById("findQuery");
  const findPrev = document.getElementById("findPrev");
  const findNext = document.getElementById("findNext");
  const findClear = document.getElementById("findClear");
  const findResults = document.getElementById("findResults");

  const outlineLoad = document.getElementById("outlineLoad");
  const outlineList = document.getElementById("outlineList");

  const _find = { q: "", matches: [], idx: -1, cache: new Map() };

  function _scrollToPage(pn) {
    const info = state.pages && state.pages.get ? state.pages.get(pn) : null;
    if (info && info.wrap) info.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function _flashBBox(pageNum, bboxN) {
    const info = state.pages && state.pages.get ? state.pages.get(pageNum) : null;
    if (!info || !info.overlayCtx || !info.overlayCanvas) return;
    const ctx = info.overlayCtx;
    const w = info.overlayCanvas.width, h = info.overlayCanvas.height;
    const x = bboxN.x * w, y = bboxN.y * h, bw = bboxN.w * w, bh = bboxN.h * h;
    const t0 = Date.now();

    const draw = () => {
      const dt = Date.now() - t0;
      if (dt > 900) { try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); } catch {} return; }
      try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); } catch {}
      ctx.save();
      ctx.strokeStyle = "rgba(120,180,255,0.95)";
      ctx.lineWidth = 3;
      ctx.setLineDash([8,6]);
      ctx.strokeRect(x - 2, y - 2, bw + 4, bh + 4);
      ctx.restore();
      requestAnimationFrame(draw);
    };
    draw();
  }

  async function _textItemsForPage(pn) {
    if (_find.cache.has(pn)) return _find.cache.get(pn);

    const page = await state.pdf.getPage(pn);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items || []).map(it => {
      const str = (it && it.str) ? String(it.str) : "";
      // Compute approximate bbox in viewport coords
      // Use pdfjsLib.Util.transform if available, else fallback
      let x = 0, y = 0, w = (it && it.width) ? it.width : 0, h = 10;
      try {
        const Util = (window.pdfjsLib && window.pdfjsLib.Util) ? window.pdfjsLib.Util : null;
        const t = it.transform || [1,0,0,1,0,0];
        if (Util && viewport && viewport.transform) {
          const tt = Util.transform(viewport.transform, t);
          x = tt[4];
          y = tt[5];
          h = Math.hypot(tt[2], tt[3]) || h;
          // it.width is in text-space; in practice it usually maps OK for searching
          w = (it.width || 0);
        } else {
          x = t[4] || 0; y = t[5] || 0;
        }
      } catch {}
      // convert to top-left normalized bbox
      const yTop = viewport.height - y - h;
      const bboxN = {
        x: Math.max(0, Math.min(1, x / viewport.width)),
        y: Math.max(0, Math.min(1, yTop / viewport.height)),
        w: Math.max(0.002, Math.min(1, (w / viewport.width))),
        h: Math.max(0.01, Math.min(1, (h / viewport.height))),
      };
      return { str, bboxN };
    });

    _find.cache.set(pn, items);
    return items;
  }

  async function runFind(q) {
    q = String(q || "").trim();
    _find.q = q;
    _find.matches = [];
    _find.idx = -1;
    _find.cache.clear();

    if (findResults) findResults.innerHTML = "";

    if (!q) { log("Find cleared."); return; }
    if (!state.pdf) { log("Load a PDF first."); return; }

    const needle = q.toLowerCase();
    log("Searching…");

    for (let pn = 1; pn <= state.pdf.numPages; pn++) {
      const items = await _textItemsForPage(pn);
      for (const it of items) {
        if (!it.str) continue;
        if (it.str.toLowerCase().includes(needle)) {
          _find.matches.push({ page: pn, bboxN: it.bboxN, text: it.str });
        }
      }
      if (pn % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }

    if (!_find.matches.length) {
      log(`No matches for "${q}".`);
      return;
    }

    if (findResults) {
      const cap = Math.min(30, _find.matches.length);
      for (let i = 0; i < cap; i++) {
        const m = _find.matches[i];
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `p${m.page}: ${m.text.slice(0, 60)}`;
        b.onclick = () => {
          _find.idx = i;
          _scrollToPage(m.page);
          _flashBBox(m.page, m.bboxN);
          log(`Match ${i+1}/${_find.matches.length} on page ${m.page}`);
        };
        findResults.appendChild(b);
      }
      if (_find.matches.length > cap) {
        const note = document.createElement("small");
        note.textContent = `Showing first ${cap} results (use Next/Prev for more).`;
        findResults.appendChild(note);
      }
    }

    _find.idx = 0;
    const m = _find.matches[0];
    _scrollToPage(m.page);
    _flashBBox(m.page, m.bboxN);
    log(`Match 1/${_find.matches.length} on page ${m.page}`);
  }

  function findStep(dir) {
    if (!_find.matches.length) return;
    _find.idx = (_find.idx + dir + _find.matches.length) % _find.matches.length;
    const m = _find.matches[_find.idx];
    _scrollToPage(m.page);
    _flashBBox(m.page, m.bboxN);
    log(`Match ${_find.idx+1}/${_find.matches.length} on page ${m.page}`);
  }

  if (findQuery) {
    findQuery.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runFind(findQuery.value);
    });
  }
  if (findNext) findNext.addEventListener("click", () => findStep(+1));
  if (findPrev) findPrev.addEventListener("click", () => findStep(-1));
  if (findClear) findClear.addEventListener("click", () => {
    if (findQuery) findQuery.value = "";
    _find.q = ""; _find.matches = []; _find.idx = -1; _find.cache.clear();
    if (findResults) findResults.innerHTML = "";
    log("Find cleared.");
  });

  // =========================
  // Outline (bookmarks)
  // =========================
  async function loadOutline() {
    if (!state.pdf || !outlineList) { log("Load a PDF first."); return; }
    outlineList.innerHTML = "";
    log("Loading outline…");
    let ol = null;
    try { ol = await state.pdf.getOutline(); } catch {}
    if (!ol || !ol.length) { log("No outline/bookmarks found."); return; }

    async function destToPage(dest) {
      try {
        if (typeof dest === "string") dest = await state.pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          // dest[0] is a ref
          const idx = await state.pdf.getPageIndex(dest[0]);
          return (idx + 1);
        }
      } catch {}
      return null;
    }

    async function renderItems(items, depth=0) {
      for (const it of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.style.textAlign = "left";
        row.style.paddingLeft = (8 + depth * 14) + "px";
        row.textContent = it.title || "(untitled)";
        row.onclick = async () => {
          const pn = await destToPage(it.dest);
          if (pn) {
            _scrollToPage(pn);
            log(`Outline → page ${pn}`);
          } else {
            log("Outline item has no resolvable page.");
          }
        };
        outlineList.appendChild(row);
        if (it.items && it.items.length) await renderItems(it.items, depth+1);
      }
    }

    await renderItems(ol, 0);
    log("Outline loaded.");
  }

  if (outlineLoad) outlineLoad.addEventListener("click", loadOutline);


  
  // =========================
  // Project Export/Import (.pdrm.json) + Clipboard + Nudge
  // =========================
  const exportProjectBtn = document.getElementById("exportProject");
  const importProjectInput = document.getElementById("importProject");
  const importProjectBtn = document.getElementById("importProjectBtn");

  const copyObjBtn = document.getElementById("copyObj");
  const pasteObjBtn = document.getElementById("pasteObj");
  const dupObjBtn = document.getElementById("dupObj");

  const __uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const __clone = (o) => JSON.parse(JSON.stringify(o));

  function u8ToB64(u8) {
    // chunked to avoid call stack / huge string issues
    const CH = 0x8000;
    let s = "";
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function __download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function __annEntries() {
    try {
      if (state.ann && typeof state.ann.entries === "function") return Array.from(state.ann.entries());
    } catch {}
    return [];
  }

  async function exportProject() {
    try {
      if (!state.pdfBytes) { log("Load a PDF first."); return; }
      const payload = {
        v: 1,
        kind: "pdfrealm_project",
        ts: Date.now(),
        fileName: state.fileName || "document.pdf",
        scale: state.scale || 1.25,
        pdfBytesB64: u8ToB64(state.pdfBytes),
        annotations: __annEntries()
      };
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const base = String(payload.fileName).replace(/\.pdf$/i, "");
      __download(blob, `${base}.pdrm.json`);
      log("Exported project (.pdrm.json).");
    } catch (e) {
      console.error(e);
      log("Project export failed.");
    }
  }

  async function importProjectFile(file) {
    const txt = await file.text();
    const payload = JSON.parse(txt);

    if (!payload || payload.kind !== "pdfrealm_project" || !payload.pdfBytesB64) {
      log("Not a valid .pdrm.json project.");
      return;
    }

    const bytes = b64ToU8(payload.pdfBytesB64);
    const name = payload.fileName || "imported.pdf";

    if (typeof reloadFromBytes !== "function") {
      log("Import failed: reloadFromBytes not found.");
      return;
    }

    log("Importing project…");
    await reloadFromBytes(bytes, name);

    // restore scale if setter exists
    if (typeof setScale === "function" && payload.scale) {
      try { setScale(payload.scale); } catch {}
    } else {
      try { state.scale = payload.scale || state.scale; } catch {}
    }

    // restore annotations
    try { state.ann = new Map(payload.annotations || []); } catch {}
    try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}

    log("Imported project.");
  }

  if (exportProjectBtn) exportProjectBtn.addEventListener("click", exportProject);
  if (importProjectBtn && importProjectInput) importProjectBtn.addEventListener("click", () => importProjectInput.click());
  if (importProjectInput) importProjectInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { await importProjectFile(f); } catch (err) { console.error(err); log("Project import failed."); }
    e.target.value = "";
  });

  // ---------- Clipboard ----------
  state.__clipboard = state.__clipboard || null;

  function getSelected() {
    if (typeof getSelectedAnn === "function") return getSelectedAnn();
    if (!state.selected) return null;
    const { pageNum, id } = state.selected;
    try {
      const list = (typeof annList === "function") ? annList(pageNum) : (state.ann.get(pageNum) || []);
      return list.find(a => a.id === id) || null;
    } catch { return null; }
  }

  function _clampBbox(b) {
    if (typeof clampBbox === "function") return clampBbox(b);
    const x = Math.max(0, Math.min(1, b.x));
    const y = Math.max(0, Math.min(1, b.y));
    const w = Math.max(0.001, Math.min(1 - x, b.w));
    const h = Math.max(0.001, Math.min(1 - y, b.h));
    return { x, y, w, h };
  }

  function copySelected() {
    const a = getSelected();
    if (!a || !state.selected) { log("Nothing selected."); return; }
    state.__clipboard = {
      ann: __clone(a),
      pageNum: state.selected.pageNum
    };
    log("Copied.");
  }

  function pasteClipboard({ duplicate=false } = {}) {
    const clip = state.__clipboard;
    if (!clip || !clip.ann) { log("Clipboard empty."); return; }
    const pageNum = (state.selected && state.selected.pageNum) ? state.selected.pageNum : clip.pageNum;
    const a = __clone(clip.ann);
    a.id = __uid();
    a.pageNum = pageNum;

    // offset so paste is visible
    const dx = 0.01, dy = 0.01;

    if (a.type === "ink" && Array.isArray(a.points)) {
      a.points = a.points.map(p => ({ xN: p.xN + dx, yN: p.yN + dy }));
      if (typeof bboxFromPoints === "function") a.bboxN = bboxFromPoints(a.points);
      else a.bboxN = _clampBbox({ ...a.bboxN, x: a.bboxN.x + dx, y: a.bboxN.y + dy });
    } else if (a.bboxN) {
      a.bboxN = _clampBbox({ ...a.bboxN, x: a.bboxN.x + dx, y: a.bboxN.y + dy });
    }

    const list = (typeof annList === "function") ? annList(pageNum) : (state.ann.get(pageNum) || []);
    if (typeof annList !== "function" && !state.ann.has(pageNum)) state.ann.set(pageNum, list);
    list.push(a);

    if (typeof pushOp === "function") pushOp({ type: "add", pageNum, ann: __clone(a) });

    state.selected = { pageNum, id: a.id };
    try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); else if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}

    log(duplicate ? "Duplicated." : "Pasted.");
  }

  function duplicateSelected() {
    const a = getSelected();
    if (!a) { log("Nothing selected."); return; }
    state.__clipboard = { ann: __clone(a), pageNum: state.selected.pageNum };
    pasteClipboard({ duplicate: true });
  }

  if (copyObjBtn) copyObjBtn.addEventListener("click", copySelected);
  if (pasteObjBtn) pasteObjBtn.addEventListener("click", () => pasteClipboard({ duplicate: false }));
  if (dupObjBtn) dupObjBtn.addEventListener("click", duplicateSelected);

  // ---------- Nudge with arrow keys ----------
  function nudgeSelected(dx, dy) {
    const a = getSelected();
    if (!a || !state.selected) return;
    const { pageNum, id } = state.selected;

    const prev = __clone(a);
    const next = __clone(a);

    if (next.type === "ink" && Array.isArray(next.points)) {
      next.points = next.points.map(p => ({ xN: p.xN + dx, yN: p.yN + dy }));
      if (typeof bboxFromPoints === "function") next.bboxN = bboxFromPoints(next.points);
      else next.bboxN = _clampBbox({ ...next.bboxN, x: next.bboxN.x + dx, y: next.bboxN.y + dy });
    } else if (next.bboxN) {
      next.bboxN = _clampBbox({ ...next.bboxN, x: next.bboxN.x + dx, y: next.bboxN.y + dy });
    }

    if (typeof replaceAnn === "function") {
      replaceAnn(pageNum, id, next);
    } else {
      const list = (typeof annList === "function") ? annList(pageNum) : (state.ann.get(pageNum) || []);
      const idx = list.findIndex(x => x.id === id);
      if (idx >= 0) list[idx] = next;
    }

    if (typeof pushOp === "function") pushOp({ type: "update", pageNum, id, prev, next: __clone(next) });

    try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}
  }

  window.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    const isMac = /mac/i.test(navigator.platform);
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && !e.shiftKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelected(); return; }
    if (mod && !e.shiftKey && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard({ duplicate:false }); return; }
    if (mod && !e.shiftKey && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); return; }

    // nudge: arrows; faster with Shift
    const step = e.shiftKey ? 0.01 : 0.0025;
    if (e.key === "ArrowLeft")  { e.preventDefault(); nudgeSelected(-step, 0); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); nudgeSelected(step, 0); return; }
    if (e.key === "ArrowUp")    { e.preventDefault(); nudgeSelected(0, -step); return; }
    if (e.key === "ArrowDown")  { e.preventDefault(); nudgeSelected(0, step); return; }
  });


  
  // =========================
  // Merge PDFs + Pages → ZIP (JSZip)
  // =========================
  const mergePick = document.getElementById("mergePick");
  const mergeBtn  = document.getElementById("mergeBtn");
  const exportZipBtn = document.getElementById("exportZipBtn");
  const zipScope = document.getElementById("zipScope");
  const zipFormat = document.getElementById("zipFormat");

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function _baseName() {
    const n = (state && state.fileName) ? String(state.fileName) : "document.pdf";
    return n.replace(/\.pdf$/i, "");
  }

  async function _canvasToBlob(canvas, mime, quality) {
    return await new Promise((res) => canvas.toBlob((b) => res(b), mime, quality));
  }

  async function _compositeCanvasForPage(pn, includeMarks, mult) {
    if (typeof renderPage === "function") {
      try { await renderPage(pn); } catch {}
    }
    const info = state.pages && state.pages.get ? state.pages.get(pn) : null;
    if (!info || !info.renderCanvas) throw new Error("Page not rendered yet. Scroll to render pages first.");

    const rc = info.renderCanvas;
    const oc = info.overlayCanvas;

    const m = Math.max(0.5, Math.min(4, mult || 1));
    const w = Math.max(1, Math.round(rc.width * m));
    const h = Math.max(1, Math.round(rc.height * m));

    const cc = document.createElement("canvas");
    cc.width = w; cc.height = h;
    const ctx = cc.getContext("2d");
    ctx.drawImage(rc, 0, 0, w, h);

    if (includeMarks && oc && oc.width === rc.width && oc.height === rc.height) {
      ctx.drawImage(oc, 0, 0, w, h);
    }
    return cc;
  }

  async function exportPagesZip(includeMarks) {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }
    if (!window.JSZip) { log("JSZip missing (bundle failed)."); return; }

    const scope = zipScope ? zipScope.value : "selected";
    const fmt = zipFormat ? zipFormat.value : "png";

    let pages = [];
    if (scope === "selected" && state.pageSel && state.pageSel.size) {
      pages = Array.from(state.pageSel.values()).sort((a,b)=>a-b);
    } else if (state.pdf && state.pdf.numPages) {
      pages = Array.from({length: state.pdf.numPages}, (_,i)=>i+1);
    } else {
      log("No pages available.");
      return;
    }

    const multStr = prompt("Resolution multiplier (1 = current). 2 = higher quality (bigger zip).", "1");
    const mult = Math.max(0.5, Math.min(4, parseFloat(multStr || "1") || 1));

    const zip = new window.JSZip();
    const base = _baseName();
    log(`Building ZIP…\nPages: ${pages.length}\nFormat: ${fmt.toUpperCase()}\nInclude marks: ${includeMarks ? "yes" : "no"}\nMultiplier: ${mult}`);

    for (let i = 0; i < pages.length; i++) {
      const pn = pages[i];
      log(`ZIP: rendering page ${pn} (${i+1}/${pages.length})…`);

      const cc = await _compositeCanvasForPage(pn, includeMarks, mult);

      let blob;
      if (fmt === "jpg") blob = await _canvasToBlob(cc, "image/jpeg", 0.92);
      else blob = await _canvasToBlob(cc, "image/png");

      if (!blob) throw new Error("Failed to encode image.");

      const name = `${base}-p${String(pn).padStart(3,"0")}.${fmt}`;
      zip.file(name, blob);
      if ((i+1) % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }

    log("Compressing ZIP…");
    const out = await zip.generateAsync({ type: "blob" });
    _downloadBlob(out, `${base}-pages.zip`);
    log("✅ Downloaded pages ZIP.");
  }

  async function mergePdfs(files) {
    if (!files || !files.length) return;
    if (!state.pdfBytes || !window.PDFLib) { log("Load a base PDF first."); return; }
    const { PDFDocument } = window.PDFLib;

    log(`Merging ${files.length} PDF(s)…`);
    const baseDoc = await PDFDocument.load(state.pdfBytes);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      log(`Merging: ${f.name} (${i+1}/${files.length})…`);
      const u8 = new Uint8Array(await f.arrayBuffer());
      const doc = await PDFDocument.load(u8);
      const copied = await baseDoc.copyPages(doc, doc.getPageIndices());
      copied.forEach(p => baseDoc.addPage(p));
      if ((i+1) % 2 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const bytes = await baseDoc.save({ useObjectStreams: true });

    if (typeof reloadFromBytes === "function") {
      await reloadFromBytes(bytes, (state.fileName || "merged.pdf").replace(/\.pdf$/i,"") + "-merged.pdf");
    } else {
      // fallback: just download if reload isn't present
      _downloadBlob(new Blob([bytes], {type:"application/pdf"}), "merged.pdf");
      log("Merged and downloaded (reloadFromBytes missing).");
      return;
    }

    // structural change: safest to clear marks + history
    try { state.ann = new Map(); } catch {}
    try { state.undo.length = 0; state.redo.length = 0; } catch {}
    try { state.pageSel && state.pageSel.clear && state.pageSel.clear(); } catch {}
    try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}

    log("✅ Merge complete. (Marks cleared after merge.)");
  }

  if (mergeBtn && mergePick) {
    mergeBtn.addEventListener("click", () => mergePick.click());
    mergePick.addEventListener("change", async (e) => {
      const files = Array.from((e.target.files || [])).filter(f => f && /\.pdf$/i.test(f.name || ""));
      e.target.value = "";
      try { await mergePdfs(files); } catch (err) { console.error(err); log(String(err.message || err)); }
    });
  }

  if (exportZipBtn) {
    exportZipBtn.addEventListener("click", async (e) => {
      const includeMarks = !e.shiftKey; // shift-click = exclude overlay marks
      try { await exportPagesZip(includeMarks); } catch (err) { console.error(err); log(String(err.message || err)); }
    });
  }


  
  // =========================
  // CAPTURE override: OpLog v1 + Server Export Contract + Preserve Marks on Page Ops
  // =========================
  const opsCountEl = document.getElementById("opsCount");
  const exportContractBtn = document.getElementById("exportContract");
  const importContractInput = document.getElementById("importContract");
  const importContractBtn = document.getElementById("importContractBtn");
  const clearOpsBtn = document.getElementById("clearOps");

  function _setOpsCount() {
    try { if (opsCountEl) opsCountEl.textContent = `Ops: ${(state.oplog && state.oplog.length) ? state.oplog.length : 0}`; } catch {}
  }

  // ensure oplog + original bytes holder
  try { state.oplog = state.oplog || []; } catch {}
  try { state.__originalPdfBytes = state.__originalPdfBytes || null; } catch {}
  _setOpsCount();

  function _clone(x){ return JSON.parse(JSON.stringify(x)); }
  function _uid(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }

  function recordOp(kind, payload) {
    try {
      state.oplog.push({ kind, ts: Date.now(), ...(payload || {}) });
      _setOpsCount();
    } catch {}
  }

  // try to wrap reloadFromBytes to capture original PDF bytes once (first load)
  try {
    const __origReloadFromBytes = reloadFromBytes;
    reloadFromBytes = async function(bytes, fileName) {
      try {
        if (!state.__originalPdfBytes) {
          const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
          state.__originalPdfBytes = u8.slice ? u8.slice() : new Uint8Array(u8);
        }
      } catch {}
      return await __origReloadFromBytes(bytes, fileName);
    };
  } catch {}

  // try to wrap pushOp to log annotation ops (if pushOp is re-assignable)
  try {
    const __origPushOp = pushOp;
    pushOp = function(op) {
      try {
        if (op && op.type === "add") recordOp("ann_add", { pageNum: op.pageNum, ann: op.ann });
        else if (op && op.type === "del") recordOp("ann_del", { pageNum: op.pageNum, ann: op.ann });
        else if (op && op.type === "update") recordOp("ann_update", { pageNum: op.pageNum, id: op.id, prev: op.prev, next: op.next });
        else if (op && op.type === "clearAll") recordOp("ann_clear", {});
      } catch {}
      return __origPushOp(op);
    };
  } catch {}

  function u8ToB64(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }
  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function _downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportContract() {
    try {
      if (!state.pdfBytes) { log("Load a PDF first."); return; }
      const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
      const includeSnapshot = confirm("Include a snapshot of current marks for client restore?\n\nOK = include snapshot\nCancel = ops-only");
      const payload = {
        v: 1,
        kind: "pdfrealm_op_contract",
        ts: Date.now(),
        fileName: state.fileName || "document.pdf",
        originalPdfB64: u8ToB64(state.__originalPdfBytes || state.pdfBytes),
        ops: state.oplog || [],
        snapshot: includeSnapshot ? { annotations: (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [] } : null,
      };
      _downloadJson(payload, `${base}.contract.json`);
      log("Exported contract JSON.");
    } catch (e) {
      console.error(e);
      log("Export contract failed.");
    }
  }

  async function importContractFile(file) {
    const txt = await file.text();
    const payload = JSON.parse(txt);
    if (!payload || payload.kind !== "pdfrealm_op_contract") { log("Not a valid contract."); return; }
    const bytes = b64ToU8(payload.originalPdfB64 || "");
    try { state.__originalPdfBytes = bytes.slice ? bytes.slice() : new Uint8Array(bytes); } catch {}
    try { state.oplog = Array.isArray(payload.ops) ? payload.ops : []; } catch {}
    _setOpsCount();

    if (typeof reloadFromBytes !== "function") { log("Import failed: reloadFromBytes missing."); return; }
    log("Importing contract…");
    await reloadFromBytes(bytes, payload.fileName || "contract.pdf");

    if (payload.snapshot && payload.snapshot.annotations) {
      try { state.ann = new Map(payload.snapshot.annotations); } catch {}
      try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    }
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}
    log("Imported contract. (Ops loaded; snapshot applied if present.)");
  }

  if (exportContractBtn) exportContractBtn.addEventListener("click", exportContract);
  if (importContractBtn && importContractInput) importContractBtn.addEventListener("click", () => importContractInput.click());
  if (importContractInput) importContractInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { await importContractFile(f); } catch (err) { console.error(err); log("Import contract failed."); }
    e.target.value = "";
  });

  if (clearOpsBtn) clearOpsBtn.addEventListener("click", () => {
    try { state.oplog = []; } catch {}
    _setOpsCount();
    log("Cleared ops log.");
  });

  // -----------------------------
  // Preserve marks across page ops: transform annotation keys + selection
  // -----------------------------
  function _annEntries() {
    try { return (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : []; } catch { return []; }
  }
  function _setAnnMap(m) { try { state.ann = m; } catch {} }
  function _setSelSet(s) { try { state.pageSel = s; } catch {} }

  function _transformReorder(orderPages1Based) {
    const old = new Map(_annEntries()); // old key = old pageNum
    const next = new Map();
    const rev = new Map(); // old page -> new page
    for (let newPn = 1; newPn <= orderPages1Based.length; newPn++) {
      const oldPn = orderPages1Based[newPn - 1];
      rev.set(oldPn, newPn);
      next.set(newPn, old.get(oldPn) ? _clone(old.get(oldPn)) : []);
    }

    // selection remap
    const sel = new Set();
    try {
      if (state.pageSel && state.pageSel.size) {
        for (const oldPn of state.pageSel.values()) {
          const np = rev.get(oldPn);
          if (np) sel.add(np);
        }
      }
    } catch {}

    return { ann: next, sel };
  }

  function _transformDelete(pagesToDelete, totalPages) {
    const del = new Set(pagesToDelete);
    const old = new Map(_annEntries());
    const next = new Map();

    // prefix counts
    let deletedSoFar = 0;
    for (let oldPn = 1; oldPn <= totalPages; oldPn++) {
      if (del.has(oldPn)) { deletedSoFar++; continue; }
      const newPn = oldPn - deletedSoFar;
      next.set(newPn, old.get(oldPn) ? _clone(old.get(oldPn)) : []);
    }

    return { ann: next, sel: new Set() };
  }

  function _transformInsertBlank(beforePage, totalPages) {
    const old = new Map(_annEntries());
    const next = new Map();
    for (let oldPn = 1; oldPn <= totalPages; oldPn++) {
      const newPn = (oldPn >= beforePage) ? oldPn + 1 : oldPn;
      next.set(newPn, old.get(oldPn) ? _clone(old.get(oldPn)) : []);
    }
    // blank page gets empty list
    next.set(beforePage, []);
    return { ann: next, sel: new Set([beforePage]) };
  }

  function _transformDuplicate(selectedPages, totalPages) {
    const selSorted = [...selectedPages].sort((a,b)=>a-b);
    const selSet = new Set(selSorted);

    const old = new Map(_annEntries());
    const next = new Map();

    // count of selected pages before i
    function countBefore(i) {
      // selSorted is small; linear ok
      let c = 0;
      for (const p of selSorted) { if (p < i) c++; else break; }
      return c;
    }

    const newSel = new Set();

    for (let i = 1; i <= totalPages; i++) {
      const base = i + countBefore(i); // new index for original page i
      next.set(base, old.get(i) ? _clone(old.get(i)) : []);
      if (selSet.has(i)) {
        next.set(base + 1, old.get(i) ? _clone(old.get(i)) : []);
        newSel.add(base + 1); // select the duplicated copy
      }
    }

    return { ann: next, sel: newSel };
  }

  // parse pages from prompt: "1,3-5"
  function _parsePages(input, maxPages) {
    const out = new Set();
    const s = String(input || "").trim();
    if (!s) return out;
    for (const part of s.split(",")) {
      const t = part.trim();
      if (!t) continue;
      if (t.includes("-")) {
        const [a,b] = t.split("-").map(x => parseInt(x.trim(),10));
        if (!a || !b) continue;
        const lo = Math.max(1, Math.min(a,b));
        const hi = Math.min(maxPages, Math.max(a,b));
        for (let i = lo; i <= hi; i++) out.add(i);
      } else {
        const n = parseInt(t,10);
        if (n && n >= 1 && n <= maxPages) out.add(n);
      }
    }
    return out;
  }

  // -----------------------------
  // CAPTURE listeners: override existing page op handlers
  // -----------------------------
  async function _rewriteByOrder(orderPages1Based) {
    const { PDFDocument } = window.PDFLib || {};
    if (!PDFDocument) throw new Error("PDFLib missing.");
    const src = await PDFDocument.load(state.pdfBytes);
    const out = await PDFDocument.create();
    const idxs = orderPages1Based.map(p => p - 1);
    const copied = await out.copyPages(src, idxs);
    copied.forEach(p => out.addPage(p));
    return await out.save({ useObjectStreams: true });
  }

  async function _deletePagesBytes(pagesToDelete, totalPages) {
    const { PDFDocument } = window.PDFLib || {};
    if (!PDFDocument) throw new Error("PDFLib missing.");
    const doc = await PDFDocument.load(state.pdfBytes);
    const sortedDesc = [...pagesToDelete].sort((a,b)=>b-a);
    for (const pn of sortedDesc) doc.removePage(pn - 1);
    return await doc.save({ useObjectStreams: true });
  }

  async function _duplicatePagesBytes(selectedPages, totalPages) {
    const { PDFDocument } = window.PDFLib || {};
    if (!PDFDocument) throw new Error("PDFLib missing.");
    const doc = await PDFDocument.load(state.pdfBytes);
    const idxs = [...selectedPages].map(p => p - 1).sort((a,b)=>a-b);
    let offset = 0;
    for (const i of idxs) {
      const real = i + offset;
      const [cp] = await doc.copyPages(doc, [real]);
      doc.insertPage(real + 1, cp);
      offset += 1;
    }
    return await doc.save({ useObjectStreams: true });
  }

  async function _insertBlankBytes(beforePage) {
    const { PDFDocument } = window.PDFLib || {};
    if (!PDFDocument) throw new Error("PDFLib missing.");
    const doc = await PDFDocument.load(state.pdfBytes);
    const ref = doc.getPage(0);
    const size = ref ? ref.getSize() : { width: 612, height: 792 };
    doc.insertPage(beforePage - 1, [size.width, size.height]);
    return await doc.save({ useObjectStreams: true });
  }

  async function _rotatePagesBytes(pages, deltaDeg) {
    const { PDFDocument, degrees } = window.PDFLib || {};
    if (!PDFDocument) throw new Error("PDFLib missing.");
    const doc = await PDFDocument.load(state.pdfBytes);
    const asc = [...pages].sort((a,b)=>a-b);
    for (const pn of asc) {
      const page = doc.getPage(pn - 1);
      const cur = (page.getRotation && page.getRotation().angle) ? page.getRotation().angle : 0;
      const next = ((cur + deltaDeg) % 360 + 360) % 360;
      page.setRotation(degrees(next));
    }
    return await doc.save({ useObjectStreams: true });
  }

  async function _applyAndReload(bytes, newAnn, newSel) {
    await reloadFromBytes(bytes, state.fileName || "document.pdf");
    _setAnnMap(newAnn);
    _setSelSet(newSel || new Set());
    try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}
    _setOpsCount();
  }

  function _getSelectedPagesOrPrompt(totalPages) {
    let pages = new Set();
    try {
      if (state.pageSel && state.pageSel.size) pages = new Set(state.pageSel.values());
    } catch {}
    if (!pages.size) {
      const raw = prompt("Pages (e.g. 1,3-5). Leave empty to cancel.", "");
      pages = _parsePages(raw, totalPages);
    }
    return pages;
  }

  // Hook button clicks in capture so we win over old listeners
  const __btnIds = ["pgDelete","pgDup","pgBlank","pgRotateL","pgRotateR"];
  for (const id of __btnIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("click", (e) => {
      // capture phase: stop old handlers
      e.stopImmediatePropagation();
    }, true);
  }

  // Delete pages (preserve marks via transform)
  const __pgDelete = document.getElementById("pgDelete");
  if (__pgDelete) __pgDelete.addEventListener("click", async (e) => {
    try {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
      const total = state.pdf.numPages || 0;
      const pages = _getSelectedPagesOrPrompt(total);
      if (!pages.size) { log("Delete canceled."); return; }
      if (!confirm(`Delete ${pages.size} page(s)?`)) return;

      const { ann, sel } = _transformDelete(pages, total);
      recordOp("page_delete", { pages: [...pages].sort((a,b)=>a-b) });

      log("Deleting pages…");
      const bytes = await _deletePagesBytes(pages, total);
      await _applyAndReload(bytes, ann, sel);
      log("Deleted pages (marks preserved where possible).");
    } catch (err) { console.error(err); log(String(err.message || err)); }
  }, true);

  // Duplicate pages (preserve marks)
  const __pgDup = document.getElementById("pgDup");
  if (__pgDup) __pgDup.addEventListener("click", async (e) => {
    try {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
      const total = state.pdf.numPages || 0;
      const pages = _getSelectedPagesOrPrompt(total);
      if (!pages.size) { log("Duplicate canceled."); return; }

      const { ann, sel } = _transformDuplicate(pages, total);
      recordOp("page_duplicate", { pages: [...pages].sort((a,b)=>a-b) });

      log("Duplicating pages…");
      const bytes = await _duplicatePagesBytes(pages, total);
      await _applyAndReload(bytes, ann, sel);
      log("Duplicated pages (marks copied to duplicates).");
    } catch (err) { console.error(err); log(String(err.message || err)); }
  }, true);

  // Insert blank (preserve marks by shifting)
  const __pgBlank = document.getElementById("pgBlank");
  if (__pgBlank) __pgBlank.addEventListener("click", async (e) => {
    try {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
      const total = state.pdf.numPages || 0;

      let beforePage = 1;
      try {
        if (state.pageSel && state.pageSel.size) beforePage = Math.min(...Array.from(state.pageSel.values()));
      } catch {}
      const raw = prompt(`Insert blank page before page # (1..${total+1})`, String(beforePage));
      const n = parseInt(raw || "", 10);
      if (!n || n < 1 || n > total + 1) { log("Insert canceled."); return; }
      beforePage = n;

      const { ann, sel } = _transformInsertBlank(beforePage, total);
      recordOp("page_insert_blank", { beforePage });

      log("Inserting blank page…");
      const bytes = await _insertBlankBytes(beforePage);
      await _applyAndReload(bytes, ann, sel);
      log("Inserted blank page (marks shifted).");
    } catch (err) { console.error(err); log(String(err.message || err)); }
  }, true);

  // Rotate left/right (marks unchanged)
  const __pgRotateL = document.getElementById("pgRotateL");
  if (__pgRotateL) __pgRotateL.addEventListener("click", async (e) => {
    try {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
      const total = state.pdf.numPages || 0;
      const pages = _getSelectedPagesOrPrompt(total);
      if (!pages.size) { log("Rotate canceled."); return; }

      recordOp("page_rotate", { pages: [...pages].sort((a,b)=>a-b), delta: -90 });

      log("Rotating…");
      const bytes = await _rotatePagesBytes(pages, -90);
      await _applyAndReload(bytes, new Map(_annEntries()), new Set(pages));
      log("Rotated selected pages.");
    } catch (err) { console.error(err); log(String(err.message || err)); }
  }, true);

  const __pgRotateR = document.getElementById("pgRotateR");
  if (__pgRotateR) __pgRotateR.addEventListener("click", async (e) => {
    try {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
      const total = state.pdf.numPages || 0;
      const pages = _getSelectedPagesOrPrompt(total);
      if (!pages.size) { log("Rotate canceled."); return; }

      recordOp("page_rotate", { pages: [...pages].sort((a,b)=>a-b), delta: 90 });

      log("Rotating…");
      const bytes = await _rotatePagesBytes(pages, 90);
      await _applyAndReload(bytes, new Map(_annEntries()), new Set(pages));
      log("Rotated selected pages.");
    } catch (err) { console.error(err); log(String(err.message || err)); }
  }, true);

  // Thumb drag reorder (capture override)
  (function(){
    const thumbs = document.getElementById("thumbs");
    if (!thumbs) return;
    let fromPn = null;

    thumbs.addEventListener("dragstart", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.thumb") : null;
      if (!btn) return;
      const pn = parseInt(btn.dataset.page || "", 10);
      if (pn) fromPn = pn;
    }, true);

    thumbs.addEventListener("dragover", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.thumb") : null;
      if (btn) e.preventDefault();
    }, true);

    thumbs.addEventListener("drop", async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.thumb") : null;
      if (!btn) return;
      const toPn = parseInt(btn.dataset.page || "", 10);
      if (!fromPn || !toPn || fromPn === toPn) return;

      e.preventDefault();
      e.stopImmediatePropagation(); // block old drop handler

      try {
        if (!state.pdf || !state.pdfBytes) { log("Load a PDF first."); return; }
        const total = state.pdf.numPages || 0;
        const order = Array.from({length: total}, (_, i) => i + 1);
        const fromIdx = order.indexOf(fromPn);
        const toIdx = order.indexOf(toPn);
        if (fromIdx < 0 || toIdx < 0) return;
        order.splice(toIdx, 0, order.splice(fromIdx, 1)[0]);

        const { ann, sel } = _transformReorder(order);
        recordOp("page_reorder", { from: fromPn, to: toPn, order });

        log("Reordering…");
        const bytes = await _rewriteByOrder(order);
        await _applyAndReload(bytes, ann, sel);
        log("Reordered pages (marks preserved).");
      } catch (err) { console.error(err); log(String(err.message || err)); }
      finally { fromPn = null; }
    }, true);
  })();


  
  // =========================
  // EXPORT_FROM_OPLOG_V1: Deterministic replay/export pipeline
  // =========================
  const rebuildFromOpsBtn = document.getElementById("rebuildFromOps");
  const exportFromOpsBtn  = document.getElementById("exportFromOps");

  function __oplogList() {
    try { return Array.isArray(state.oplog) ? state.oplog : []; } catch { return []; }
  }

  function __originalBytes() {
    try { return state.__originalPdfBytes || state.pdfBytes || null; } catch { return null; }
  }

  function __downloadBytes(bytes, filename, mime="application/pdf") {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function applyPageOpsToBytes(bytes, ops) {
    if (!window.PDFLib) throw new Error("PDFLib missing.");
    const { PDFDocument, degrees } = window.PDFLib;

    let cur = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);

    for (const op of (ops || [])) {
      if (!op || !op.kind) continue;

      if (op.kind === "page_reorder" && Array.isArray(op.order) && op.order.length) {
        const src = await PDFDocument.load(cur);
        const out = await PDFDocument.create();
        const idxs = op.order.map(p => (p|0) - 1).filter(i => i >= 0 && i < src.getPageCount());
        const copied = await out.copyPages(src, idxs);
        copied.forEach(p => out.addPage(p));
        cur = await out.save({ useObjectStreams: true });
        continue;
      }

      if (op.kind === "page_delete" && Array.isArray(op.pages) && op.pages.length) {
        const doc = await PDFDocument.load(cur);
        const desc = [...op.pages].map(p => p|0).filter(p => p>=1 && p<=doc.getPageCount()).sort((a,b)=>b-a);
        for (const pn of desc) doc.removePage(pn - 1);
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }

      if (op.kind === "page_duplicate" && Array.isArray(op.pages) && op.pages.length) {
        const doc = await PDFDocument.load(cur);
        const idxs = [...op.pages].map(p => (p|0) - 1).filter(i => i>=0 && i<doc.getPageCount()).sort((a,b)=>a-b);
        let offset = 0;
        for (const i of idxs) {
          const real = i + offset;
          const [cp] = await doc.copyPages(doc, [real]);
          doc.insertPage(real + 1, cp);
          offset += 1;
        }
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }

      if (op.kind === "page_insert_blank" && (op.beforePage|0) >= 1) {
        const doc = await PDFDocument.load(cur);
        const before = op.beforePage|0;
        const ref = doc.getPage(0);
        const size = ref ? ref.getSize() : { width: 612, height: 792 };
        const at = Math.max(0, Math.min(doc.getPageCount(), before - 1));
        doc.insertPage(at, [size.width, size.height]);
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }

      if (op.kind === "page_rotate" && Array.isArray(op.pages) && op.pages.length && (op.delta|0)) {
        const doc = await PDFDocument.load(cur);
        const asc = [...op.pages].map(p=>p|0).filter(p=>p>=1 && p<=doc.getPageCount()).sort((a,b)=>a-b);
        for (const pn of asc) {
          const page = doc.getPage(pn - 1);
          const curRot = (page.getRotation && page.getRotation().angle) ? page.getRotation().angle : 0;
          const next = ((curRot + (op.delta|0)) % 360 + 360) % 360;
          page.setRotation(degrees(next));
        }
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }
    }

    return cur;
  }

  function __annEntries() {
    try { return (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : []; } catch { return []; }
  }

  function __hexToRgb01(hex) {
    const h = String(hex||"").replace("#","").trim();
    const to = (s) => ((parseInt(s,16)||0)/255);
    if (h.length === 3) return [to(h[0]+h[0]), to(h[1]+h[1]), to(h[2]+h[2])];
    if (h.length >= 6) return [to(h.slice(0,2)), to(h.slice(2,4)), to(h.slice(4,6))];
    return [1,1,0];
  }

  function __normToPdfRect(pageW, pageH, bboxN) {
    const x = bboxN.x * pageW;
    const yTop = bboxN.y * pageH;
    const w = bboxN.w * pageW;
    const h = bboxN.h * pageH;
    const y = pageH - yTop - h;
    return { x, y, w, h };
  }

  async function flattenMarksToBytes(bytes, annEntries) {
    if (!window.PDFLib) throw new Error("PDFLib missing.");
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;

    const doc = await PDFDocument.load(bytes);
    const fontHelv = await doc.embedFont(StandardFonts.Helvetica);
    const fontTimes = await doc.embedFont(StandardFonts.TimesRoman);
    const fontCourier = await doc.embedFont(StandardFonts.Courier);
    const imageCache = new Map();

    const byPage = new Map(annEntries || []);
    for (const [pageNum, list] of byPage.entries()) {
      const pn = (pageNum|0);
      if (!pn || pn < 1 || pn > doc.getPageCount()) continue;
      if (!Array.isArray(list) || !list.length) continue;

      const page = doc.getPage(pn - 1);
      const { width: pageW, height: pageH } = page.getSize();

      for (const a of list) {
        if (!a || !a.type || !a.bboxN) continue;
        const style = a.style || {};
        const [r,g,b] = __hexToRgb01(style.color || "#ffea00");
        const op = (typeof style.opacity === "number") ? style.opacity : 0.35;

        if (a.type === "patch") {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          page.drawRectangle({ x,y,width:w,height:h, color: rgb(r,g,b), opacity: 1 });
        } else if (a.type === "redact") {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          page.drawRectangle({ x,y,width:w,height:h, color: rgb(0,0,0), opacity: 1 });
        } else if (a.type === "highlight") {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          page.drawRectangle({ x,y,width:w,height:h, color: rgb(r,g,b), opacity: op });
        } else if (a.type === "rect") {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          page.drawRectangle({ x,y,width:w,height:h, borderColor: rgb(r,g,b), borderWidth: Math.max(0.5,(style.width||4)*0.5), borderOpacity: 1 });
        } else if (a.type === "ink" && Array.isArray(a.points)) {
          const thick = Math.max(0.5, (style.width || 4) * 0.6);
          for (let i = 1; i < a.points.length; i++) {
            const p0 = a.points[i-1], p1 = a.points[i];
            const x1 = p0.xN * pageW, y1 = pageH - (p0.yN * pageH);
            const x2 = p1.xN * pageW, y2 = pageH - (p1.yN * pageH);
            page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness: thick, color: rgb(r,g,b), opacity: 1 });
          }
        } else if (a.type === "text") {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          const size = Math.max(8, Math.min(96, style.fontSize || 18));
          const pad = 6;
          const maxW = Math.max(10, w - pad*2);
          const lineH = size * 1.2;

          const font = (style.font === "serif") ? fontTimes : (style.font === "mono") ? fontCourier : fontHelv;
          const approxCharW = size * 0.55;
          const maxChars = Math.max(1, Math.floor(maxW / approxCharW));

          const words = String(a.text || "").split(/\s+/).filter(Boolean);
          let line = "";
          const lines = [];
          for (const wd of words) {
            const test = line ? (line + " " + wd) : wd;
            if (test.length <= maxChars) line = test;
            else { if (line) lines.push(line); line = wd; }
          }
          if (line) lines.push(line);

          let yy = y + h - pad - size;
          for (const ln of lines) {
            page.drawText(ln, { x: x + pad, y: yy, size, font, color: rgb(r,g,b) });
            yy -= lineH;
            if (yy < y + pad) break;
          }
        } else if ((a.type === "image" || a.type === "signature") && a.dataUrl) {
          const {x,y,w,h} = __normToPdfRect(pageW,pageH,a.bboxN);
          const dataUrl = String(a.dataUrl);
          if (!imageCache.has(dataUrl)) {
            const base64 = dataUrl.split(",")[1] || "";
            const bin = atob(base64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            if (dataUrl.startsWith("data:image/png")) imageCache.set(dataUrl, await doc.embedPng(u8));
            else imageCache.set(dataUrl, await doc.embedJpg(u8));
          }
          const img = imageCache.get(dataUrl);
          if (img) page.drawImage(img, { x,y,width:w,height:h });
        }
      }
    }

    return await doc.save({ useObjectStreams: true });
  }

  async function rebuildFromOps() {
    const orig = __originalBytes();
    if (!orig) { log("No original PDF bytes found."); return; }
    const ops = __oplogList();
    log("Rebuilding from original via op log…");
    const rebuilt = await applyPageOpsToBytes(orig, ops);
    if (typeof reloadFromBytes !== "function") { log("reloadFromBytes missing."); return; }
    await reloadFromBytes(rebuilt, state.fileName || "rebuilt.pdf");
    try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
    try { if (typeof syncButtons === "function") syncButtons(); } catch {}
    log("Rebuild complete (page ops replayed).");
  }

  async function exportFromOps() {
    const orig = __originalBytes();
    if (!orig) { log("No original PDF bytes found."); return; }
    const ops = __oplogList();
    const anns = __annEntries();

    log("Export From Ops:\n1) Apply page ops to original\n2) Flatten current marks\n3) Download");
    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");

    const baseBytes = await applyPageOpsToBytes(orig, ops);
    const outBytes  = await flattenMarksToBytes(baseBytes, anns);

    __downloadBytes(outBytes, `${base}-oplog-flattened.pdf`);
    log("✅ Exported via OpLog pipeline.");
  }

  if (rebuildFromOpsBtn) rebuildFromOpsBtn.addEventListener("click", () => { rebuildFromOps().catch(e => { console.error(e); log(String(e.message||e)); }); });
  if (exportFromOpsBtn)  exportFromOpsBtn.addEventListener("click", () => { exportFromOps().catch(e => { console.error(e); log(String(e.message||e)); }); });


  
  // =========================
  // SERVER_EXPORT_APPLY_V1
  // =========================
  const serverExportBtn = document.getElementById("serverExportBtn");

  async function _serverExport() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }
    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    function u8ToB64(u8) {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    }

    const payload = {
      originalPdfB64: u8ToB64(orig),
      ops,
      annotations,
      flatten: true
    };

    log("Server Export: sending contract to /api/pdf/apply …");
    const resp = await fetch("/api/pdf/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Server export failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-server.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Server Export complete.");
  }

  if (serverExportBtn) {
    serverExportBtn.addEventListener("click", () => {
      _serverExport().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_SECURE_RASTER_V1
  // =========================
  const serverSecureRasterBtn = document.getElementById("serverSecureRasterBtn");

  async function _u8ToB64(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverSecureRaster() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }
    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    const dpiStr = prompt("Raster DPI (e.g. 150, 200, 300). Higher = sharper, larger file.", "200");
    const dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));

    const payload = {
      originalPdfB64: await _u8ToB64(orig),
      ops,
      annotations,
      dpi
    };

    log(`Server Secure Raster: /api/pdf/secure-raster (dpi=${dpi}) …`);
    const resp = await fetch("/api/pdf/secure-raster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Server secure raster failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-secure-raster-${dpi}dpi.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Server Secure Raster complete (image-only PDF).");
  }

  if (serverSecureRasterBtn) {
    serverSecureRasterBtn.addEventListener("click", () => {
      _serverSecureRaster().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_OPTIMIZE_V1
  // =========================
  const serverOptimizeBtn = document.getElementById("serverOptimizeBtn");
  const optPreset = document.getElementById("optPreset");
  const optLinearize = document.getElementById("optLinearize");

  function __u8ToB64(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverOptimize() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
    const preset = optPreset ? optPreset.value : "ebook";
    const linearize = optLinearize ? !!optLinearize.checked : false;

    const payload = {
      originalPdfB64: __u8ToB64(orig),
      ops,
      annotations,
      flatten: true,
      preset,
      linearize
    };

    log(`Server Optimize: /api/pdf/optimize (preset=${preset}${linearize ? ", linearize" : ""}) …`);
    const resp = await fetch("/api/pdf/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Optimize failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-optimized-${preset}${linearize ? "-linearized" : ""}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Server Optimize complete.");
  }

  if (serverOptimizeBtn) {
    serverOptimizeBtn.addEventListener("click", () => {
      _serverOptimize().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_VERIFY_V1
  // =========================
  const serverVerifyBtn = document.getElementById("serverVerifyBtn");
  const serverVerifyMode = document.getElementById("serverVerifyMode");
  const serverVerifyNeedles = document.getElementById("serverVerifyNeedles");

  function __u8ToB64_verify(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverVerify() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    const mode = serverVerifyMode ? serverVerifyMode.value : "applied";
    const needlesRaw = serverVerifyNeedles ? serverVerifyNeedles.value : "";
    const needles = String(needlesRaw || "").split(",").map(s => s.trim()).filter(Boolean);

    let dpi = 200;
    if (mode === "secure_raster") {
      const dpiStr = prompt("Verify raster DPI (server renders then verifies).", "200");
      dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));
    }

    const payload = {
      originalPdfB64: __u8ToB64_verify(orig),
      ops,
      annotations,
      flatten: true,
      mode,
      dpi,
      needles
    };

    log(`Server Verify: /api/pdf/verify (mode=${mode}) …`);
    const resp = await fetch("/api/pdf/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(async () => ({ error: await resp.text().catch(()=> "unknown") }));
    if (!resp.ok) throw new Error(data && data.error ? data.error : `Verify failed: ${resp.status}`);

    const lines = [];
    lines.push(`✅ Verify OK`);
    lines.push(`mode=${data.mode} bytes=${data.bytes} sha256=${data.sha256}`);
    lines.push(`anyText=${data.anyText} totalChars=${data.totalChars}`);

    if (data.needles && data.needles.length) {
      if (data.hits && data.hits.length) {
        lines.push(`HITS:`);
        for (const h of data.hits.slice(0, 30)) {
          lines.push(`- "${h.needle}" count=${h.count} pages=${(h.pages||[]).join(",")}`);
        }
      } else {
        lines.push(`No needle hits.`);
      }
    }

    if (data.note) lines.push(data.note);
    log(lines.join("\n"));
  }

  if (serverVerifyBtn) {
    serverVerifyBtn.addEventListener("click", () => {
      _serverVerify().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_SECURE_RASTER_SELECTIVE_V1
  // =========================
  const serverSecureRasterSelectiveBtn = document.getElementById("serverSecureRasterSelectiveBtn");

  function __u8ToB64_sel(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverSecureRasterSelective(useSelectedPages) {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }
    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    const dpiStr = prompt("Raster DPI (150/200/300). Higher = sharper, bigger file.", "200");
    const dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));

    let pages = null;
    if (useSelectedPages) {
      const sel = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()).sort((a,b)=>a-b) : [];
      if (!sel.length) { log("No pages selected (shift-click uses selected pages)."); return; }
      pages = sel;
    }

    const payload = {
      originalPdfB64: __u8ToB64_sel(orig),
      ops,
      annotations,
      dpi,
      pages // null => server derives from redact marks
    };

    log(`Server Secure Raster (Selective): /api/pdf/secure-raster-selective (dpi=${dpi}) …`);
    const resp = await fetch("/api/pdf/secure-raster-selective", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Selective raster failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const suffix = useSelectedPages ? "selected" : "redactions";
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-secure-raster-${suffix}-${dpi}dpi.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Selective secure raster complete.");
  }

  if (serverSecureRasterSelectiveBtn) {
    serverSecureRasterSelectiveBtn.addEventListener("click", (e) => {
      const useSelectedPages = !!e.shiftKey;
      _serverSecureRasterSelective(useSelectedPages).catch((err) => {
        console.error(err);
        log(String(err.message || err));
      });
    });
  }


  
  // =========================
  // SERVER_EXTRACT_ZIP_V1
  // =========================
  const serverExtractZipBtn = document.getElementById("serverExtractZipBtn");
  const srvZipScope = document.getElementById("srvZipScope");
  const srvZipFmt = document.getElementById("srvZipFmt");
  const srvZipDpi = document.getElementById("srvZipDpi");

  function __u8ToB64_zip(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverExtractZip() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    const scope = srvZipScope ? srvZipScope.value : "selected";
    const fmt = srvZipFmt ? srvZipFmt.value : "pdf";
    const dpi = Math.max(72, Math.min(600, parseInt((srvZipDpi && srvZipDpi.value) ? srvZipDpi.value : "200", 10) || 200));

    let pages = [];
    if (scope === "selected") {
      pages = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()).sort((a,b)=>a-b) : [];
      if (!pages.length) throw new Error("No pages selected (scope=selected).");
    }

    const payload = {
      originalPdfB64: __u8ToB64_zip(orig),
      ops,
      annotations,
      flatten: true,
      scope,
      pages,
      fmt,
      dpi
    };

    log(`Server Extract ZIP: /api/pdf/extract-zip (scope=${scope} fmt=${fmt}${fmt==="png" ? " dpi="+dpi : ""}) …`);
    const resp = await fetch("/api/pdf/extract-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Extract ZIP failed: ${resp.status} ${t}`);
    }

    const blob = await resp.blob();
    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const name = `${base}-extract-${scope}-${fmt}${fmt==="png" ? "-" + dpi + "dpi" : ""}.zip`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Server Extract ZIP complete.");
  }

  if (serverExtractZipBtn) {
    serverExtractZipBtn.addEventListener("click", () => {
      _serverExtractZip().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_REDACT_PACKAGE_V1
  // =========================
  const serverRedactPackageBtn = document.getElementById("serverRedactPackageBtn");
  const redactPkgMode = document.getElementById("redactPkgMode");
  const redactPkgDpi = document.getElementById("redactPkgDpi");
  const redactPkgNeedles = document.getElementById("redactPkgNeedles");

  function __u8ToB64_pkg(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverRedactPackage() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

    const mode = redactPkgMode ? redactPkgMode.value : "selective_raster";
    const dpi = Math.max(72, Math.min(600, parseInt((redactPkgDpi && redactPkgDpi.value) ? redactPkgDpi.value : "200", 10) || 200));
    const needlesRaw = redactPkgNeedles ? redactPkgNeedles.value : "";
    const needles = String(needlesRaw || "").split(",").map(s => s.trim()).filter(Boolean);

    const payload = {
      originalPdfB64: __u8ToB64_pkg(orig),
      ops,
      annotations,
      mode,
      dpi,
      needles
    };

    log(`Redaction Package: /api/pdf/redact-package (mode=${mode}${mode.includes("raster") ? " dpi="+dpi : ""}) …`);
    const resp = await fetch("/api/pdf/redact-package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Redaction package failed: ${resp.status} ${t}`);
    }

    const blob = await resp.blob();
    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-redaction-package.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Downloaded redaction package ZIP.");
  }

  if (serverRedactPackageBtn) {
    serverRedactPackageBtn.addEventListener("click", () => {
      _serverRedactPackage().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // FORMS_OPLOG_V1 (record form ops into state.oplog)
  // =========================
  (function(){
    const formsBuildBtn = document.getElementById("formsBuild");
    const formsApplyBtn = document.getElementById("formsApply");
    const formFieldsHost = document.getElementById("formFields");

    function _record(kind, payload){
      try {
        if (typeof recordOp === "function") return recordOp(kind, payload);
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        if (typeof _setOpsCount === "function") _setOpsCount();
      } catch {}
    }

    function _annEntries(){
      try { return (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : []; } catch { return []; }
    }

    // Record create ops from FormText/FormCheck marks whenever "Build Fields" is clicked
    if (formsBuildBtn) {
      formsBuildBtn.addEventListener("click", () => {
        const byPage = new Map(_annEntries());
        for (const [pageNumRaw, list] of byPage.entries()) {
          const pageNum = pageNumRaw|0;
          if (!pageNum || !Array.isArray(list)) continue;
          for (const a of list) {
            if (!a || !a.name || !a.bboxN) continue;
            if (a.type === "form_text") {
              _record("form_create_text", { name: String(a.name), pageNum, bboxN: a.bboxN });
            } else if (a.type === "form_check") {
              _record("form_create_check", { name: String(a.name), pageNum, bboxN: a.bboxN });
            }
          }
        }
      }, true);
    }

    // Record set ops from the Forms UI when "Apply Values" is clicked
    if (formsApplyBtn) {
      formsApplyBtn.addEventListener("click", () => {
        if (!formFieldsHost) return;
        const els = formFieldsHost.querySelectorAll("input,select");
        els.forEach(el => {
          const name = el.dataset.fieldName || el.getAttribute("data-field-name") || "";
          if (!name) return;
          if (el.tagName.toLowerCase() === "select") {
            const v = (String(el.value) === "true");
            _record("form_set", { name, fieldType: "checkbox", value: v });
          } else {
            _record("form_set", { name, fieldType: "text", value: String(el.value || "") });
          }
        });
      }, true);
    }
  })();


  
  // =========================
  // SERVER_EXPORT_FLATTEN_FORMS_V1
  // =========================
  (function(){
  const serverExportFlatFormsBtn = document.getElementById("serverExportFlatFormsBtn");
  const srvFlattenForms = document.getElementById("srvFlattenForms");

  function __u8ToB64_forms(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverExportFlattenForms() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }
    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
    const flattenForms = srvFlattenForms ? !!srvFlattenForms.checked : true;

    const payload = {
      originalPdfB64: __u8ToB64_forms(orig),
      ops,
      annotations,
      flatten: true,
      flattenForms
    };

    log(`Server Export: /api/pdf/apply (flattenForms=${flattenForms}) …`);
    const resp = await fetch("/api/pdf/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`Server export failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i, "");
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-server${flattenForms ? "-flattenforms" : ""}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Server Export complete.");
  }

  if (serverExportFlatFormsBtn) {
    serverExportFlatFormsBtn.addEventListener("click", () => {
      _serverExportFlattenForms().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_TRUE_REDACT_V1
  // =========================
  const serverTrueRedactBtn = document.getElementById("serverTrueRedactBtn");
  const srvFlattenForms2 = document.getElementById("srvFlattenForms");

  function __u8ToB64_true(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverTrueRedact() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
    const flattenForms = srvFlattenForms2 ? !!srvFlattenForms2.checked : false;

    const payload = {
      originalPdfB64: __u8ToB64_true(orig),
      ops,
      annotations,
      flattenForms
    };

    log("Server True Redact: /api/pdf/true-redact …");
    const resp = await fetch("/api/pdf/true-redact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`True redact failed: ${resp.status} ${t}`);
    }

    const buf = await resp.arrayBuffer();
    const outBytes = new Uint8Array(buf);

    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-true-redacted.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ True redaction complete.");
  }

  if (serverTrueRedactBtn) {
    serverTrueRedactBtn.addEventListener("click", () => {
      _serverTrueRedact().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // SERVER_TRUE_REDACT_PACKAGE_V1
  // =========================
  const serverTrueRedactPkgBtn = document.getElementById("serverTrueRedactPkgBtn");
  const trueRedactPkgNeedles = document.getElementById("trueRedactPkgNeedles");
  const srvFlattenForms3 = document.getElementById("srvFlattenForms");

  function __u8ToB64_trpkg(u8) {
    const CH = 0x8000;
    let out = "";
    for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function _serverTrueRedactPackage() {
    if (!state.pdfBytes) { log("Load a PDF first."); return; }

    const orig = state.__originalPdfBytes || state.pdfBytes;
    const ops = Array.isArray(state.oplog) ? state.oplog : [];
    const annotations = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
    const flattenForms = srvFlattenForms3 ? !!srvFlattenForms3.checked : false;

    const needlesRaw = trueRedactPkgNeedles ? trueRedactPkgNeedles.value : "";
    const needles = String(needlesRaw || "").split(",").map(s => s.trim()).filter(Boolean);

    const payload = {
      originalPdfB64: __u8ToB64_trpkg(orig),
      ops,
      annotations,
      flattenForms,
      needles
    };

    log("True Redaction Package: /api/pdf/true-redact-package …");
    const resp = await fetch("/api/pdf/true-redact-package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`True redact package failed: ${resp.status} ${t}`);
    }

    const blob = await resp.blob();
    const base = (state.fileName || "document.pdf").replace(/\.pdf$/i,"");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-true-redaction-package.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    log("✅ Downloaded true redaction package ZIP.");
  }

  if (serverTrueRedactPkgBtn) {
    serverTrueRedactPkgBtn.addEventListener("click", () => {
      _serverTrueRedactPackage().catch((e) => { console.error(e); log(String(e.message || e)); });
    });
  }


  
  // =========================
  // DIAGNOSTICS_V1
  // =========================
  const diagRun = document.getElementById("diagRun");
  const diagOut = document.getElementById("diagOut");

  function _diagLine(ok, label, detail) {
    const d = document.createElement("div");
    d.style.padding = "6px 8px";
    d.style.border = "1px solid rgba(255,255,255,.10)";
    d.style.borderRadius = "10px";
    d.style.background = "rgba(255,255,255,.03)";
    d.textContent = `${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`;
    return d;
  }

  async function _ping(url, opts) {
    try {
      const r = await fetch(url, opts || {});
      const t = await r.text().catch(()=> "");
      return { ok: r.ok, status: r.status, text: t.slice(0, 180) };
    } catch (e) {
      return { ok: false, status: 0, text: String(e && e.message ? e.message : e) };
    }
  }

  async function runDiagnostics() {
    if (!diagOut) return;
    diagOut.innerHTML = "";

    // libs
    diagOut.appendChild(_diagLine(!!window.pdfjsLib, "pdfjsLib present", ""));
    diagOut.appendChild(_diagLine(!!window.PDFLib, "PDFLib present", ""));
    diagOut.appendChild(_diagLine(!!window.JSZip, "JSZip present", ""));
    diagOut.appendChild(_diagLine(!!(state && state.oplog), "state.oplog present", state && state.oplog ? `ops=${state.oplog.length}` : ""));

    // endpoints
    const h = await _ping("/api/health");
    diagOut.appendChild(_diagLine(h.ok, "GET /api/health", h.ok ? "" : `${h.status} ${h.text}`));

    // Only test pdf endpoints if we have bytes
    if (!state || !state.pdfBytes) {
      diagOut.appendChild(_diagLine(false, "PDF endpoints skipped", "Load a PDF first"));
      return;
    }

    // tiny payload (no-op) for apply
    const CH = 0x8000;
    let b64 = "";
    for (let i = 0; i < state.pdfBytes.length; i += CH) b64 += String.fromCharCode.apply(null, state.pdfBytes.subarray(i, i + CH));
    const originalPdfB64 = btoa(b64);

    const basePayload = {
      originalPdfB64,
      ops: Array.isArray(state.oplog) ? state.oplog : [],
      annotations: (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [],
      flatten: true,
      flattenForms: false
    };

    const a = await _ping("/api/pdf/apply", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(basePayload) });
    diagOut.appendChild(_diagLine(a.ok, "POST /api/pdf/apply", a.ok ? "ok" : `${a.status} ${a.text}`));

    const v = await _ping("/api/pdf/verify", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ ...basePayload, mode:"applied", needles: [] }) });
    diagOut.appendChild(_diagLine(v.ok, "POST /api/pdf/verify", v.ok ? "ok" : `${v.status} ${v.text}`));

    const tr = await _ping("/api/pdf/true-redact", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(basePayload) });
    // true-redact may 400 if no redact marks; treat 400 as "reachable"
    const trOk = tr.ok || tr.status === 400;
    diagOut.appendChild(_diagLine(trOk, "POST /api/pdf/true-redact", trOk ? (tr.status===400 ? "reachable (needs redact marks)" : "ok") : `${tr.status} ${tr.text}`));
  }

  if (diagRun) diagRun.addEventListener("click", () => { runDiagnostics().catch(e => { console.error(e); log(String(e.message||e)); }); });


  setTool("select");
    if (k === "h") setTool("highlight");
    if (k === "d") setTool("ink");
    if (k === "r") setTool("rect");
    if (e.code === "Space") setTool("hand");
  });

  setTool("select");
  log("Ready. Upload a PDF (native preview).");
})();


  // =========================
  // SERVER_TEXT_REPLACE_V1
  // =========================
  (function(){
    const btn = document.getElementById("srvTextReplaceBtn");
    if (!btn) return;

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    function recordOp(kind, payload) {
      try {
        if (typeof recordOpLocal === "function") return recordOpLocal(kind, payload);
      } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    btn.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        const find = (document.getElementById("srvFindText")?.value || "").trim();
        const replace = (document.getElementById("srvReplaceText")?.value || "");
        const matchCase = !!document.getElementById("srvMatchCase")?.checked;
        const wholeWord = !!document.getElementById("srvWholeWord")?.checked;
        const scope = document.getElementById("srvReplaceScope")?.value || "all";

        if (!find) { log("Enter Find text."); return; }

        let pages = null;
        if (scope === "selected") {
          const sel = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()).sort((a,b)=>a-b) : [];
          if (!sel.length) { log("No pages selected."); return; }
          pages = sel;
        }

        // Record op in oplog (so replay/export is deterministic)
        recordOp("text_replace", { find, replace, matchCase, wholeWord, pages });

        // Snapshot local overlay state so reload doesn't wipe it
        const annSnap = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        const oplogSnap = Array.isArray(state.oplog) ? state.oplog.slice() : [];
        const selSnap = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()) : [];

        const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
        const orig = state.__originalPdfBytes || state.pdfBytes;

        const payload = {
          originalPdfB64: u8ToB64(orig),
          ops: oplogSnap,
          annotations: useOpAnn ? null : annSnap,
          useOpAnnotations: useOpAnn,
          flatten: true,
          flattenForms: !!document.getElementById("srvFlattenForms")?.checked
        };

        log("Server Text Replace: applying via /api/pdf/apply …");
        const resp = await fetch("/api/pdf/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          const t = await resp.text().catch(()=> "");
          throw new Error(`apply failed: ${resp.status} ${t}`);
        }

        const buf = await resp.arrayBuffer();
        const outBytes = new Uint8Array(buf);

        // Reload preview (keep original bytes unchanged; keep marks/oplog)
        if (typeof reloadFromBytes !== "function") {
          log("reloadFromBytes missing; cannot update preview.");
          return;
        }

        await reloadFromBytes(outBytes, state.fileName || "document.pdf");

        // Restore state pieces
        try { state.oplog = oplogSnap; } catch {}
        try { state.ann = new Map(annSnap); } catch {}
        try { state.pageSel = new Set(selSnap); } catch {}

        try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
        try { if (typeof syncButtons === "function") syncButtons(); } catch {}

        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${oplogSnap.length}`;

        log("✅ Text replace applied and preview updated.");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);
  })();


  // =========================
  // SERVER_RECT_REPLACE_V1
  // =========================
  (function(){
    const btn = document.getElementById("srvRectReplaceBtn");
    const input = document.getElementById("srvRectReplaceText");
    if (!btn || !input) return;

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    function record(kind, payload) {
      try {
        if (typeof recordOp === "function") return recordOp(kind, payload);
      } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    function getSelected() {
      try { if (typeof getSelectedAnn === "function") return getSelectedAnn(); } catch {}
      try {
        if (!state.selected) return null;
        const pn = state.selected.pageNum;
        const id = state.selected.id;
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : [];
        return list.find(a => a && a.id === id) || null;
      } catch { return null; }
    }

    function removeSelectedMark(pageNum, id) {
      // Prefer existing deleteAnn so normal UI updates happen
      try {
        if (typeof deleteAnn === "function") { deleteAnn(pageNum, id); return true; }
      } catch {}
      try {
        const list = (state.ann && state.ann.get) ? (state.ann.get(pageNum) || []) : null;
        if (!list) return false;
        const idx = list.findIndex(a => a && a.id === id);
        if (idx >= 0) list.splice(idx, 1);
        state.selected = null;
        try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); } catch {}
        try { if (typeof syncButtons === "function") syncButtons(); } catch {}
        // also record ann_del if we can
        record("ann_del", { pageNum, id });
        return true;
      } catch { return false; }
    }

    btn.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        const sel = getSelected();
        if (!sel || !sel.bboxN) { log("Select a box mark first (Patch/Redact/Rect)."); return; }
        const pageNum = (state.selected && state.selected.pageNum) ? state.selected.pageNum : (sel.pageNum || 0);
        const id = (state.selected && state.selected.id) ? state.selected.id : sel.id;
        if (!pageNum || !id) { log("Selection missing page/id."); return; }

        const text = String(input.value || "").trim();
        if (!text) { log("Enter replacement text."); return; }

        // Record bounded text replace op
        record("text_replace_rect", { pageNum, bboxN: sel.bboxN, text });

        // Remove the selected box mark so it doesn't cover the inserted text
        removeSelectedMark(pageNum, id);

        // Apply via server and refresh preview
        const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
        const orig = state.__originalPdfBytes || state.pdfBytes;

        const annSnap = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        const oplogSnap = Array.isArray(state.oplog) ? state.oplog.slice() : [];
        const selSnap = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()) : [];

        const payload = {
          originalPdfB64: u8ToB64(orig),
          ops: oplogSnap,
          annotations: useOpAnn ? null : annSnap,
          useOpAnnotations: useOpAnn,
          flatten: true,
          flattenForms: !!document.getElementById("srvFlattenForms")?.checked
        };

        log("Replace Text (Selected Box): applying via /api/pdf/apply …");
        const resp = await fetch("/api/pdf/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          const t = await resp.text().catch(()=> "");
          throw new Error(`apply failed: ${resp.status} ${t}`);
        }

        const buf = await resp.arrayBuffer();
        const outBytes = new Uint8Array(buf);

        if (typeof reloadFromBytes !== "function") { log("reloadFromBytes missing."); return; }
        await reloadFromBytes(outBytes, state.fileName || "document.pdf");

        // restore client state
        try { state.oplog = oplogSnap; } catch {}
        try { state.ann = new Map(annSnap); } catch {}
        try { state.pageSel = new Set(selSnap); } catch {}

        try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
        try { if (typeof syncButtons === "function") syncButtons(); } catch {}

        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${oplogSnap.length}`;

        log("✅ Box text replace applied and preview updated.");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);
  })();


  // =========================
  // TEXT_PICK_V1
  // - Toggle mode that hit-tests clicked text and stores {pageNum,bboxN,text}
  // - "Replace Picked" records text_replace_rect op and applies via /api/pdf/apply
  // =========================
  (function(){
    const toggleBtn = document.getElementById("textPickToggle");
    const statusEl = document.getElementById("textPickStatus");
    const replaceIn = document.getElementById("textPickReplace");
    const applyBtn = document.getElementById("textPickApply");

    if (!toggleBtn || !statusEl || !replaceIn || !applyBtn) return;

    state.__textPick = state.__textPick || { enabled: false, picked: null };

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    function record(kind, payload) {
      try { if (typeof recordOp === "function") return recordOp(kind, payload); } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    function setStatus() {
      statusEl.textContent = `Pick: ${state.__textPick.enabled ? "on" : "off"}`;
    }
    setStatus();

    toggleBtn.addEventListener("click", () => {
      state.__textPick.enabled = !state.__textPick.enabled;
      setStatus();
      log(`Text Pick: ${state.__textPick.enabled ? "enabled" : "disabled"}`);
    });

    function findPageNumFromTarget(t) {
      let el = t;
      for (let i = 0; i < 12 && el; i++) {
        const dp = el.dataset && (el.dataset.page || el.dataset.pn);
        if (dp) {
          const n = parseInt(dp, 10);
          if (n) return n;
        }
        const attr = el.getAttribute && (el.getAttribute("data-page") || el.getAttribute("data-pn"));
        if (attr) {
          const n = parseInt(attr, 10);
          if (n) return n;
        }
        const id = el.id || "";
        const m = id.match(/page[-_]?(\d+)/i);
        if (m) return parseInt(m[1], 10);
        el = el.parentElement;
      }
      // fallback: use selected page if available
      try { if (state.selected && state.selected.pageNum) return state.selected.pageNum; } catch {}
      // last resort: 1
      return 1;
    }

    function findCanvasFromTarget(t) {
      if (!t) return null;
      if (t.tagName && t.tagName.toLowerCase() === "canvas") return t;
      if (t.closest) {
        const c = t.closest("canvas");
        if (c) return c;
      }
      return null;
    }

    async function onDocClick(e) {
      if (!state.__textPick.enabled) return;

      const canvas = findCanvasFromTarget(e.target);
      if (!canvas) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      if (!state.pdfBytes) { log("Load a PDF first."); return; }

      const rect = canvas.getBoundingClientRect();
      const xN = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const yN = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      const pageNum = findPageNumFromTarget(canvas) || 1;

      // NOTE: use current pdfBytes for hit-test (matches what user sees)
      const pdfB64 = u8ToB64(state.pdfBytes);

      const resp = await fetch("/api/pdf/text-hit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfB64, page: pageNum, xN, yN })
      });

      if (!resp.ok) {
        const t = await resp.text().catch(()=> "");
        throw new Error(`text-hit failed: ${resp.status} ${t}`);
      }

      const data = await resp.json();
      if (!data || !data.found) {
        state.__textPick.picked = null;
        log("No text found at click.");
        return;
      }

      state.__textPick.picked = { pageNum: data.page, bboxN: data.bboxN, text: data.text };
      log(`Picked text: "${data.text}" (page ${data.page})`);
      // convenience: prefill replacement with current word
      if (!replaceIn.value) replaceIn.value = String(data.text || "");
    }

    // capture phase so we win over other handlers when enabled
    window.addEventListener("click", (e) => {
      onDocClick(e).catch(err => { console.error(err); log(String(err?.message || err)); });
    }, true);

    applyBtn.addEventListener("click", async () => {
      try {
        const picked = state.__textPick.picked;
        if (!picked || !picked.bboxN) { log("Pick a word first (toggle on, click on text)."); return; }
        const text = String(replaceIn.value || "").trim();
        if (!text) { log("Enter replacement text."); return; }

        record("text_replace_rect", { pageNum: picked.pageNum, bboxN: picked.bboxN, text });

        const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
        const orig = state.__originalPdfBytes || state.pdfBytes;

        const annSnap = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        const oplogSnap = Array.isArray(state.oplog) ? state.oplog.slice() : [];
        const selSnap = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()) : [];

        const payload = {
          originalPdfB64: u8ToB64(orig),
          ops: oplogSnap,
          annotations: useOpAnn ? null : annSnap,
          useOpAnnotations: useOpAnn,
          flatten: true,
          flattenForms: !!document.getElementById("srvFlattenForms")?.checked
        };

        log("Replace Picked: applying via /api/pdf/apply …");
        const resp = await fetch("/api/pdf/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          const t = await resp.text().catch(()=> "");
          throw new Error(`apply failed: ${resp.status} ${t}`);
        }

        const buf = await resp.arrayBuffer();
        const outBytes = new Uint8Array(buf);

        if (typeof reloadFromBytes !== "function") { log("reloadFromBytes missing."); return; }
        await reloadFromBytes(outBytes, state.fileName || "document.pdf");

        try { state.oplog = oplogSnap; } catch {}
        try { state.ann = new Map(annSnap); } catch {}
        try { state.pageSel = new Set(selSnap); } catch {}

        try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
        try { if (typeof syncButtons === "function") syncButtons(); } catch {}

        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${oplogSnap.length}`;

        log("✅ Picked text replaced and preview updated.");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);
  })();


  // =========================
  // SERVER_VERIFY_V2
  // =========================
  (function(){
    const btn = document.getElementById("serverVerifyV2Btn");
    const modeSel = document.getElementById("serverVerifyV2Mode");
    const needlesIn = document.getElementById("serverVerifyV2Needles");
    if (!btn || !modeSel || !needlesIn) return;

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    btn.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        const mode = modeSel.value || "applied";
        const needles = String(needlesIn.value || "").split(",").map(s => s.trim()).filter(Boolean);
        let dpi = 200;
        if (mode === "secure_raster") {
          const dpiStr = prompt("Verify v2 DPI (secure_raster).", "200");
          dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));
        }

        const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
        const orig = state.__originalPdfBytes || state.pdfBytes;
        const ops = Array.isArray(state.oplog) ? state.oplog : [];
        const annEntries = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

        const payload = {
          originalPdfB64: u8ToB64(orig),
          ops,
          annotations: useOpAnn ? null : annEntries,
          useOpAnnotations: useOpAnn,
          flatten: true,
          flattenForms: !!document.getElementById("srvFlattenForms")?.checked,
          mode,
          dpi,
          needles
        };

        log(`Server Verify v2: /api/pdf/verify-v2 (mode=${mode}) …`);
        const r = await fetch("/api/pdf/verify-v2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const data = await r.json().catch(async () => ({ error: await r.text().catch(()=> "") }));
        if (!r.ok) throw new Error(data && data.error ? data.error : `verify-v2 failed: ${r.status}`);

        const lines = [];
        lines.push("✅ Verify v2 OK");
        lines.push(`mode=${data.mode} bytes=${data.bytes} sha256=${data.sha256}`);
        lines.push(`anyText=${data.anyText} extractedChars=${data.extractedChars}`);
        if (data.hits) {
          const ht = (data.hits.text || []);
          const hb = (data.hits.bytes || []);
          const hq = (data.hits.qdf || []);
          lines.push(`hits(text)=${ht.length} hits(bytes)=${hb.length} hits(qdf)=${hq.length}`);
          if (ht.length) lines.push("Text hits: " + ht.map(x => `${x.needle}:${x.count}`).join(", "));
          if (hb.length) lines.push("Bytes hits: " + hb.map(x => `${x.needle}:${x.count}`).join(", "));
          if (hq.length) lines.push("QDF hits: " + hq.map(x => `${x.needle}:${x.count}`).join(", "));
        }
        if (data.qpdf && data.qpdf.check) lines.push(`qpdf.check: ${String(data.qpdf.check).slice(0, 300)}`);
        if (data.note) lines.push(data.note);

        log(lines.join("\n"));
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);
  })();


  // =========================
  // FORMS_V2_SELECTED_BOX_V1
  // - Create dropdown/radio option using selected box bboxN
  // - Record form_set ops for text/checkbox/dropdown/radio
  // =========================
  (function(){
    const btnDD = document.getElementById("formsCreateDropdownBtn");
    const ddName = document.getElementById("formsDropdownName");
    const ddOpts = document.getElementById("formsDropdownOptions");

    const btnRG = document.getElementById("formsCreateRadioOptionBtn");
    const rgName = document.getElementById("formsRadioGroupName");
    const rgOpt = document.getElementById("formsRadioOptionValue");

    const btnSet = document.getElementById("formsSetFieldBtn");
    const setName = document.getElementById("formsSetName");
    const setType = document.getElementById("formsSetType");
    const setVal  = document.getElementById("formsSetValue");

    if (!btnDD || !ddName || !ddOpts || !btnRG || !rgName || !rgOpt || !btnSet || !setName || !setType || !setVal) return;

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    function record(kind, payload) {
      try { if (typeof recordOp === "function") return recordOp(kind, payload); } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    function getSelectedAnnSafe() {
      try { if (typeof getSelectedAnn === "function") return getSelectedAnn(); } catch {}
      try {
        if (!state.selected) return null;
        const pn = state.selected.pageNum;
        const id = state.selected.id;
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : [];
        return list.find(a => a && a.id === id) || null;
      } catch { return null; }
    }

    function removeSelectedMark(pageNum, id) {
      try {
        if (typeof deleteAnn === "function") { deleteAnn(pageNum, id); return true; }
      } catch {}
      try {
        const list = (state.ann && state.ann.get) ? (state.ann.get(pageNum) || []) : null;
        if (!list) return false;
        const idx = list.findIndex(a => a && a.id === id);
        if (idx >= 0) list.splice(idx, 1);
        state.selected = null;
        try { if (typeof redrawOverlay === "function") redrawOverlay(pageNum); } catch {}
        try { if (typeof syncButtons === "function") syncButtons(); } catch {}
        record("ann_del", { pageNum, id });
        return true;
      } catch { return false; }
    }

    async function applyAndReload(oplogSnap, annSnap, selSnap) {
      const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
      const orig = state.__originalPdfBytes || state.pdfBytes;

      const payload = {
        originalPdfB64: u8ToB64(orig),
        ops: oplogSnap,
        annotations: useOpAnn ? null : annSnap,
        useOpAnnotations: useOpAnn,
        flatten: true,
        flattenForms: !!document.getElementById("srvFlattenForms")?.checked
      };

      const resp = await fetch("/api/pdf/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const t = await resp.text().catch(()=> "");
        throw new Error(`apply failed: ${resp.status} ${t}`);
      }

      const buf = await resp.arrayBuffer();
      const outBytes = new Uint8Array(buf);

      if (typeof reloadFromBytes !== "function") throw new Error("reloadFromBytes missing");
      await reloadFromBytes(outBytes, state.fileName || "document.pdf");

      try { state.oplog = oplogSnap; } catch {}
      try { state.ann = new Map(annSnap); } catch {}
      try { state.pageSel = new Set(selSnap); } catch {}

      try { if (typeof redrawAllOverlays === "function") redrawAllOverlays(); } catch {}
      try { if (typeof syncButtons === "function") syncButtons(); } catch {}

      const el = document.getElementById("opsCount");
      if (el) el.textContent = `Ops: ${oplogSnap.length}`;
    }

    btnDD.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        const sel = getSelectedAnnSafe();
        if (!sel || !sel.bboxN) { log("Select a box mark first (Rect/Patch/Redact)."); return; }

        const pageNum = (state.selected && state.selected.pageNum) ? state.selected.pageNum : (sel.pageNum || 0);
        const id = (state.selected && state.selected.id) ? state.selected.id : sel.id;
        if (!pageNum || !id) { log("Selection missing page/id."); return; }

        const name = String(ddName.value || "").trim();
        const options = String(ddOpts.value || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!name) { log("Enter dropdown field name."); return; }
        if (!options.length) { log("Enter dropdown options (comma separated)."); return; }

        record("form_create_dropdown", { name, pageNum, bboxN: sel.bboxN, options });

        // remove the box mark so it doesn't cover the widget
        removeSelectedMark(pageNum, id);

        const annSnap = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        const oplogSnap = Array.isArray(state.oplog) ? state.oplog.slice() : [];
        const selSnap = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()) : [];

        log("Creating dropdown field via /api/pdf/apply …");
        await applyAndReload(oplogSnap, annSnap, selSnap);
        log("✅ Dropdown field created.");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);

    btnRG.addEventListener("click", async () => {
      try {
        if (!state.pdfBytes) { log("Load a PDF first."); return; }

        const sel = getSelectedAnnSafe();
        if (!sel || !sel.bboxN) { log("Select a box mark first (Rect/Patch/Redact)."); return; }

        const pageNum = (state.selected && state.selected.pageNum) ? state.selected.pageNum : (sel.pageNum || 0);
        const id = (state.selected && state.selected.id) ? state.selected.id : sel.id;
        if (!pageNum || !id) { log("Selection missing page/id."); return; }

        const group = String(rgName.value || "").trim();
        const option = String(rgOpt.value || "").trim();
        if (!group) { log("Enter radio group name."); return; }
        if (!option) { log("Enter radio option value (e.g. Yes)."); return; }

        record("form_create_radio_option", { name: group, option, pageNum, bboxN: sel.bboxN });

        // remove the box mark so it doesn't cover the widget
        removeSelectedMark(pageNum, id);

        const annSnap = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        const oplogSnap = Array.isArray(state.oplog) ? state.oplog.slice() : [];
        const selSnap = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()) : [];

        log("Adding radio option via /api/pdf/apply …");
        await applyAndReload(oplogSnap, annSnap, selSnap);
        log("✅ Radio option added.");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);

    btnSet.addEventListener("click", async () => {
      try {
        const name = String(setName.value || "").trim();
        const t = String(setType.value || "text").trim();
        const raw = String(setVal.value || "");

        if (!name) { log("Enter field name."); return; }

        let value = raw;
        if (t === "checkbox") {
          const v = raw.trim().toLowerCase();
          value = (v === "true" || v === "1" || v === "yes" || v === "on");
        }

        record("form_set", { name, fieldType: t, value });

        log("Recorded form_set op (will apply on next export/apply).");
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }, true);
  })();


  // =========================
  // ANN_GUARD_V1
  // - Auto-captures any drift in state.ann into ann_snapshot ops
  // - Guarantees "Use OpLog Annotations" stays correct even if some UI path mutates marks without ann_* ops
  // =========================
  (function(){
    const guardCb = document.getElementById("annGuardToggle");
    const snapBtn = document.getElementById("annSnapshotNowBtn");

    function _clone(o){ return JSON.parse(JSON.stringify(o)); }

    function _stableAnnEntries() {
      try {
        const entries = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];
        // sort pages numerically and anns by id
        entries.sort((a,b) => (a[0]|0) - (b[0]|0));
        for (const e of entries) {
          if (!Array.isArray(e[1])) e[1] = [];
          e[1] = e[1].slice().map(_clone);
          e[1].sort((x,y) => String((x&&x.id)||"").localeCompare(String((y&&y.id)||"")));
        }
        return entries;
      } catch {
        return [];
      }
    }

    function _hashStr(str) {
      // fast DJB2
      let h = 5381;
      for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
      return (h >>> 0).toString(16);
    }

    function _annHash() {
      const entries = _stableAnnEntries();
      return _hashStr(JSON.stringify(entries));
    }

    function _recordOp(kind, payload) {
      try {
        if (typeof recordOp === "function") return recordOp(kind, payload);
      } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    function snapshotNow(reason) {
      try {
        const entries = _stableAnnEntries();
        _recordOp("ann_snapshot", { reason: String(reason || "manual"), entries });
        state.__annGuardLastHash = _annHash();
        state.__annGuardLastOpsLen = Array.isArray(state.oplog) ? state.oplog.length : 0;
        log(`ann_snapshot recorded (${reason || "manual"}).`);
      } catch (e) {
        console.error(e);
        log(String(e && e.message ? e.message : e));
      }
    }

    // Initialize baseline
    try {
      state.__annGuardLastHash = state.__annGuardLastHash || _annHash();
      state.__annGuardLastOpsLen = state.__annGuardLastOpsLen || (Array.isArray(state.oplog) ? state.oplog.length : 0);
    } catch {}

    if (snapBtn) snapBtn.addEventListener("click", () => snapshotNow("snapshot_now"));

    // Every 2s: if ann changed WITHOUT ann_* ops being recorded, snapshot it.
    setInterval(() => {
      try {
        if (!guardCb || !guardCb.checked) return;
        if (!state || !state.pdfBytes) return;

        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        const curOpsLen = state.oplog.length;

        const lastOpsLen = state.__annGuardLastOpsLen || 0;
        const newOps = (curOpsLen > lastOpsLen) ? state.oplog.slice(lastOpsLen) : [];
        const hasRecentAnnOps = newOps.some(o => o && typeof o.kind === "string" && o.kind.startsWith("ann_"));

        const curHash = _annHash();
        const lastHash = state.__annGuardLastHash || "";

        // If marks changed AND we did NOT see ann ops, capture a snapshot.
        if (curHash !== lastHash && !hasRecentAnnOps) {
          snapshotNow("auto_drift");
          return;
        }

        // Otherwise update baseline
        state.__annGuardLastHash = curHash;
        state.__annGuardLastOpsLen = curOpsLen;
      } catch {}
    }, 2000);
  })();


  // =========================
  // ASYNC_JOBS_V1
  // =========================
  (function(){
    const useJobs = document.getElementById("useJobs");
    if (!useJobs) return;

    const u8ToB64 = (u8) => {
      const CH = 0x8000;
      let out = "";
      for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(out);
    };

    const baseName = () => (state.fileName || "document.pdf").replace(/\.pdf$/i,"");

    const buildPayload = () => {
      const useOpAnn = !!document.getElementById("useOpAnn")?.checked;
      const orig = state.__originalPdfBytes || state.pdfBytes;
      const ops = Array.isArray(state.oplog) ? state.oplog : [];
      const ann = (state.ann && state.ann.entries) ? Array.from(state.ann.entries()) : [];

      return {
        originalPdfB64: u8ToB64(orig),
        ops,
        annotations: useOpAnn ? null : ann,
        useOpAnnotations: useOpAnn,
        flatten: true,
        flattenForms: !!document.getElementById("srvFlattenForms")?.checked
      };
    };

    async function submitJob(kind, payload, filename) {
      const r = await fetch("/api/jobs/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, payload, filename })
      });
      const data = await r.json().catch(async()=>({ error: await r.text().catch(()=> "") }));
      if (!r.ok) throw new Error(data?.error || `submit failed: ${r.status}`);
      return data;
    }

    async function pollJob(id) {
      for (;;) {
        const r = await fetch(`/api/jobs/${id}`);
        const j = await r.json().catch(async()=>({ error: await r.text().catch(()=> "") }));
        if (!r.ok) throw new Error(j?.error || `poll failed: ${r.status}`);
        if (j.status === "done") return j;
        if (j.status === "error") throw new Error(j.error || "job error");
        await new Promise(res => setTimeout(res, 900));
      }
    }

    async function downloadJob(job) {
      const url = job.downloadUrl || `/api/jobs/${job.id}/download`;
      const a = document.createElement("a");
      a.href = url;
      a.download = job.filename || "result.bin";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function override(btnId, kind, filenameFn, payloadFn) {
      const btn = document.getElementById(btnId);
      if (!btn || btn.__jobsOverride) return;

      btn.addEventListener("click", async (e) => {
        if (!useJobs.checked) return;
        e.preventDefault();
        e.stopImmediatePropagation();

        try {
          if (!state.pdfBytes) { log("Load a PDF first."); return; }

          const payload = (payloadFn ? payloadFn(e) : buildPayload());
          const filename = filenameFn ? filenameFn(e) : undefined;

          log(`Job queued: ${kind} …`);
          const sub = await submitJob(kind, payload, filename);
          log(`Job id=${sub.id} (polling…)`);

          const done = await pollJob(sub.id);
          log(`✅ Job done: ${done.kind} (${done.bytes || ""})`);

          // JSON jobs will show json in status
          if (done.resultType === "json" && done.json) {
            log("Result:\n" + JSON.stringify(done.json, null, 2).slice(0, 3000));
            return;
          }
          await downloadJob(done);
        } catch (err) {
          console.error(err);
          log(String(err?.message || err));
        }
      }, true);

      btn.__jobsOverride = true;
    }

    // Wire heavy tools
    override("serverOptimizeBtn", "optimize", () => `${baseName()}-optimized.pdf`, () => {
      const p = buildPayload();
      p.preset = document.getElementById("optPreset")?.value || "ebook";
      p.linearize = !!document.getElementById("optLinearize")?.checked;
      return p;
    });

    override("serverSecureRasterBtn", "secure_raster", () => `${baseName()}-secure-raster.pdf`, () => {
      const p = buildPayload();
      const dpiStr = prompt("Raster DPI (e.g. 150/200/300).", "200");
      p.dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));
      return p;
    });

    override("serverSecureRasterSelectiveBtn", "secure_raster_selective", () => `${baseName()}-secure-raster-selective.pdf`, (e) => {
      const p = buildPayload();
      const dpiStr = prompt("Raster DPI (e.g. 150/200/300).", "200");
      p.dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));
      // shift-click uses selected pages
      if (e && e.shiftKey) {
        const sel = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()).sort((a,b)=>a-b) : [];
        if (!sel.length) throw new Error("No pages selected.");
        p.pages = sel;
      } else {
        p.pages = null; // server derives from redact marks
      }
      return p;
    });

    override("serverExtractZipBtn", "extract_zip", () => `${baseName()}-extract.zip`, () => {
      const p = buildPayload();
      p.scope = document.getElementById("srvZipScope")?.value || "selected";
      p.fmt = document.getElementById("srvZipFmt")?.value || "pdf";
      p.dpi = Math.max(72, Math.min(600, parseInt(document.getElementById("srvZipDpi")?.value || "200", 10) || 200));
      if (p.scope === "selected") {
        const sel = (state.pageSel && state.pageSel.size) ? Array.from(state.pageSel.values()).sort((a,b)=>a-b) : [];
        if (!sel.length) throw new Error("No pages selected.");
        p.pages = sel;
      }
      return p;
    });

    override("serverRedactPackageBtn", "redact_package", () => `${baseName()}-redaction-package.zip`, () => {
      const p = buildPayload();
      p.mode = document.getElementById("redactPkgMode")?.value || "selective_raster";
      p.dpi = Math.max(72, Math.min(600, parseInt(document.getElementById("redactPkgDpi")?.value || "200", 10) || 200));
      p.needles = String(document.getElementById("redactPkgNeedles")?.value || "").split(",").map(s=>s.trim()).filter(Boolean);
      return p;
    });

    override("serverTrueRedactBtn", "true_redact", () => `${baseName()}-true-redacted.pdf`, () => buildPayload());
    override("serverTrueRedactPkgBtn", "true_redact_package", () => `${baseName()}-true-redaction-package.zip`, () => {
      const p = buildPayload();
      p.needles = String(document.getElementById("trueRedactPkgNeedles")?.value || "").split(",").map(s=>s.trim()).filter(Boolean);
      return p;
    });

    override("serverVerifyV2Btn", "verify_v2", null, () => {
      const p = buildPayload();
      p.mode = document.getElementById("serverVerifyV2Mode")?.value || "applied";
      p.needles = String(document.getElementById("serverVerifyV2Needles")?.value || "").split(",").map(s=>s.trim()).filter(Boolean);
      if (p.mode === "secure_raster") {
        const dpiStr = prompt("Verify v2 DPI (secure_raster).", "200");
        p.dpi = Math.max(72, Math.min(600, parseInt(dpiStr || "200", 10) || 200));
      }
      return p;
    });

  })();


  // =========================
  // POLISH_SHORTCUTS_LAYERS_V1
  // =========================
  (function(){
    const layersList = document.getElementById("layersList");
    const upBtn = document.getElementById("layerUpBtn");
    const downBtn = document.getElementById("layerDownBtn");
    const delBtn = document.getElementById("layerDeleteBtn");

    function _isTypingTarget(el){
      if (!el) return false;
      const t = (el.tagName || "").toLowerCase();
      return t === "input" || t === "textarea" || el.isContentEditable;
    }

    function _activePage(){
      try {
        if (state && state.selected && state.selected.pageNum) return state.selected.pageNum|0;
      } catch {}
      try {
        if (state && state.currentPage) return state.currentPage|0;
      } catch {}
      try {
        if (state && state.pdf && state.pdf.numPages) return 1;
      } catch {}
      return 1;
    }

    function _getSelected(){
      try { if (typeof getSelectedAnn === "function") return getSelectedAnn(); } catch {}
      try {
        if (!state || !state.selected) return null;
        const pn = state.selected.pageNum|0;
        const id = String(state.selected.id || "");
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : [];
        return list.find(a => a && String(a.id) === id) || null;
      } catch { return null; }
    }

    function _setSelected(pageNum, id){
      try {
        state.selected = { pageNum: pageNum|0, id: String(id||"") };
        if (typeof syncButtons === "function") syncButtons();
        if (typeof redrawOverlay === "function") redrawOverlay(pageNum|0);
        if (typeof redrawAllOverlays === "function") redrawAllOverlays();
      } catch {}
    }

    function _record(kind, payload){
      try { if (typeof recordOp === "function") return recordOp(kind, payload); } catch {}
      try {
        state.oplog = Array.isArray(state.oplog) ? state.oplog : [];
        state.oplog.push({ kind, ts: Date.now(), ...(payload||{}) });
        const el = document.getElementById("opsCount");
        if (el) el.textContent = `Ops: ${state.oplog.length}`;
      } catch {}
    }

    function _deleteSelected(){
      try {
        if (typeof deleteSelected === "function") return deleteSelected();
      } catch {}
      try {
        const sel = state.selected;
        if (!sel) return;
        const pn = sel.pageNum|0;
        const id = String(sel.id||"");
        if (typeof deleteAnn === "function") { deleteAnn(pn, id); return; }
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : null;
        if (!list) return;
        const idx = list.findIndex(a => a && String(a.id) === id);
        if (idx >= 0) list.splice(idx, 1);
        _record("ann_del", { pageNum: pn, id });
        state.selected = null;
        if (typeof redrawOverlay === "function") redrawOverlay(pn);
        if (typeof syncButtons === "function") syncButtons();
      } catch {}
    }

    function _moveLayer(delta){
      try {
        const sel = state.selected;
        if (!sel) return;
        const pn = sel.pageNum|0;
        const id = String(sel.id||"");
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : null;
        if (!list) return;
        const idx = list.findIndex(a => a && String(a.id) === id);
        if (idx < 0) return;
        const nextIdx = idx + delta;
        if (nextIdx < 0 || nextIdx >= list.length) return;
        const tmp = list[idx];
        list[idx] = list[nextIdx];
        list[nextIdx] = tmp;
        // snapshot is safest for reordering
        _record("ann_snapshot", { reason: "layer_reorder", entries: Array.from(state.ann.entries()) });
        if (typeof redrawOverlay === "function") redrawOverlay(pn);
        if (typeof syncButtons === "function") syncButtons();
      } catch {}
    }

    function _annLabel(a){
      const t = a && a.type ? String(a.type) : "mark";
      const id = a && a.id ? String(a.id).slice(0, 6) : "noid";
      let extra = "";
      if (t === "text" && a.text) extra = ` "${String(a.text).slice(0,18)}"`;
      if (t === "form_text" && a.name) extra = ` ${String(a.name)}`;
      if (t === "form_check" && a.name) extra = ` ${String(a.name)}`;
      if (t === "redact") extra = " (redact)";
      return `${t} #${id}${extra}`;
    }

    function refreshLayers(){
      if (!layersList) return;
      try {
        const pn = _activePage();
        const list = (state.ann && state.ann.get) ? (state.ann.get(pn) || []) : [];
        layersList.innerHTML = "";
        if (!list.length) {
          const d = document.createElement("div");
          d.className = "muted";
          d.textContent = "No marks on this page.";
          layersList.appendChild(d);
          return;
        }
        list.forEach((a) => {
          const row = document.createElement("button");
          row.type = "button";
          row.style.display = "block";
          row.style.width = "100%";
          row.style.textAlign = "left";
          row.style.padding = "8px 10px";
          row.style.border = "1px solid rgba(255,255,255,.10)";
          row.style.borderRadius = "10px";
          row.style.background = "rgba(255,255,255,.03)";
          row.style.marginBottom = "8px";
          row.textContent = _annLabel(a);
          row.addEventListener("click", () => _setSelected(pn, a.id), true);
          layersList.appendChild(row);
        });
      } catch {}
    }

    // Buttons
    if (upBtn) upBtn.addEventListener("click", () => _moveLayer(+1), true);
    if (downBtn) downBtn.addEventListener("click", () => _moveLayer(-1), true);
    if (delBtn) delBtn.addEventListener("click", () => _deleteSelected(), true);

    // Hotkeys
    document.addEventListener("keydown", (e) => {
      try {
        if (_isTypingTarget(e.target)) return;

        const key = (e.key || "").toLowerCase();
        const meta = e.metaKey || false;
        const ctrl = e.ctrlKey || false;

        // Undo/redo
        if ((ctrl || meta) && key === "z") { e.preventDefault(); if (typeof undo === "function") undo(); return; }
        if ((ctrl || meta) && (key === "y" || (e.shiftKey && key === "z"))) { e.preventDefault(); if (typeof redo === "function") redo(); return; }

        // Export
        if ((ctrl || meta) && key === "s") {
          e.preventDefault();
          const b = document.getElementById("serverExportBtn") || document.getElementById("exportBtn");
          if (b) b.click();
          return;
        }

        // Delete selected mark
        if (key === "delete" || key === "backspace") { e.preventDefault(); _deleteSelected(); refreshLayers(); return; }

        // Tool hotkeys (best-effort)
        const toolMap = { v:"select", h:"highlight", r:"rect", i:"ink", t:"text", x:"redact", p:"patch" };
        if (toolMap[key]) {
          if (typeof setTool === "function") { setTool(toolMap[key]); e.preventDefault(); return; }
        }

        // Escape: turn off text pick if present
        if (key === "escape") {
          try {
            if (state.__textPick && state.__textPick.enabled) {
              state.__textPick.enabled = false;
              const sEl = document.getElementById("textPickStatus");
              if (sEl) sEl.textContent = "Pick: off";
              e.preventDefault();
              return;
            }
          } catch {}
        }
      } catch {}
    }, true);

    // Refresh layers periodically (cheap + reliable)
    setInterval(refreshLayers, 1000);
    refreshLayers();

  })();
