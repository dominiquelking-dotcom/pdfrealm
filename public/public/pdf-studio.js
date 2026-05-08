// Open-source PDF editor MVP (pages + image stamps added)
// - Viewer: PDF.js (Apache-2.0)
// - Editing/export/forms: pdf-lib (MIT)
//
// Adds in this patch:
// (4) Image stamps (PNG/JPG): choose image, drag to place/size, export embeds image into PDF.
// (5) Page tools: rotate, delete, reorder (drag thumbnails), extract current page, merge PDFs (preview + export).
//
// Notes:
// - This remains pure front-end open-source (no paid SDK).
// - "Edit Text" remains cover+replace (whiteout + redraw) for reliability.

try {
  if (window.pdfjsLib?.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";
  }
} catch {}

const PDFStudio = (() => {
  // ----- Documents model -----
  // docs[0] = primary opened PDF; docs[1..] added via Merge
  // Each page in the editor is referenced by {doc, page}.
  const docs = []; // { bytes:ArrayBuffer, name:string, pdfjsDoc:PDFDocumentProxy|null }
  const pageOrder = []; // Array<{doc:number, page:number}>
  let currentIndex = 1; // 1..pageOrder.length (view index)

  // per page key state
  // Map<string, { anns:any[], undo:any[], redo:any[] }>
  const pages = new Map();
  // Map<string, { viewportScale:number, runs:Array<{str,x,y,w,h}> }>
  const textRuns = new Map();
  // Map<string, number> rotation degrees: 0/90/180/270
  const rotations = new Map();

  // render
  let scale = 1.1;
  let currentViewport = null;
  let baseCanvas = null;
  let overlayCanvas = null;
  let overlayCtx = null;

  // tools
  let tool = "pan";
  let isPointerDown = false;
  let pointerId = null;
  let panStart = null;

  let stroke = null;
  let rectDraft = null;

  // forms
  let formType = "text";
  let fillMode = false;

  // image stamps
  let activeImage = null; // { name, dataUrl, mime }
  const imageCache = new Map(); // dataUrl -> HTMLImageElement

  // misc
  let sourceName = "document.pdf";
  let embed = false;
  let fileId = "";

  const els = {};

  // ----- helpers -----
  const uid = () => "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n)));

  function pageRefKey(ref) { return `${ref.doc}:${ref.page}`; }
  function currentRef() { return pageOrder[currentIndex - 1] || null; }
  function currentKey() { const r = currentRef(); return r ? pageRefKey(r) : ""; }

  function pageStateByKey(key) {
    if (!pages.has(key)) pages.set(key, { anns: [], undo: [], redo: [] });
    return pages.get(key);
  }

  function normalizeRectPdf(r) {
    const x = r.w >= 0 ? r.x : r.x + r.w;
    const y = r.h >= 0 ? r.y : r.y + r.h;
    const w = Math.abs(r.w);
    const h = Math.abs(r.h);
    return { x, y, w, h };
  }

  function hexToRgb(hex) {
    const h = String(hex || "").replace("#", "").trim();
    if (h.length !== 6) return { r: 1, g: 1, b: 1 };
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return { r, g, b };
  }

  function setStatus(s) { if (els.pageInfo) els.pageInfo.textContent = s; }

  function updateUndoRedoButtons() {
    const key = currentKey();
    const ps = pageStateByKey(key);
    els.undoBtn.disabled = ps.undo.length === 0;
    els.redoBtn.disabled = ps.redo.length === 0;
  }

  function pushUndo(key, action) {
    const ps = pageStateByKey(key);
    ps.undo.push(action);
    ps.redo.length = 0;
    updateUndoRedoButtons();
  }

  function toPdfPoint(viewport, x, y) {
    const arr = viewport.convertToPdfPoint(x, y);
    return { x: arr[0], y: arr[1] };
  }

  function toViewportPoint(viewport, x, y) {
    const arr = viewport.convertToViewportPoint(x, y);
    return { x: arr[0], y: arr[1] };
  }

  function canvasPointFromClient(ev, canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvasEl.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvasEl.height / rect.height);
    return { x, y };
  }

  function isInIFrame() {
    try { return window.self !== window.top; } catch { return true; }
  }

  function getRotation(key) {
    return rotations.get(key) || 0;
  }

  function setRotation(key, deg) {
    const norm = ((deg % 360) + 360) % 360;
    const snap = (Math.round(norm / 90) * 90) % 360;
    rotations.set(key, snap);
  }

  async function ensurePdfjsDoc(docIdx) {
    const d = docs[docIdx];
    if (!d) throw new Error("Missing doc " + docIdx);
    if (d.pdfjsDoc) return d.pdfjsDoc;
    d.pdfjsDoc = await pdfjsLib.getDocument({ data: d.bytes }).promise;
    return d.pdfjsDoc;
  }

  // ----- DOM -----
  function cacheEls() {
    els.uploadInput = document.getElementById("pdfStudioUploadInput");
    els.templateBtn = document.getElementById("pdfStudioTemplateBtn");
    els.filename = document.getElementById("pdfStudioFilename");
    els.pageInfo = document.getElementById("pdfStudioPageInfo");
    els.zoomIn = document.getElementById("pdfStudioZoomInBtn");
    els.zoomOut = document.getElementById("pdfStudioZoomOutBtn");
    els.downloadBtn = document.getElementById("pdfStudioDownloadBtn");
    els.doneBtn = document.getElementById("pdfStudioDoneBtn");
    els.thumbs = document.getElementById("pdfStudioThumbs");
    els.canvasContainer = document.getElementById("pdfStudioCanvasContainer");

    els.toolBtns = Array.from(document.querySelectorAll("[data-tool]"));
    els.toolColor = document.getElementById("toolColor");
    els.toolSize = document.getElementById("toolSize");

    els.undoBtn = document.getElementById("pdfStudioUndoBtn");
    els.redoBtn = document.getElementById("pdfStudioRedoBtn");
    els.clearPageBtn = document.getElementById("pdfStudioClearPageBtn");

    els.formType = document.getElementById("formType");
    els.formFillToggle = document.getElementById("formFillToggle");

    els.imagePickBtn = document.getElementById("imagePickBtn");
    els.imagePickInput = document.getElementById("imagePickInput");
    els.imagePickedName = document.getElementById("imagePickedName");
    els.imageOpacity = document.getElementById("imageOpacity");

    els.rotateLeft = document.getElementById("pageRotateLeft");
    els.rotateRight = document.getElementById("pageRotateRight");
    els.pageDelete = document.getElementById("pageDelete");
    els.pageExtract = document.getElementById("pageExtract");
    els.pageMergeBtn = document.getElementById("pageMergeBtn");
    els.pageMergeInput = document.getElementById("pageMergeInput");
  }

  function parseParams() {
    const p = new URLSearchParams(location.search);
    const e = (p.get("embed") || "").toLowerCase();
    embed = (e === "1" || e === "true" || e === "yes") ? true : isInIFrame();
    fileId = (p.get("fileId") || "").trim();
    const name = (p.get("name") || "").trim();
    if (name) sourceName = name;
  }

  function setEmbedUI() {
    if (embed) document.body.classList.add("embed");
  }

  function setTool(next) {
    tool = next;
    for (const b of els.toolBtns || []) b.classList.toggle("tool-active", b.dataset.tool === tool);
    document.body.classList.toggle("form-tool", tool === "form");
    document.body.classList.toggle("image-tool", tool === "image");
    if (overlayCanvas) overlayCanvas.style.cursor = tool === "pan" ? "grab" : "crosshair";
  }

  // ----- load primary PDF -----
  async function loadPrimary(bytes, nameOverride) {
    docs.length = 0;
    pageOrder.length = 0;
    pages.clear();
    textRuns.clear();
    rotations.clear();

    const name = nameOverride || sourceName || "document.pdf";
    docs.push({ bytes, name, pdfjsDoc: null });

    const pdfjsDoc = await ensurePdfjsDoc(0);
    for (let p = 1; p <= pdfjsDoc.numPages; p++) {
      pageOrder.push({ doc: 0, page: p });
      setRotation(`${0}:${p}`, 0);
    }
    currentIndex = 1;
    if (els.filename) els.filename.textContent = name;

    await renderThumbnails();
    await renderCurrent();
  }

  async function loadFromVault(id) {
    setStatus("Loading…");
    const resp = await fetch("/api/vault/file-proxy/" + encodeURIComponent(id), { credentials: "include" });
    if (!resp.ok) throw new Error("Vault download failed (" + resp.status + ")");
    const ab = await resp.arrayBuffer();
    await loadPrimary(ab, sourceName);
  }

  async function handleUploadFile(file) {
    if (!file) return;
    sourceName = file.name || "document.pdf";
    const ab = await file.arrayBuffer();
    await loadPrimary(ab, sourceName);
  }

  // ----- merge PDF (preview + export) -----
  async function mergePdfFile(file) {
    if (!file) return;
    if (pageOrder.length === 0) {
      // If nothing loaded, treat as primary
      await handleUploadFile(file);
      return;
    }

    const ab = await file.arrayBuffer();
    const docIdx = docs.length;
    docs.push({ bytes: ab, name: file.name || `merge_${docIdx}.pdf`, pdfjsDoc: null });

    const pdfjsDoc = await ensurePdfjsDoc(docIdx);
    for (let p = 1; p <= pdfjsDoc.numPages; p++) {
      pageOrder.push({ doc: docIdx, page: p });
      setRotation(`${docIdx}:${p}`, 0);
    }

    await renderThumbnails();
    // keep current page where it is
    await renderCurrent();
  }

  // ----- text runs for editText -----
  async function buildTextRunsForKey(ref, key) {
    try {
      const d = await ensurePdfjsDoc(ref.doc);
      const rot = getRotation(key);
      const page = await d.getPage(ref.page);
      const viewport = page.getViewport({ scale, rotation: rot });

      const tc = await page.getTextContent({ includeMarkedContent: false });
      const runs = [];
      for (const it of (tc.items || [])) {
        if (!it?.str || !String(it.str).trim()) continue;
        if (!it.transform) continue;
        let tx;
        try { tx = pdfjsLib.Util.transform(viewport.transform, it.transform); } catch { continue; }
        const x = tx[4];
        const y = tx[5];
        const h = Math.max(6, Math.hypot(tx[2], tx[3]));
        const w = Math.max(2, (it.width || 0) * scale);
        runs.push({ str: String(it.str), x, y, w, h });
      }
      textRuns.set(key, { viewportScale: scale, runs });
    } catch {}
  }

  function findRunAtPoint(key, vx, vy) {
    const idx = textRuns.get(key);
    if (!idx?.runs) return null;
    const pad = 3;
    for (let i = idx.runs.length - 1; i >= 0; i--) {
      const r = idx.runs[i];
      const left = r.x - pad;
      const right = r.x + r.w + pad;
      const top = r.y - r.h - pad;
      const bottom = r.y + pad;
      if (vx >= left && vx <= right && vy >= top && vy <= bottom) return r;
    }
    return null;
  }

  // ----- render -----
  async function renderCurrent() {
    const ref = currentRef();
    if (!ref) {
      setStatus("Upload a PDF…");
      els.canvasContainer.innerHTML = "";
      return;
    }

    const key = pageRefKey(ref);
    const d = await ensurePdfjsDoc(ref.doc);
    const rot = getRotation(key);

    const page = await d.getPage(ref.page);
    const viewport = page.getViewport({ scale, rotation: rot });
    currentViewport = viewport;

    els.canvasContainer.innerHTML = "";

    const layer = document.createElement("div");
    layer.className = "page-layer";

    baseCanvas = document.createElement("canvas");
    baseCanvas.className = "pdf-base";
    baseCanvas.width = Math.max(1, Math.floor(viewport.width));
    baseCanvas.height = Math.max(1, Math.floor(viewport.height));

    overlayCanvas = document.createElement("canvas");
    overlayCanvas.className = "pdf-overlay";
    overlayCanvas.width = baseCanvas.width;
    overlayCanvas.height = baseCanvas.height;
    overlayCtx = overlayCanvas.getContext("2d");

    layer.appendChild(baseCanvas);
    layer.appendChild(overlayCanvas);
    els.canvasContainer.appendChild(layer);

    const ctx = baseCanvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    buildTextRunsForKey(ref, key).catch(() => {});
    bindOverlayEvents();
    redrawOverlay();

    setStatus(`${currentIndex} / ${pageOrder.length}`);
    highlightThumb(currentIndex);
    updateUndoRedoButtons();
  }

  function highlightThumb(viewIdx) {
    els.thumbs.querySelectorAll(".pdf-thumb").forEach((b) => b.classList.remove("active"));
    const hit = els.thumbs.querySelector(`.pdf-thumb[data-idx="${viewIdx}"]`);
    if (hit) hit.classList.add("active");
  }

  async function renderThumbnails() {
    els.thumbs.innerHTML = "";

    for (let idx = 1; idx <= pageOrder.length; idx++) {
      const ref = pageOrder[idx - 1];
      const key = pageRefKey(ref);
      const d = await ensurePdfjsDoc(ref.doc);

      const page = await d.getPage(ref.page);
      const rot = getRotation(key);
      const viewport = page.getViewport({ scale: 0.22, rotation: rot });

      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.floor(viewport.width));
      c.height = Math.max(1, Math.floor(viewport.height));
      const ctx = c.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pdf-thumb" + (idx === currentIndex ? " active" : "");
      btn.dataset.idx = String(idx);
      btn.draggable = true;

      // header/meta
      const meta = document.createElement("div");
      meta.className = "meta";
      const docSpan = document.createElement("div");
      docSpan.className = "doc";
      docSpan.textContent = docs[ref.doc]?.name || `doc${ref.doc}`;
      const pageSpan = document.createElement("div");
      pageSpan.textContent = `#${idx}`;
      meta.appendChild(docSpan);
      meta.appendChild(pageSpan);

      btn.appendChild(meta);
      btn.appendChild(c);

      btn.addEventListener("click", async () => {
        currentIndex = idx;
        await renderCurrent();
      });

      // drag reorder
      btn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(idx));
        e.dataTransfer.effectAllowed = "move";
      });
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      btn.addEventListener("drop", async (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData("text/plain") || "0", 10);
        const to = idx;
        if (!from || from === to) return;

        const item = pageOrder.splice(from - 1, 1)[0];
        pageOrder.splice(to - 1, 0, item);

        // keep currentIndex stable relative to moved items
        if (currentIndex === from) currentIndex = to;
        else if (from < currentIndex && to >= currentIndex) currentIndex -= 1;
        else if (from > currentIndex && to <= currentIndex) currentIndex += 1;

        await renderThumbnails();
        await renderCurrent();
      });

      els.thumbs.appendChild(btn);
    }
  }

  function changeZoom(delta) {
    scale = clamp(scale + delta, 0.4, 3.0);
    if (pageOrder.length) renderCurrent();
  }

  // ----- overlay drawing -----
  async function getCachedImage(dataUrl) {
    if (imageCache.has(dataUrl)) return imageCache.get(dataUrl);
    const img = new Image();
    const p = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
    });
    img.src = dataUrl;
    imageCache.set(dataUrl, img);
    return p;
  }

  function redrawOverlay() {
    if (!overlayCtx || !overlayCanvas || !currentViewport) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const key = currentKey();
    const ps = pageStateByKey(key);

    for (const ann of ps.anns) drawAnnotation(ann);

    if (rectDraft) drawAnnotation(rectDraft, true);
    if (stroke?.points?.length) drawAnnotation(stroke, true);
  }

  function drawAnnotation(ann, isDraft = false) {
    const ctx = overlayCtx;
    const vp = currentViewport;

    if (ann.type === "stroke") {
      const pts = ann.points || [];
      if (pts.length < 2) return;
      const w = (ann.width || 2) * scale;
      const { r, g, b } = ann.color || { r: 1, g: 1, b: 1 };
      const a = ann.opacity == null ? 1 : ann.opacity;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = toViewportPoint(vp, pts[i].x, pts[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (ann.type === "rect") {
      const r = normalizeRectPdf(ann);
      const p1 = toViewportPoint(vp, r.x, r.y);
      const p2 = toViewportPoint(vp, r.x + r.w, r.y + r.h);
      const vx = Math.min(p1.x, p2.x);
      const vy = Math.min(p1.y, p2.y);
      const vw = Math.abs(p2.x - p1.x);
      const vh = Math.abs(p2.y - p1.y);

      const { r:rr, g, b } = ann.color || { r: 1, g: 1, b: 0 };
      const a = ann.opacity == null ? 0.18 : ann.opacity;

      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgb(${Math.round(rr*255)},${Math.round(g*255)},${Math.round(b*255)})`;
      ctx.fillRect(vx, vy, vw, vh);
      ctx.globalAlpha = isDraft ? 0.9 : 0.75;
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgb(${Math.round(rr*255)},${Math.round(g*255)},${Math.round(b*255)})`;
      ctx.strokeRect(vx, vy, vw, vh);
      ctx.restore();
      return;
    }

    if (ann.type === "text") {
      const { r, g, b } = ann.color || { r: 1, g: 1, b: 1 };
      const p = toViewportPoint(vp, ann.x, ann.y);
      const size = (ann.size || 12) * scale;
      ctx.save();
      ctx.fillStyle = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
      ctx.font = `${Math.max(8, Math.floor(size))}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(String(ann.text || ""), p.x, p.y);
      ctx.restore();
      return;
    }

    if (ann.type === "textReplace") {
      const r = normalizeRectPdf(ann);
      const p1 = toViewportPoint(vp, r.x, r.y);
      const p2 = toViewportPoint(vp, r.x + r.w, r.y + r.h);
      const vx = Math.min(p1.x, p2.x);
      const vy = Math.min(p1.y, p2.y);
      const vw = Math.abs(p2.x - p1.x);
      const vh = Math.abs(p2.y - p1.y);

      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = "white";
      ctx.fillRect(vx, vy, vw, vh);
      ctx.globalAlpha = isDraft ? 0.95 : 0.55;
      ctx.strokeStyle = "rgba(47,109,246,.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vx, vy, vw, vh);

      const { r:rr, g, b } = ann.color || { r: 0, g: 0, b: 0 };
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgb(${Math.round(rr*255)},${Math.round(g*255)},${Math.round(b*255)})`;
      const pxSize = Math.max(9, Math.floor((ann.size || 12) * scale));
      ctx.font = `${pxSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(String(ann.text || ""), vx + 2, vy + vh - 2);
      ctx.restore();
      return;
    }

    if (ann.type === "formField") {
      const r = normalizeRectPdf(ann);
      const p1 = toViewportPoint(vp, r.x, r.y);
      const p2 = toViewportPoint(vp, r.x + r.w, r.y + r.h);
      const vx = Math.min(p1.x, p2.x);
      const vy = Math.min(p1.y, p2.y);
      const vw = Math.abs(p2.x - p1.x);
      const vh = Math.abs(p2.y - p1.y);

      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "rgba(47,109,246,.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vx, vy, vw, vh);
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "rgba(47,109,246,.20)";
      ctx.fillRect(vx, vy, vw, Math.min(18, vh));

      ctx.globalAlpha = 1;
      ctx.fillStyle = "#e7ecff";
      ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textBaseline = "top";
      const label = `${ann.fieldType || "text"}: ${ann.name || ""}`;
      ctx.fillText(label.slice(0, 40), vx + 6, vy + 2);

      if (fillMode) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "rgba(231,236,255,.9)";
        const v = ann.fieldType === "checkbox" ? (ann.value ? "☑" : "☐") : String(ann.value || "");
        ctx.textBaseline = "alphabetic";
        ctx.fillText(v.slice(0, 60), vx + 6, vy + vh - 6);
      }
      ctx.restore();
      return;
    }

    // (4) image stamp
    if (ann.type === "imageStamp") {
      const r = normalizeRectPdf(ann);
      const p1 = toViewportPoint(vp, r.x, r.y);
      const p2 = toViewportPoint(vp, r.x + r.w, r.y + r.h);
      const vx = Math.min(p1.x, p2.x);
      const vy = Math.min(p1.y, p2.y);
      const vw = Math.abs(p2.x - p1.x);
      const vh = Math.abs(p2.y - p1.y);

      const opacity = ann.opacity == null ? 0.9 : ann.opacity;

      // draw async image (best effort)
      const dataUrl = ann.dataUrl;
      if (dataUrl) {
        getCachedImage(dataUrl).then((img) => {
          if (!overlayCtx) return;
          overlayCtx.save();
          overlayCtx.globalAlpha = opacity;
          overlayCtx.drawImage(img, vx, vy, vw, vh);
          overlayCtx.restore();
          // border after image
          overlayCtx.save();
          overlayCtx.globalAlpha = isDraft ? 0.9 : 0.55;
          overlayCtx.strokeStyle = "rgba(47,109,246,.9)";
          overlayCtx.lineWidth = 2;
          overlayCtx.strokeRect(vx, vy, vw, vh);
          overlayCtx.restore();
        }).catch(() => {});
      }
      // border placeholder
      ctx.save();
      ctx.globalAlpha = isDraft ? 0.9 : 0.55;
      ctx.strokeStyle = "rgba(47,109,246,.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vx, vy, vw, vh);
      ctx.restore();
      return;
    }
  }

  // ----- hit tests -----
  function hitTestFormField(key, pdfX, pdfY) {
    const ps = pageStateByKey(key);
    for (let i = ps.anns.length - 1; i >= 0; i--) {
      const a = ps.anns[i];
      if (a.type !== "formField") continue;
      const r = normalizeRectPdf(a);
      if (pdfX >= r.x && pdfX <= r.x + r.w && pdfY >= r.y && pdfY <= r.y + r.h) return a;
    }
    return null;
  }

  // ----- overlay events -----
  function bindOverlayEvents() {
    overlayCanvas.onpointerdown = onPointerDown;
    overlayCanvas.onpointermove = onPointerMove;
    overlayCanvas.onpointerup = onPointerUp;
    overlayCanvas.onpointercancel = onPointerUp;
    overlayCanvas.style.cursor = tool === "pan" ? "grab" : "crosshair";
  }

  function addAnnotation(key, ann) {
    const ps = pageStateByKey(key);
    ps.anns.push(ann);
    pushUndo(key, { type: "add", ann });
    redrawOverlay();
  }

  function onPointerDown(ev) {
    if (!currentViewport || !overlayCanvas) return;
    if (ev.button != null && ev.button !== 0) return;

    isPointerDown = true;
    pointerId = ev.pointerId;
    try { overlayCanvas.setPointerCapture(pointerId); } catch {}

    if (tool === "pan") {
      overlayCanvas.style.cursor = "grabbing";
      panStart = {
        x: ev.clientX,
        y: ev.clientY,
        scrollLeft: els.canvasContainer.scrollLeft,
        scrollTop: els.canvasContainer.scrollTop,
      };
      return;
    }

    const key = currentKey();
    const pt = canvasPointFromClient(ev, overlayCanvas);
    const pdfPt = toPdfPoint(currentViewport, pt.x, pt.y);

    // Edit existing text
    if (tool === "editText") {
      const run = findRunAtPoint(key, pt.x, pt.y);
      if (!run) { isPointerDown = false; pointerId = null; return; }

      const newText = window.prompt("Replace text:", run.str);
      if (!newText || !newText.trim()) { isPointerDown = false; pointerId = null; return; }

      const left = run.x;
      const right = run.x + run.w;
      const top = run.y - run.h;
      const bottom = run.y;

      const pdfA = toPdfPoint(currentViewport, left, top);
      const pdfB = toPdfPoint(currentViewport, right, bottom);

      const minX = Math.min(pdfA.x, pdfB.x);
      const minY = Math.min(pdfA.y, pdfB.y);
      const w = Math.abs(pdfB.x - pdfA.x);
      const h = Math.abs(pdfB.y - pdfA.y);

      const color = hexToRgb(els.toolColor.value || "#000000");
      const size = clamp(h * 0.78, 6, 72);

      addAnnotation(key, { id: uid(), type: "textReplace", x: minX, y: minY, w, h, text: newText.trim(), color, size });
      isPointerDown = false;
      pointerId = null;
      return;
    }

    // Form tool
    if (tool === "form") {
      if (fillMode) {
        const hit = hitTestFormField(key, pdfPt.x, pdfPt.y);
        if (!hit) { isPointerDown = false; pointerId = null; return; }

        if (hit.fieldType === "checkbox") {
          hit.value = !hit.value;
        } else if (hit.fieldType === "dropdown") {
          const opts = (hit.options && hit.options.length) ? hit.options : ["Option 1", "Option 2"];
          const val = window.prompt("Select one of: " + opts.join(", "), hit.value || opts[0]);
          if (val != null) hit.value = val;
        } else {
          const val = window.prompt("Value:", hit.value || "");
          if (val != null) hit.value = val;
        }
        redrawOverlay();
        isPointerDown = false;
        pointerId = null;
        return;
      }

      rectDraft = {
        id: uid(),
        type: "formField",
        fieldType: formType,
        name: "",
        value: formType === "checkbox" ? false : "",
        options: formType === "dropdown" ? ["Option 1", "Option 2"] : [],
        x: pdfPt.x, y: pdfPt.y, w: 0, h: 0,
      };
      redrawOverlay();
      return;
    }

    // Image tool
    if (tool === "image") {
      if (!activeImage?.dataUrl) {
        alert("Choose an image first (Image → Choose Image), then drag to place it.");
        isPointerDown = false;
        pointerId = null;
        return;
      }
      rectDraft = {
        id: uid(),
        type: "imageStamp",
        x: pdfPt.x, y: pdfPt.y, w: 0, h: 0,
        dataUrl: activeImage.dataUrl,
        mime: activeImage.mime,
        opacity: Number(els.imageOpacity?.value || 0.9),
      };
      redrawOverlay();
      return;
    }

    // Other tools
    const sizePx = Number(els.toolSize.value || 3);
    const widthPdf = Math.max(0.5, sizePx / scale);
    const color = hexToRgb(els.toolColor.value || "#ffffff");

    if (tool === "pen" || tool === "highlight") {
      stroke = {
        id: uid(),
        type: "stroke",
        mode: tool,
        color: tool === "highlight" ? { r: 1, g: 1, b: 0 } : color,
        opacity: tool === "highlight" ? 0.35 : 1,
        width: tool === "highlight" ? Math.max(1.0, widthPdf * 4) : widthPdf,
        points: [pdfPt],
      };
      redrawOverlay();
      return;
    }

    if (tool === "rect") {
      rectDraft = { id: uid(), type: "rect", color, opacity: 0.18, x: pdfPt.x, y: pdfPt.y, w: 0, h: 0 };
      redrawOverlay();
      return;
    }

    if (tool === "text") {
      const t = window.prompt("Text:");
      if (t && t.trim()) addAnnotation(key, { id: uid(), type: "text", text: t.trim(), color, size: 12, x: pdfPt.x, y: pdfPt.y });
      isPointerDown = false;
      pointerId = null;
      return;
    }
  }

  function onPointerMove(ev) {
    if (!isPointerDown || (pointerId != null && ev.pointerId !== pointerId)) return;

    if (tool === "pan") {
      if (!panStart) return;
      const dx = ev.clientX - panStart.x;
      const dy = ev.clientY - panStart.y;
      els.canvasContainer.scrollLeft = panStart.scrollLeft - dx;
      els.canvasContainer.scrollTop = panStart.scrollTop - dy;
      return;
    }

    if (!currentViewport || !overlayCanvas) return;
    const pt = canvasPointFromClient(ev, overlayCanvas);
    const pdfPt = toPdfPoint(currentViewport, pt.x, pt.y);

    if (stroke) {
      stroke.points.push(pdfPt);
      redrawOverlay();
      return;
    }

    if (rectDraft && (tool === "rect" || tool === "form" || tool === "image")) {
      rectDraft.w = pdfPt.x - rectDraft.x;
      rectDraft.h = pdfPt.y - rectDraft.y;
      redrawOverlay();
    }
  }

  function onPointerUp(ev) {
    if (pointerId != null && ev.pointerId !== pointerId) return;
    isPointerDown = false;
    try { overlayCanvas.releasePointerCapture(pointerId); } catch {}
    pointerId = null;

    if (tool === "pan") {
      panStart = null;
      overlayCanvas.style.cursor = "grab";
      return;
    }

    const key = currentKey();

    if (stroke) {
      if ((stroke.points || []).length >= 2) addAnnotation(key, stroke);
      stroke = null;
      redrawOverlay();
      return;
    }

    // finalize rect
    if (rectDraft && tool === "rect") {
      if (Math.abs(rectDraft.w) > 1 && Math.abs(rectDraft.h) > 1) addAnnotation(key, rectDraft);
      rectDraft = null;
      redrawOverlay();
      return;
    }

    // finalize form field
    if (rectDraft && tool === "form" && !fillMode) {
      const { w, h } = normalizeRectPdf(rectDraft);
      if (w < 6 || h < 6) { rectDraft = null; redrawOverlay(); return; }

      const defaultName = `${rectDraft.fieldType}_${key}_${Math.floor(rectDraft.x)}_${Math.floor(rectDraft.y)}`;
      let name = window.prompt("Field name:", defaultName) || defaultName;
      name = String(name).trim() || defaultName;

      if (rectDraft.fieldType === "dropdown") {
        const raw = window.prompt("Dropdown options (comma-separated):", "Option 1, Option 2") || "Option 1, Option 2";
        const opts = raw.split(",").map(s => s.trim()).filter(Boolean);
        rectDraft.options = opts.length ? opts : ["Option 1", "Option 2"];
        rectDraft.value = rectDraft.options[0] || "";
      }

      rectDraft.name = name;
      addAnnotation(key, rectDraft);
      rectDraft = null;
      redrawOverlay();
      return;
    }

    // finalize image stamp
    if (rectDraft && tool === "image") {
      const { w, h } = normalizeRectPdf(rectDraft);
      if (w < 6 || h < 6) { rectDraft = null; redrawOverlay(); return; }
      rectDraft.opacity = Number(els.imageOpacity?.value || rectDraft.opacity || 0.9);
      addAnnotation(key, rectDraft);
      rectDraft = null;
      redrawOverlay();
      return;
    }
  }

  // ----- Undo/Redo/Clear -----
  function undo() {
    const key = currentKey();
    const ps = pageStateByKey(key);
    const action = ps.undo.pop();
    if (!action) return;

    if (action.type === "add") {
      ps.anns = ps.anns.filter((a) => a.id !== action.ann.id);
      ps.redo.push(action);
    } else if (action.type === "clearPage") {
      ps.anns = action.prev;
      ps.redo.push(action);
    }
    pages.set(key, ps);
    redrawOverlay();
    updateUndoRedoButtons();
  }

  function redo() {
    const key = currentKey();
    const ps = pageStateByKey(key);
    const action = ps.redo.pop();
    if (!action) return;

    if (action.type === "add") {
      ps.anns.push(action.ann);
      ps.undo.push(action);
    } else if (action.type === "clearPage") {
      const prev = ps.anns.slice();
      ps.anns = [];
      ps.undo.push({ type: "clearPage", prev });
    }
    pages.set(key, ps);
    redrawOverlay();
    updateUndoRedoButtons();
  }

  function clearPage() {
    const key = currentKey();
    const ps = pageStateByKey(key);
    if (ps.anns.length === 0) return;
    const prev = ps.anns.slice();
    ps.anns = [];
    pushUndo(key, { type: "clearPage", prev });
    pages.set(key, ps);
    redrawOverlay();
  }

  // ----- Page tools -----
  async function rotateCurrent(delta) {
    const ref = currentRef();
    if (!ref) return;
    const key = pageRefKey(ref);
    const r = getRotation(key);
    setRotation(key, r + delta);
    await renderThumbnails();
    await renderCurrent();
  }

  async function deleteCurrentPage() {
    if (pageOrder.length <= 1) {
      alert("Can't delete the last remaining page.");
      return;
    }
    pageOrder.splice(currentIndex - 1, 1);
    currentIndex = clamp(currentIndex, 1, pageOrder.length);
    await renderThumbnails();
    await renderCurrent();
  }

  // ----- Export (all / current) -----
  function dataUrlToU8(dataUrl) {
    const parts = String(dataUrl).split(",");
    if (parts.length < 2) return new Uint8Array();
    const b64 = parts[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function exportBytes(mode = "all") {
    if (!window.PDFLib) throw new Error("pdf-lib not loaded.");
    if (!docs.length || !pageOrder.length) throw new Error("No PDF loaded yet.");

    const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

    // Load each source doc once
    const srcDocs = [];
    for (let i = 0; i < docs.length; i++) {
      srcDocs[i] = await PDFDocument.load(docs[i].bytes);
    }

    const out = await PDFDocument.create();
    const helv = await out.embedFont(StandardFonts.Helvetica);
    const form = out.getForm();
    let usedForm = false;

    const usedNames = new Set();
    function uniqueName(base) {
      let n = base;
      let i = 2;
      while (usedNames.has(n)) n = `${base}_${i++}`;
      usedNames.add(n);
      return n;
    }

    const refs = (mode === "current") ? [currentRef()] : pageOrder.slice();
    const indices = (mode === "current") ? [currentIndex] : null;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!ref) continue;
      const key = pageRefKey(ref);

      const src = srcDocs[ref.doc];
      const [copied] = await out.copyPages(src, [ref.page - 1]);
      out.addPage(copied);

      // apply rotation
      const rot = getRotation(key);
      try { copied.setRotation(degrees(rot)); } catch {}

      // apply edits
      const ps = pageStateByKey(key);
      for (const ann of ps.anns) {
        if (ann.type === "stroke") {
          const pts = ann.points || [];
          if (pts.length < 2) continue;
          const col = ann.color || { r: 1, g: 1, b: 1 };
          const color = rgb(col.r, col.g, col.b);
          const opacity = ann.opacity == null ? 1 : ann.opacity;
          const thickness = Math.max(0.5, Number(ann.width || 2));
          for (let k = 1; k < pts.length; k++) {
            copied.drawLine({
              start: { x: pts[k - 1].x, y: pts[k - 1].y },
              end: { x: pts[k].x, y: pts[k].y },
              thickness, color, opacity,
            });
          }
          continue;
        }

        if (ann.type === "rect") {
          const col = ann.color || { r: 1, g: 1, b: 0 };
          const color = rgb(col.r, col.g, col.b);
          const opacity = ann.opacity == null ? 0.18 : ann.opacity;
          const r = normalizeRectPdf(ann);
          copied.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color, opacity });
          continue;
        }

        if (ann.type === "text") {
          const col = ann.color || { r: 1, g: 1, b: 1 };
          const color = rgb(col.r, col.g, col.b);
          const size = Math.max(6, Number(ann.size || 12));
          copied.drawText(String(ann.text || ""), { x: ann.x, y: ann.y, size, font: helv, color });
          continue;
        }

        if (ann.type === "textReplace") {
          const r = normalizeRectPdf(ann);
          copied.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1,1,1), opacity: 1 });

          const col = ann.color || { r: 0, g: 0, b: 0 };
          const color = rgb(col.r, col.g, col.b);
          const size = Math.max(6, Number(ann.size || (r.h * 0.78)));
          const baselineY = r.y + r.h - Math.max(2, size * 0.15);

          copied.drawText(String(ann.text || ""), {
            x: r.x + 2,
            y: baselineY - size,
            size, font: helv, color,
          });
          continue;
        }

        if (ann.type === "formField") {
          const r = normalizeRectPdf(ann);
          const safe = String(ann.name || `field_${uid()}`).replace(/\s+/g, "_");
          const name = uniqueName(`${safe}_${key}`);
          const ft = ann.fieldType || "text";
          usedForm = true;

          if (ft === "checkbox") {
            const cb = form.createCheckBox(name);
            cb.addToPage(copied, { x: r.x, y: r.y, width: r.w, height: r.h });
            if (ann.value) cb.check();
            continue;
          }

          if (ft === "dropdown") {
            const dd = form.createDropdown(name);
            const opts = Array.isArray(ann.options) && ann.options.length ? ann.options : ["Option 1", "Option 2"];
            dd.addOptions(opts.map(String));
            dd.addToPage(copied, { x: r.x, y: r.y, width: r.w, height: r.h });
            if (ann.value) { try { dd.select(String(ann.value)); } catch {} }
            continue;
          }

          const tf = form.createTextField(name);
          tf.addToPage(copied, { x: r.x, y: r.y, width: r.w, height: r.h });
          if (ann.value) tf.setText(String(ann.value));
          try { tf.setFontSize(Math.max(8, Math.min(18, r.h * 0.65))); } catch {}
          continue;
        }

        // (4) Image stamps
        if (ann.type === "imageStamp") {
          const r = normalizeRectPdf(ann);
          const opacity = ann.opacity == null ? 0.9 : ann.opacity;

          const u8 = dataUrlToU8(ann.dataUrl || "");
          if (!u8.length) continue;

          const mime = String(ann.mime || "").toLowerCase();
          let emb;
          if (mime.includes("jpeg") || mime.includes("jpg")) emb = await out.embedJpg(u8);
          else emb = await out.embedPng(u8);

          copied.drawImage(emb, { x: r.x, y: r.y, width: r.w, height: r.h, opacity });
          continue;
        }
      }
    }

    if (usedForm) {
      try { form.updateFieldAppearances(helv); } catch {}
    }

    const bytes = await out.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  function downloadBytes(ab, filename) {
    const blob = new Blob([ab], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "document.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function handleDownloadAll() {
    try {
      setStatus("Exporting…");
      const ab = await exportBytes("all");
      downloadBytes(ab, sourceName || "document.pdf");
      setStatus(`${currentIndex} / ${pageOrder.length}`);
    } catch (e) {
      console.error(e);
      alert(e?.message || String(e));
      setStatus("Export failed");
    }
  }

  async function handleExtractCurrent() {
    try {
      setStatus("Extracting…");
      const ab = await exportBytes("current");
      const fn = (sourceName || "document.pdf").replace(/\.pdf$/i, "") + `-page-${currentIndex}.pdf`;
      downloadBytes(ab, fn);
      setStatus(`${currentIndex} / ${pageOrder.length}`);
    } catch (e) {
      console.error(e);
      alert(e?.message || String(e));
      setStatus("Extract failed");
    }
  }

  // ----- messaging API (host iframe integration) -----
  function setupMessaging() {
    window.addEventListener("message", async (ev) => {
      const d = ev?.data;
      if (!d || typeof d !== "object") return;

      if (d.type === "PDFSTUDIO_OPEN_BYTES") {
        try {
          if (d.name) sourceName = String(d.name);
          if (els.filename) els.filename.textContent = sourceName;
          await loadPrimary(d.bytes, sourceName);
        } catch (e) {
          console.error(e);
          alert(e?.message || String(e));
        }
      }

      if (d.type === "PDFSTUDIO_EXPORT") {
        const nonce = d.nonce;
        try {
          const bytes = await exportBytes("all");
          const target = ev.source || window.parent;
          try {
            target?.postMessage({ type: "PDFSTUDIO_EXPORT_RESULT", nonce, ok: true, bytes }, "*");
          } catch {
            window.parent?.postMessage({ type: "PDFSTUDIO_EXPORT_RESULT", nonce, ok: true, bytes }, "*");
          }
        } catch (err) {
          const msg = err?.message || String(err);
          try {
            (ev.source || window.parent)?.postMessage({ type: "PDFSTUDIO_EXPORT_RESULT", nonce, ok: false, error: msg }, "*");
          } catch {}
        }
      }
    });
  }

  function done() {
    try { window.parent?.postMessage({ type: "PDFSTUDIO_DONE" }, "*"); } catch {}
  }

  // ----- UI actions -----
  async function chooseImageFile(file) {
    if (!file) return;
    if (!/image\/(png|jpeg)/i.test(file.type)) {
      alert("Only PNG or JPEG supported right now.");
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });

    activeImage = { name: file.name || "image", dataUrl: String(dataUrl), mime: file.type || "image/png" };
    if (els.imagePickedName) els.imagePickedName.textContent = activeImage.name;
  }

  function bindEvents() {
    els.uploadInput?.addEventListener("change", async () => {
      const f = els.uploadInput.files?.[0];
      if (f) await handleUploadFile(f);
    });

    els.zoomIn?.addEventListener("click", () => changeZoom(0.1));
    els.zoomOut?.addEventListener("click", () => changeZoom(-0.1));

    els.downloadBtn?.addEventListener("click", handleDownloadAll);
    els.doneBtn?.addEventListener("click", done);

    els.templateBtn?.addEventListener("click", () => alert("Template library coming soon."));

    els.undoBtn?.addEventListener("click", undo);
    els.redoBtn?.addEventListener("click", redo);
    els.clearPageBtn?.addEventListener("click", clearPage);

    els.formType?.addEventListener("change", () => { formType = els.formType.value; });
    els.formFillToggle?.addEventListener("click", () => {
      fillMode = !fillMode;
      els.formFillToggle.textContent = `Fill: ${fillMode ? "On" : "Off"}`;
      els.formFillToggle.setAttribute("aria-pressed", fillMode ? "true" : "false");
      redrawOverlay();
    });

    // image controls
    els.imagePickBtn?.addEventListener("click", () => els.imagePickInput?.click());
    els.imagePickInput?.addEventListener("change", async () => {
      const f = els.imagePickInput.files?.[0];
      if (f) await chooseImageFile(f);
      // allow re-pick same file
      els.imagePickInput.value = "";
    });
    els.imageOpacity?.addEventListener("input", () => {
      if (rectDraft?.type === "imageStamp") rectDraft.opacity = Number(els.imageOpacity.value || rectDraft.opacity || 0.9);
      redrawOverlay();
    });

    // page tools
    els.rotateLeft?.addEventListener("click", () => rotateCurrent(-90));
    els.rotateRight?.addEventListener("click", () => rotateCurrent(90));
    els.pageDelete?.addEventListener("click", deleteCurrentPage);
    els.pageExtract?.addEventListener("click", handleExtractCurrent);
    els.pageMergeBtn?.addEventListener("click", () => els.pageMergeInput?.click());
    els.pageMergeInput?.addEventListener("change", async () => {
      const f = els.pageMergeInput.files?.[0];
      if (f) await mergePdfFile(f);
      els.pageMergeInput.value = "";
    });

    for (const b of els.toolBtns || []) b.addEventListener("click", () => setTool(b.dataset.tool));

    setTool("pan");
  }

  // ----- init -----
  async function init() {
    cacheEls();
    parseParams();
    setEmbedUI();
    bindEvents();
    setupMessaging();

    if (els.filename) els.filename.textContent = sourceName;

    if (fileId) {
      try { await loadFromVault(fileId); }
      catch (e) { console.error(e); setStatus("Load failed"); alert(e?.message || String(e)); }
    } else {
      setStatus("Upload a PDF…");
    }
  }

  return { init };
})();

(function () {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => PDFStudio.init());
  else PDFStudio.init();
})();
