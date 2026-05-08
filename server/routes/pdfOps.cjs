const express = require("express");
const JSZip = require("jszip");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { PDFDocument, degrees, rgb, StandardFonts } = require("pdf-lib");

const router = express.Router();
router.use(express.json({ limit: "250mb" }));

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function b64ToU8(b64) {
  if (!b64) return new Uint8Array();
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function u8ToB64(u8) {
  return Buffer.from(u8).toString("base64");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

function normToPdfRect(pageW, pageH, bboxN) {
  const x = bboxN.x * pageW;
  const yTop = bboxN.y * pageH;
  const w = bboxN.w * pageW;
  const h = bboxN.h * pageH;
  const y = pageH - yTop - h;
  return { x, y, w, h };
}

function hexToRgb01(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const to = (s) => ((parseInt(s, 16) || 0) / 255);
  if (h.length === 3) return [to(h[0] + h[0]), to(h[1] + h[1]), to(h[2] + h[2])];
  if (h.length >= 6) return [to(h.slice(0, 2)), to(h.slice(2, 4)), to(h.slice(4, 6))];
  return [1, 1, 0];
}

// -----------------------------
// Apply ops SEQUENTIALLY (page + forms), so order is deterministic.
// Supported ops:
//  page_reorder, page_delete, page_duplicate, page_insert_blank, page_rotate
//  form_create_text, form_create_check, form_set
// -----------------------------

// REDACTOR_TEXT_REPLACE_V1 (op kind: text_replace)
async function redactorReplaceTextBytes(pdfBytes, find, replace, opts = {}) {
  const payload = {
    pdf_b64: Buffer.from(pdfBytes).toString("base64"),
    find: String(find || ""),
    replace: String(replace || ""),
    pages: Array.isArray(opts.pages) ? opts.pages : null,
    match_case: !!opts.matchCase,
    whole_word: !!opts.wholeWord,
    fill_rgb: [1,1,1],
    text_rgb: [0,0,0],
  };

  const r = await fetch("http://redactor:9100/replace_text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`redactor replace_text failed: ${r.status} ${t}`);
  }

  const data = await r.json();
  if (!data || !data.out_pdf_b64) throw new Error("redactor replace_text returned no output");
  return Buffer.from(String(data.out_pdf_b64), "base64");
}


// REDACTOR_REPLACE_RECT_V1 (op kind: text_replace_rect)
async function redactorReplaceRectBytes(pdfBytes, pageNum, bboxN, text) {
  const payload = {
    pdf_b64: Buffer.from(pdfBytes).toString("base64"),
    page: pageNum | 0,
    bboxN,
    text: String(text ?? ""),
    fill_rgb: [1,1,1],
    text_rgb: [0,0,0],
  };

  const r = await fetch("http://redactor:9100/replace_rect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`redactor replace_rect failed: ${r.status} ${t}`);
  }

  const data = await r.json();
  if (!data || !data.out_pdf_b64) throw new Error("redactor replace_rect returned no output");
  return Buffer.from(String(data.out_pdf_b64), "base64");
}


async function applyOpsToBytes(originalBytes, ops = []) {
  let cur = originalBytes;

  for (const op of ops) {
    if (!op || !op.kind) continue;

    // ---- page ops ----
    if (op.kind === "page_reorder" && Array.isArray(op.order) && op.order.length) {
      const src = await PDFDocument.load(cur);
      const out = await PDFDocument.create();
      const idxs = op.order.map((p) => (p | 0) - 1).filter((i) => i >= 0 && i < src.getPageCount());
      const copied = await out.copyPages(src, idxs);
      copied.forEach((p) => out.addPage(p));
      cur = await out.save({ useObjectStreams: true });
      continue;
    }

    if (op.kind === "page_delete" && Array.isArray(op.pages) && op.pages.length) {
      const doc = await PDFDocument.load(cur);
      const desc = [...op.pages]
        .map((p) => p | 0)
        .filter((p) => p >= 1 && p <= doc.getPageCount())
        .sort((a, b) => b - a);
      for (const pn of desc) doc.removePage(pn - 1);
      cur = await doc.save({ useObjectStreams: true });
      continue;
    }

    if (op.kind === "page_duplicate" && Array.isArray(op.pages) && op.pages.length) {
      const doc = await PDFDocument.load(cur);
      const idxs = [...op.pages]
        .map((p) => (p | 0) - 1)
        .filter((i) => i >= 0 && i < doc.getPageCount())
        .sort((a, b) => a - b);
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

    if (op.kind === "page_insert_blank" && (op.beforePage | 0) >= 1) {
      const doc = await PDFDocument.load(cur);
      const before = op.beforePage | 0;
      const ref = doc.getPage(0);
      const size = ref ? ref.getSize() : { width: 612, height: 792 };
      const at = Math.max(0, Math.min(doc.getPageCount(), before - 1));
      doc.insertPage(at, [size.width, size.height]);
      cur = await doc.save({ useObjectStreams: true });
      continue;
    }

    if (op.kind === "page_rotate" && Array.isArray(op.pages) && op.pages.length && (op.delta | 0)) {
      const doc = await PDFDocument.load(cur);
      const asc = [...op.pages]
        .map((p) => p | 0)
        .filter((p) => p >= 1 && p <= doc.getPageCount())
        .sort((a, b) => a - b);
      for (const pn of asc) {
        const page = doc.getPage(pn - 1);
        const curRot = page.getRotation().angle || 0;
        const next = ((curRot + (op.delta | 0)) % 360 + 360) % 360;
        page.setRotation(degrees(next));
      }
      cur = await doc.save({ useObjectStreams: true });
      continue;
    }

    // ---- form ops ----
    if (op.kind === "form_create_text" || op.kind === "form_create_check" || op.kind === "form_create_dropdown" || op.kind === "form_create_radio_option") {
      const doc = await PDFDocument.load(cur);
      let form;
      try { form = doc.getForm(); } catch { form = doc.getForm(); }

      const name = String(op.name || "").trim();
      const pageNum = op.pageNum | 0;
      const bboxN = op.bboxN;
      if (!name || !pageNum || !bboxN) {
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }
      if (pageNum < 1 || pageNum > doc.getPageCount()) {
        cur = await doc.save({ useObjectStreams: true });
        continue;
      }

      const page = doc.getPage(pageNum - 1);
      const { width: pageW, height: pageH } = page.getSize();
      const { x, y, w, h } = normToPdfRect(pageW, pageH, bboxN);

      try {
        if (op.kind === "form_create_text") {
          let tf;
          try { tf = form.getTextField(name); } catch { tf = form.createTextField(name); }
          tf.addToPage(page, { x, y, width: w, height: h, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
        } else if (op.kind === "form_create_check") {
          let cb;
          try { cb = form.getCheckBox(name); } catch { cb = form.createCheckBox(name); }
          const sz = Math.min(w, h);
          cb.addToPage(page, { x, y, width: sz, height: sz, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
        } else if (op.kind === "form_create_dropdown") {
          let dd;
          try { dd = form.getDropdown(name); } catch { dd = form.createDropdown(name); }
          const opts = Array.isArray(op.options) ? op.options.map(String) : [];
          try { if (opts.length) dd.setOptions(opts); } catch {}
          dd.addToPage(page, { x, y, width: w, height: h, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
        } else if (op.kind === "form_create_radio_option") {
          let rg;
          try { rg = form.getRadioGroup(name); } catch { rg = form.createRadioGroup(name); }
          const opt = String(op.option || op.value || "Option");
          // pdf-lib radio groups place each option as its own widget
          rg.addOptionToPage(opt, page, { x, y, width: w, height: h, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
        }
      } catch {}

      cur = await doc.save({ useObjectStreams: true });
      continue;
    }

    if (op.kind === "form_set") {
      const doc = await PDFDocument.load(cur);
      let form;
      try { form = doc.getForm(); } catch { form = doc.getForm(); }

      const name = String(op.name || "").trim();
      const fieldType = String(op.fieldType || "").toLowerCase();
      const value = op.value;

      if (name) {
        try {
          if (fieldType === "checkbox") {
            const cb = form.getCheckBox(name);
            if (!!value) cb.check(); else cb.uncheck();
          } else {
            const tf = form.getTextField(name);
            tf.setText(String(value ?? ""));
          }
        } catch {}
      }

      cur = await doc.save({ useObjectStreams: true });
      continue;
    }

    // ---- text replace op (server) ----
    if (op.kind === "text_replace") {
      const find = op.find || op.q || "";
      const replace = op.replace || op.r || "";
      const pages = Array.isArray(op.pages) ? op.pages : null;
      const matchCase = !!op.matchCase;
      const wholeWord = !!op.wholeWord;

      if (String(find).trim().length) {
        cur = await redactorReplaceTextBytes(cur, find, replace, { pages, matchCase, wholeWord });
      }
      continue;
    }

    // ---- bounded text replace (rect) ----
    if (op.kind === "text_replace_rect") {
      const pageNum = (op.pageNum|0);
      const bboxN = op.bboxN;
      const text = op.text ?? op.replace ?? "";
      if (pageNum >= 1 && bboxN && typeof bboxN.x === "number") {
        cur = await redactorReplaceRectBytes(cur, pageNum, bboxN, text);
      }
      continue;
    }


  }

  return cur;
}

// -----------------------------
// Flatten overlay marks (annotations) into PDF content
// -----------------------------
async function flattenAnnotations(bytes, annotationsEntries) {
  const doc = await PDFDocument.load(bytes);

  const fontHelv = await doc.embedFont(StandardFonts.Helvetica);
  const fontTimes = await doc.embedFont(StandardFonts.TimesRoman);
  const fontCourier = await doc.embedFont(StandardFonts.Courier);

  const imageCache = new Map();
  const byPage = new Map(annotationsEntries || []);

  for (const [pageNumRaw, list] of byPage.entries()) {
    const pageNum = pageNumRaw | 0;
    if (!pageNum || pageNum < 1 || pageNum > doc.getPageCount()) continue;
    if (!Array.isArray(list) || list.length === 0) continue;

    const page = doc.getPage(pageNum - 1);
    const { width: pageW, height: pageH } = page.getSize();

    for (const a of list) {
      if (!a || !a.type || !a.bboxN) continue;

      const style = a.style || {};
      const [r, g, b] = hexToRgb01(style.color || "#ffea00");
      const op = typeof style.opacity === "number" ? style.opacity : 0.35;

      if (a.type === "patch") {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(r, g, b), opacity: 1 });
      } else if (a.type === "redact") {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0), opacity: 1 });
      } else if (a.type === "highlight") {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(r, g, b), opacity: op });
      } else if (a.type === "rect") {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        page.drawRectangle({
          x, y, width: w, height: h,
          borderColor: rgb(r, g, b),
          borderWidth: Math.max(0.5, (style.width || 4) * 0.5),
          borderOpacity: 1
        });
      } else if (a.type === "ink" && Array.isArray(a.points)) {
        const thick = Math.max(0.5, (style.width || 4) * 0.6);
        for (let i = 1; i < a.points.length; i++) {
          const p0 = a.points[i - 1], p1 = a.points[i];
          const x1 = p0.xN * pageW, y1 = pageH - (p0.yN * pageH);
          const x2 = p1.xN * pageW, y2 = pageH - (p1.yN * pageH);
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: thick, color: rgb(r, g, b), opacity: 1 });
        }
      } else if (a.type === "text") {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        const size = Math.max(8, Math.min(96, style.fontSize || 18));
        const pad = 6;
        const maxW = Math.max(10, w - pad * 2);
        const lineH = size * 1.2;

        const font = style.font === "serif" ? fontTimes : (style.font === "mono" ? fontCourier : fontHelv);
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
          page.drawText(ln, { x: x + pad, y: yy, size, font, color: rgb(r, g, b) });
          yy -= lineH;
          if (yy < y + pad) break;
        }
      } else if ((a.type === "image" || a.type === "signature") && a.dataUrl) {
        const { x, y, w, h } = normToPdfRect(pageW, pageH, a.bboxN);
        const dataUrl = String(a.dataUrl);
        if (!imageCache.has(dataUrl)) {
          const base64 = (dataUrl.split(",")[1] || "");
          const buf = Buffer.from(base64, "base64");
          if (dataUrl.startsWith("data:image/png")) imageCache.set(dataUrl, await doc.embedPng(buf));
          else imageCache.set(dataUrl, await doc.embedJpg(buf));
        }
        const img = imageCache.get(dataUrl);
        if (img) page.drawImage(img, { x, y, width: w, height: h });
      }
    }
  }

  return await doc.save({ useObjectStreams: true });
}

async function flattenForms(bytes) {
  const doc = await PDFDocument.load(bytes);
  try {
    const form = doc.getForm();
    form.flatten();
  } catch {}
  return await doc.save({ useObjectStreams: true });
}

// full raster (ghostscript) for all pages
async function secureRasterizePdfBytes(inPdfBytes, dpi = 200) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-raster-"));
  const inPath = path.join(tmpDir, "in.pdf");
  const outPattern = path.join(tmpDir, "page-%03d.png");

  try {
    await fsp.writeFile(inPath, Buffer.from(inPdfBytes));
    await execFileP("gs", [
      "-dSAFER","-dBATCH","-dNOPAUSE",
      "-sDEVICE=png16m",
      `-r${Math.max(72, Math.min(600, dpi | 0))}`,
      `-sOutputFile=${outPattern}`,
      inPath
    ], { maxBuffer: 1024 * 1024 * 64 });

    const files = (await fsp.readdir(tmpDir)).filter(f => /^page-\d{3}\.png$/.test(f)).sort();
    const srcDoc = await PDFDocument.load(inPdfBytes);
    const outDoc = await PDFDocument.create();

    for (let i = 0; i < files.length; i++) {
      const pngBytes = await fsp.readFile(path.join(tmpDir, files[i]));
      const img = await outDoc.embedPng(pngBytes);
      const srcPage = srcDoc.getPage(i);
      const { width, height } = srcPage.getSize();
      const page = outDoc.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
    }

    return await outDoc.save({ useObjectStreams: true });
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// selective raster (ghostscript) for selected pages
async function secureRasterizeSelectedPagesPdfBytes(inPdfBytes, pagesSet, dpi = 200) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-rsel-"));
  const inPath = path.join(tmpDir, "in.pdf");

  try {
    await fsp.writeFile(inPath, Buffer.from(inPdfBytes));

    const flatDoc = await PDFDocument.load(inPdfBytes);
    const outDoc = await PDFDocument.create();
    const pageCount = flatDoc.getPageCount();

    for (let i = 0; i < pageCount; i++) {
      const pn = i + 1;

      if (pagesSet && pagesSet.has(pn)) {
        const outPng = path.join(tmpDir, `p-${String(pn).padStart(4, "0")}.png`);
        await execFileP("gs", [
          "-dSAFER","-dBATCH","-dNOPAUSE",
          "-sDEVICE=png16m",
          `-r${Math.max(72, Math.min(600, dpi | 0))}`,
          `-dFirstPage=${pn}`,
          `-dLastPage=${pn}`,
          `-sOutputFile=${outPng}`,
          inPath
        ], { maxBuffer: 1024 * 1024 * 64 });

        const pngBytes = await fsp.readFile(outPng);
        const img = await outDoc.embedPng(pngBytes);

        const srcPage = flatDoc.getPage(i);
        const { width, height } = srcPage.getSize();
        const page = outDoc.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      } else {
        const [cp] = await outDoc.copyPages(flatDoc, [i]);
        outDoc.addPage(cp);
      }
    }

    return await outDoc.save({ useObjectStreams: true });
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// -----------------------------
// /apply (core)
// -----------------------------

function deriveAnnotationsFromOps(ops, initialPageCount) {
  const map = new Map();
  let pageCount = initialPageCount | 0;

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const ensure = (pn) => {
    if (!map.has(pn)) map.set(pn, []);
    return map.get(pn);
  };

  const reorder = (order) => {
    const old = new Map(map);
    map.clear();
    for (let newPn = 1; newPn <= order.length; newPn++) {
      const oldPn = order[newPn - 1] | 0;
      const list = clone(old.get(oldPn) || []);
      for (const a of list) a.pageNum = newPn;
      map.set(newPn, list);
    }
    pageCount = order.length;
  };

  const delPages = (pages) => {
    const del = new Set((pages || []).map(p => p|0));
    const old = new Map(map);
    map.clear();
    let deletedSoFar = 0;
    for (let oldPn = 1; oldPn <= pageCount; oldPn++) {
      if (del.has(oldPn)) { deletedSoFar++; continue; }
      const newPn = oldPn - deletedSoFar;
      const list = clone(old.get(oldPn) || []);
      for (const a of list) a.pageNum = newPn;
      map.set(newPn, list);
    }
    pageCount = Math.max(0, pageCount - del.size);
  };

  const insertBlank = (beforePage) => {
    const bp = beforePage | 0;
    const old = new Map(map);
    map.clear();
    for (let oldPn = 1; oldPn <= pageCount; oldPn++) {
      const newPn = (oldPn >= bp) ? (oldPn + 1) : oldPn;
      const list = clone(old.get(oldPn) || []);
      for (const a of list) a.pageNum = newPn;
      map.set(newPn, list);
    }
    map.set(bp, []);
    pageCount += 1;
  };

  const duplicatePages = (pages) => {
    const selSorted = [...new Set((pages || []).map(p=>p|0))].filter(p=>p>=1 && p<=pageCount).sort((a,b)=>a-b);
    const selSet = new Set(selSorted);
    const old = new Map(map);
    map.clear();

    const countBefore = (i) => {
      let c = 0;
      for (const p of selSorted) { if (p < i) c++; else break; }
      return c;
    };

    for (let i = 1; i <= pageCount; i++) {
      const base = i + countBefore(i);
      const origList = clone(old.get(i) || []);
      for (const a of origList) a.pageNum = base;
      map.set(base, origList);

      if (selSet.has(i)) {
        const dupList = clone(old.get(i) || []);
        for (const a of dupList) a.pageNum = base + 1;
        map.set(base + 1, dupList);
      }
    }
    pageCount += selSorted.length;
  };

  for (const op of (ops || [])) {
    if (!op || !op.kind) continue;

    // page ops update the annotation map too
    if (op.kind === "page_reorder" && Array.isArray(op.order)) reorder(op.order);
    else if (op.kind === "page_delete" && Array.isArray(op.pages)) delPages(op.pages);
    else if (op.kind === "page_insert_blank" && (op.beforePage|0) >= 1) insertBlank(op.beforePage|0);
    else if (op.kind === "page_duplicate" && Array.isArray(op.pages)) duplicatePages(op.pages);

    // annotation ops
    else if (op.kind === "ann_add") {
      const pn = (op.pageNum|0) || ((op.ann && op.ann.pageNum)|0);
      if (!pn) continue;
      const a = clone(op.ann || {});
      a.pageNum = pn;
      if (!a.id) a.id = op.id || (Math.random().toString(16).slice(2) + Date.now().toString(16));
      ensure(pn).push(a);
    } else if (op.kind === "ann_update") {
      const pn = (op.pageNum|0) || ((op.next && op.next.pageNum)|0) || ((op.prev && op.prev.pageNum)|0);
      const id = op.id || (op.next && op.next.id) || (op.prev && op.prev.id);
      if (!pn || !id) continue;
      const list = ensure(pn);
      const idx = list.findIndex(x => x && x.id === id);
      const next = clone(op.next || op.ann || {});
      next.id = id;
      next.pageNum = pn;
      if (idx >= 0) list[idx] = next;
      else list.push(next);
    } else if (op.kind === "ann_del") {
      const pn = (op.pageNum|0) || ((op.ann && op.ann.pageNum)|0);
      const id = op.id || (op.ann && op.ann.id);
      if (!pn || !id) continue;
      const list = ensure(pn);
      const idx = list.findIndex(x => x && x.id === id);
      if (idx >= 0) list.splice(idx, 1);
    } else if (op.kind === "ann_snapshot") {
      // reset to snapshot entries
      map.clear();
      try {
        for (const pair of (op.entries || [])) {
          const pn = (pair && pair[0])|0;
          const list = clone((pair && pair[1]) || []);
          for (const a of list) a.pageNum = pn;
          if (pn) map.set(pn, list);
        }
        const keys = Array.from(map.keys());
        pageCount = keys.length ? Math.max(...keys) : pageCount;
      } catch {}
    }
    else if (op.kind === "ann_clear") {
      map.clear();
    }
  }

  return Array.from(map.entries());
}

router.post("/apply", async (req, res) => {
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;
    const flattenAnn = body.flatten !== false;
    const flattenFormsFlag = !!body.flattenForms;

    
    const __hasAnnOps = ops.some(o => o && typeof o.kind === 'string' && o.kind.startsWith('ann_'));
    let annEntries = annotations;
    if ((body.useOpAnnotations || !annEntries) && __hasAnnOps) {
      const baseDoc = await PDFDocument.load(originalBytes);
      const basePages = baseDoc.getPageCount();
      annEntries = deriveAnnotationsFromOps(ops, basePages);
    }
const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = (flattenAnn && annotations) ? await flattenAnnotations(applied, annEntries) : applied;
    const final = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="applied.pdf"');
    res.status(200).send(Buffer.from(final));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// /secure-raster (full)
router.post("/secure-raster", async (req, res) => {
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;
    const dpi = body.dpi | 0 || 200;
    const flattenFormsFlag = !!body.flattenForms;

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    const rasterPdf = await secureRasterizePdfBytes(withForms, dpi);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="secure-raster.pdf"');
    res.status(200).send(Buffer.from(rasterPdf));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// /secure-raster-selective (default: pages containing redact marks, or explicit pages[])
router.post("/secure-raster-selective", async (req, res) => {
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;
    const dpi = body.dpi | 0 || 200;
    const flattenFormsFlag = !!body.flattenForms;

    let pages = Array.isArray(body.pages) ? body.pages : null;
    const pagesSet = new Set();

    if (pages && pages.length) {
      pages.forEach(p => { const n = p|0; if (n >= 1) pagesSet.add(n); });
    } else if (annotations) {
      const byPage = new Map(annotations);
      for (const [pageNumRaw, list] of byPage.entries()) {
        const pn = pageNumRaw | 0;
        if (!pn || !Array.isArray(list)) continue;
        if (list.some(a => a && a.type === "redact")) pagesSet.add(pn);
      }
    }

    if (!pagesSet.size) return res.status(400).json({ error: "no pages to rasterize (add redact marks or provide pages[])" });

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    const rasterPdf = await secureRasterizeSelectedPagesPdfBytes(withForms, pagesSet, dpi);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="secure-raster-selective.pdf"');
    res.status(200).send(Buffer.from(rasterPdf));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// /optimize (ghostscript + optional qpdf linearize)
router.post("/optimize", async (req, res) => {
  let tmpDir = null;
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;

    const preset = String(body.preset || "ebook").toLowerCase();
    const presetMap = { screen: "/screen", ebook: "/ebook", printer: "/printer", prepress: "/prepress" };
    const pdfSettings = presetMap[preset] || "/ebook";

    const linearize = !!body.linearize;
    const flattenFormsFlag = !!body.flattenForms;

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-opt-"));
    const inPath = path.join(tmpDir, "in.pdf");
    const gsOut = path.join(tmpDir, "gs.pdf");
    const outPath = linearize ? path.join(tmpDir, "out.pdf") : gsOut;

    await fsp.writeFile(inPath, Buffer.from(withForms));

    await execFileP("gs", [
      "-dSAFER","-dBATCH","-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=${pdfSettings}`,
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dQUIET",
      `-sOutputFile=${gsOut}`,
      inPath
    ], { maxBuffer: 1024 * 1024 * 64 });

    if (linearize) {
      await execFileP("qpdf", ["--linearize", gsOut, outPath], { maxBuffer: 1024 * 1024 * 64 });
    }

    const outBytes = await fsp.readFile(outPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="optimized.pdf"');
    res.status(200).send(outBytes);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  } finally {
    try { if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// /verify (pdftotext)
router.post("/verify", async (req, res) => {
  let tmpDir = null;
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;

    const mode = String(body.mode || "applied"); // applied | secure_raster
    const dpi = body.dpi | 0 || 200;
    const flattenFormsFlag = !!body.flattenForms;

    let needles = body.needles;
    if (typeof needles === "string") needles = needles.split(",").map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(needles)) needles = [];
    const needlesLower = needles.map(s => String(s).toLowerCase()).filter(Boolean);

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    let verifyBytes = withForms;
    if (mode === "secure_raster") verifyBytes = await secureRasterizePdfBytes(withForms, dpi);

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-verify-"));
    const inPath = path.join(tmpDir, "in.pdf");
    await fsp.writeFile(inPath, Buffer.from(verifyBytes));

    const { stdout } = await execFileP("pdftotext", ["-q", "-layout", inPath, "-"], { maxBuffer: 1024 * 1024 * 64 });
    const text = String(stdout || "");
    const pages = text.split("\f");

    const anyText = text.replace(/\s+/g, "").length > 0;

    const hits = [];
    for (const needle of needlesLower) {
      let count = 0;
      const pagesWithHits = [];
      for (let i = 0; i < pages.length; i++) {
        const pg = (pages[i] || "").toLowerCase();
        if (pg.includes(needle)) {
          pagesWithHits.push(i + 1);
          count += pg.split(needle).length - 1;
        }
      }
      if (count > 0) hits.push({ needle, count, pages: pagesWithHits });
    }

    res.status(200).json({
      ok: true,
      mode,
      dpi: (mode === "secure_raster") ? dpi : null,
      bytes: verifyBytes.length,
      sha256: sha256(verifyBytes),
      anyText,
      totalChars: text.length,
      needles: needlesLower,
      hits
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  } finally {
    try { if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// /extract-zip (pdf per page or png per page)
router.post("/extract-zip", async (req, res) => {
  let tmpDir = null;
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;

    const fmt = String(body.fmt || "pdf").toLowerCase(); // pdf|png
    const scope = String(body.scope || "selected").toLowerCase(); // selected|all
    const dpi = Math.max(72, Math.min(600, (body.dpi | 0) || 200));
    const flattenFormsFlag = !!body.flattenForms;

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    const srcDoc = await PDFDocument.load(withForms);
    const total = srcDoc.getPageCount();

    let pages = [];
    if (scope === "all") {
      pages = Array.from({ length: total }, (_, i) => i + 1);
    } else {
      pages = Array.isArray(body.pages) ? body.pages : [];
      pages = pages.map(p => p|0).filter(p => p >= 1 && p <= total);
      pages = Array.from(new Set(pages)).sort((a,b)=>a-b);
      if (!pages.length) return res.status(400).json({ error: "no pages provided for selected scope" });
    }

    const zip = new JSZip();

    if (fmt === "png") {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-extract-"));
      const inPath = path.join(tmpDir, "in.pdf");
      await fsp.writeFile(inPath, Buffer.from(withForms));

      for (const pn of pages) {
        const outPng = path.join(tmpDir, `p-${String(pn).padStart(4, "0")}.png`);
        await execFileP("gs", [
          "-dSAFER","-dBATCH","-dNOPAUSE",
          "-sDEVICE=png16m",
          `-r${dpi}`,
          `-dFirstPage=${pn}`,
          `-dLastPage=${pn}`,
          `-sOutputFile=${outPng}`,
          inPath
        ], { maxBuffer: 1024 * 1024 * 64 });

        zip.file(`page-${String(pn).padStart(4,"0")}.png`, await fsp.readFile(outPng));
      }
    } else {
      for (const pn of pages) {
        const out = await PDFDocument.create();
        const [cp] = await out.copyPages(srcDoc, [pn - 1]);
        out.addPage(cp);
        zip.file(`page-${String(pn).padStart(4,"0")}.pdf`, Buffer.from(await out.save({ useObjectStreams: true })));
      }
    }

    const outZip = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="extract.zip"');
    res.status(200).send(outZip);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  } finally {
    try { if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// /redact-package (ZIP)
router.post("/redact-package", async (req, res) => {
  let tmpDir = null;
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;

    const mode = String(body.mode || "selective_raster").toLowerCase(); // selective_raster|full_raster|no_raster
    const dpi = Math.max(72, Math.min(600, (body.dpi | 0) || 200));
    const flattenFormsFlag = !!body.flattenForms;

    let needles = body.needles;
    if (typeof needles === "string") needles = needles.split(",").map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(needles)) needles = [];
    const needlesLower = needles.map(s => String(s).toLowerCase()).filter(Boolean);

    const redactionPages = new Set();
    const redactionBoxes = [];
    if (annotations) {
      const byPage = new Map(annotations);
      for (const [pageNumRaw, list] of byPage.entries()) {
        const pn = pageNumRaw | 0;
        if (!pn || !Array.isArray(list)) continue;
        for (const a of list) {
          if (a && a.type === "redact" && a.bboxN) {
            redactionPages.add(pn);
            redactionBoxes.push({ page: pn, bboxN: a.bboxN });
          }
        }
      }
    }

    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annotations ? await flattenAnnotations(applied, annotations) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    let finalPdf = withForms;
    let rasterNote = null;

    if (mode === "full_raster") {
      finalPdf = await secureRasterizePdfBytes(withForms, dpi);
    } else if (mode === "selective_raster") {
      if (!redactionPages.size) return res.status(400).json({ error: "no redact marks found for selective_raster" });
      finalPdf = await secureRasterizeSelectedPagesPdfBytes(withForms, redactionPages, dpi);
    } else if (mode === "no_raster") {
      rasterNote = "no_raster selected; text under redactions may still be extractable";
    } else {
      return res.status(400).json({ error: "invalid mode" });
    }

    // verify with pdftotext
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdfrealm-redactpkg-"));
    const inPath = path.join(tmpDir, "out.pdf");
    await fsp.writeFile(inPath, Buffer.from(finalPdf));

    const { stdout } = await execFileP("pdftotext", ["-q", "-layout", inPath, "-"], { maxBuffer: 1024 * 1024 * 64 });
    const text = String(stdout || "");
    const pages = text.split("\f");
    const anyText = text.replace(/\s+/g, "").length > 0;

    const hits = [];
    for (const needle of needlesLower) {
      let count = 0;
      const pagesWithHits = [];
      for (let i = 0; i < pages.length; i++) {
        const pg = (pages[i] || "").toLowerCase();
        if (pg.includes(needle)) {
          pagesWithHits.push(i + 1);
          count += pg.split(needle).length - 1;
        }
      }
      if (count > 0) hits.push({ needle, count, pages: pagesWithHits });
    }

    const report = {
      ok: true,
      kind: "pdfrealm_redact_package_v2",
      ts: Date.now(),
      mode,
      dpi: mode.includes("raster") ? dpi : null,
      rasterNote,
      opsCount: ops.length,
      flattenForms: flattenFormsFlag,
      needles: needlesLower,
      verify: { anyText, totalChars: text.length, hits },
      redactions: { pages: Array.from(redactionPages).sort((a,b)=>a-b), boxes: redactionBoxes },
      hashes: {
        original: sha256(originalBytes),
        appliedOps: sha256(applied),
        withAnn: sha256(withAnn),
        final: sha256(finalPdf),
        opsJson: sha256(Buffer.from(JSON.stringify(ops)))
      },
      bytes: {
        original: originalBytes.length,
        appliedOps: applied.length,
        withAnn: withAnn.length,
        final: finalPdf.length
      }
    };

    const zip = new JSZip();
    zip.file("redacted.pdf", Buffer.from(finalPdf));
    zip.file("report.json", JSON.stringify(report, null, 2));

    const outZip = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="redaction-package.zip"');
    res.status(200).send(outZip);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  } finally {
    try { if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});


// TRUE redaction via PyMuPDF microservice (object removal under boxes)
router.post("/true-redact", async (req, res) => {
  try {
    const body = req.body || {};
    const originalBytes = b64ToU8(body.originalPdfB64);
    if (!originalBytes || originalBytes.length === 0) return res.status(400).json({ error: "missing originalPdfB64" });

    const ops = Array.isArray(body.ops) ? body.ops : [];
    const annotations = body.annotations || (body.snapshot && body.snapshot.annotations) || null;
    const flattenFormsFlag = !!body.flattenForms;

    // collect redact boxes from annotations
    const redactions = [];
    if (annotations) {
      const byPage = new Map(annotations);
      for (const [pageNumRaw, list] of byPage.entries()) {
        const pn = pageNumRaw | 0;
        if (!pn || !Array.isArray(list)) continue;
        for (const a of list) {
          if (a && a.type === "redact" && a.bboxN) {
            redactions.push({ page: pn, bboxN: a.bboxN });
          }
        }
      }
    }
    if (!redactions.length) return res.status(400).json({ error: "no redact marks found (add Redact boxes first)" });

    // flatten NON-redact annotations so we keep highlights/ink/text/images, but let redactor draw the black box
    let annNoRedact = null;
    if (annotations) {
      const out = [];
      const byPage = new Map(annotations);
      for (const [pn, list] of byPage.entries()) {
        const keep = (Array.isArray(list) ? list.filter(a => a && a.type !== "redact") : []);
        out.push([pn, keep]);
      }
      annNoRedact = out;
    }

    // apply ops first
    const applied = await applyOpsToBytes(originalBytes, ops);
    const withAnn = annNoRedact ? await flattenAnnotations(applied, annNoRedact) : applied;
    const withForms = flattenFormsFlag ? await flattenForms(withAnn) : withAnn;

    // call redactor service
    const payload = {
      pdf_b64: Buffer.from(withForms).toString("base64"),
      redactions,
      fill_rgb: [0, 0, 0],
      remove_images: true
    };

    const r = await fetch("http://redactor:9100/redact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      return res.status(502).json({ error: `redactor failed: ${r.status} ${t}` });
    }

    const data = await r.json();
    if (!data || !data.out_pdf_b64) return res.status(502).json({ error: "redactor returned no output" });

    const outBytes = Buffer.from(String(data.out_pdf_b64), "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="true-redacted.pdf"');
    return res.status(200).send(outBytes);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});



// Hit-test text by point (proxy to redactor)
router.post("/text-hit", async (req, res) => {
  try {
    const body = req.body || {};
    const pdfB64 = body.pdfB64 || body.pdf_b64 || null;
    const page = body.page | 0;
    const xN = Number(body.xN);
    const yN = Number(body.yN);

    if (!pdfB64 || !page || !Number.isFinite(xN) || !Number.isFinite(yN)) {
      return res.status(400).json({ error: "missing pdfB64/page/xN/yN" });
    }

    const payload = { pdf_b64: String(pdfB64), page, xN, yN };

    const r = await fetch("http://redactor:9100/text_hit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      return res.status(502).json({ error: `redactor text_hit failed: ${r.status} ${t}` });
    }

    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});


module.exports = router;
