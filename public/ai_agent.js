(() => {
  "use strict";

  const state = {
    uploadId: null,
    uploadName: null,
    running: false,
  };

  const qs = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v === false || v === null || typeof v === "undefined") {}
      else n.setAttribute(k, String(v));
    }
    for (const c of kids) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  };

  function ensureStyles() {
    if (qs("#aiopInlineStyles")) return;
    const css = `
      #aiOperatorModal .modal-card { max-height: 92vh; display:flex; flex-direction:column; overflow:hidden; }
      #aiOperatorModal .modal-body { flex:1; min-height:0; overflow:auto; }
      #aiOperatorModal #aiOpLog { height: 32vh; overflow:auto; padding-right:6px; }
      #aiOperatorModal textarea#aiOpInput { width:100%; min-height:96px; resize:vertical; }
      #aiOperatorModal .aiop-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      #aiOperatorModal .aiop-muted { color: var(--muted); font-size: 0.9rem; }
      #aiOperatorModal .aiop-pill { padding: 3px 8px; border-radius:999px; background: rgba(255,255,255,0.08); font-size: 0.8rem; }
      #aiOperatorModal .aiop-line { padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06); white-space:pre-wrap; word-break:break-word; }
    `;
    document.head.appendChild(el("style", { id: "aiopInlineStyles" }, [css]));
  }

  function openModalCompat(modal) {
    if (!modal) return;
    const id = modal.id || "aiOperatorModal";
    // Prefer the app's global modal helpers (they expect an ID string)
    if (typeof window.openModal === "function") {
      try { window.openModal(id); } catch (_) {}
    }
    // Always apply classes as a fallback so the UI never appears "dead"
    modal.classList.add("open");
    modal.classList.add("modal-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModalCompat(modal) {
    if (!modal) return;
    const id = modal.id || "aiOperatorModal";
    if (typeof window.closeModal === "function") {
      try { window.closeModal(id); } catch (_) {}
    }
    modal.classList.remove("open");
    modal.classList.remove("modal-open");
    modal.setAttribute("aria-hidden", "true");
  }

  function setStatus(t) {
    const n = qs("#aiOpStatus");
    if (n) n.textContent = t || "";
  }

  function logLine(msg, kind = "info") {
    const box = qs("#aiOpLog");
    if (!box) return;
    box.prepend(el("div", { class: "aiop-line aiop-" + kind }, [String(msg ?? "")]));
  }

  async function readTextSafe(r) {
    try { return await r.text(); } catch (_) { return ""; }
  }

  async function postJSON(url, payload) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let data = null;
    if (ct.includes("application/json")) {
      try { data = await r.json(); } catch (_) { data = null; }
    }
    if (data === null) {
      const t = await readTextSafe(r);
      data = t ? { text: t } : {};
    }
    return { ok: r.ok, status: r.status, data };
  }

  function normalizePlan(d) {
    if (!d) return null;
    if (typeof d === "string") return d;
    if (d.plan) return typeof d.plan === "string" ? d.plan : JSON.stringify(d.plan, null, 2);
    if (d.steps) return Array.isArray(d.steps) ? d.steps.map((s,i)=>`${i+1}. ${s}`).join("\n") : JSON.stringify(d.steps, null, 2);
    if (d.text) return String(d.text);
    if (d.message) return String(d.message);
    return null;
  }

  function normalizeResult(d) {
    if (!d) return null;
    if (typeof d === "string") return d;
    for (const k of ["result","output","text","message"]) {
      if (d[k]) return typeof d[k] === "string" ? d[k] : JSON.stringify(d[k], null, 2);
    }
    return JSON.stringify(d, null, 2);
  }

  async function uploadFile(file) {
  if (!file) return null;

  setStatus("Uploading...");
  logLine("Uploading: " + file.name, "info");

  const fd = new FormData();
  fd.append("file", file);

  let r;
  try {
    r = await fetch("/api/ai/upload", { method: "POST", body: fd });
  } catch (e) {
    logLine("Upload failed: " + (e?.message || String(e)), "error");
    setStatus("Upload failed");
    return null;
  }

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let data = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch (_) { data = null; }
  }
  if (!data) {
    const t = await readTextSafe(r);
    data = t ? { text: t } : {};
  }

  if (!r.ok) {
    const err = data.error || data.message || data.text || ("Upload failed (HTTP " + r.status + ")");
    logLine(err, "error");
    setStatus("Upload failed");
    return null;
  }

  const id = data.uploadId || data.upload_id || data.id || data.fileId || data.file_id || data.documentId || data.document_id || null;
  const name = data.filename || data.name || file.name;

  if (!id) {
    const dbg = data && (data.error || data.message || data.text) ? (data.error || data.message || data.text) : JSON.stringify(data, null, 2);
    logLine("Upload response did not include an uploadId/fileId.\n" + dbg, "error");
    setStatus("Upload failed");
    return null;
  }

  state.uploadId = String(id);
  state.uploadName = name;

  const badge = qs("#aiOpUploadBadge");
  if (badge) {
    badge.textContent = "Attached: " + state.uploadName;
    badge.style.display = "inline-flex";
  }

  logLine("Upload OK: " + state.uploadName + " (id=" + state.uploadId + ")", "result");
  setStatus("");
  return state.uploadId;
}

async function uploadSelectedFile() {
  const inp = qs("#aiOpFile");
  const file = inp && inp.files && inp.files[0];
  if (!file) {
    alert("Choose a document first.");
    return null;
  }
  return await uploadFile(file);
}

function findCurrentDocumentFile() {
  // If the user already picked a file in ANY tool, reuse it automatically.
  // Priority list covers the most common tool inputs; then we fall back to scanning all file inputs.
  const priorityIds = [
    "studioFile",
    "splitPdfFile",
    "deletePdfFile",
    "mergeFile1",
    "mergeFile2",
    "compressPdfFile",
    "rotatePdfFile",
    "reorderPdfFile",
    "watermarkPdfFile",
    "metaPdfFile",
    "flattenPdfFile",
    "repairPdfFile",
    "resizePdfFile",
    "pageNumsPdfFile",
    "stampPdfFile",
    "redactPdfFile",
    "pdf2pngFile",
    "pdf2jpgFile",
    "pdf2txtFile",
    "pdf2csvFile",
    "pdf2pptxFile",
    "pdf2xlsxFile",
    "pdfcropFile",
    "visualdiffA",
    "visualdiffB"
  ];

  for (const id of priorityIds) {
    const inp = document.getElementById(id);
    const f = inp?.files?.[0];
    if (f) return f;
  }

  const isVisible = (node) => {
    try {
      if (!node) return false;
      if (node.closest("[hidden]")) return false;
      const cs = window.getComputedStyle(node);
      if (!cs) return true;
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const rects = node.getClientRects();
      return !!(rects && rects.length);
    } catch {
      return true;
    }
  };

  // Scan any file input that has a selected file (excluding AI operator's own picker).
  // Prefer inputs that are currently visible (i.e., in the active tool view).
  const all = Array.from(document.querySelectorAll("input[type='file']"))
    .filter((inp) => inp && inp.id !== "aiOpFile" && inp.files && inp.files[0]);

  if (!all.length) return null;

  const visibleFirst = all.sort((a, b) => (isVisible(b) ? 1 : 0) - (isVisible(a) ? 1 : 0));
  return visibleFirst[0]?.files?.[0] || all[0]?.files?.[0] || null;
}



function buildPayload(prompt, planText) {
  const p = String(prompt || "").trim();
  const payload = {
    prompt: p,
    input: p,
    task: p,
    command: p,
    messages: [{ role: "user", content: p }],
  };

  if (planText) payload.plan = planText;

  if (state.uploadId) {
    const id = String(state.uploadId);
    payload.uploadId = id;
    payload.fileId = id;
    payload.documentId = id;
    payload.upload_id = id;
    payload.file_id = id;
    payload.document_id = id;
  }

  return payload;
}

async function planThenRun() {
    const prompt = String(qs("#aiOpInput")?.value || "").trim();
    if (!prompt) return alert("Type a command first.");

    if (!state.uploadId) {
  const anyPicked = (qs("#aiOpFile")?.files?.[0] || findCurrentDocumentFile());
  if (!anyPicked) {
    logLine("No document selected. Choose a PDF in any tool (or in AI Operator) then click Run.", "error");
    setStatus("No document");
    return;
  }
}

// Auto-pick a document:
// 1) Prefer the AI Operator picker
// 2) Otherwise, reuse whatever PDF/file the user already selected in the main tool UI
let f = qs("#aiOpFile")?.files?.[0] || null;
if (!f) f = findCurrentDocumentFile();

// Auto-upload on Run.
if (f && !state.uploadId) {
  // If we are reusing a file from the main UI, show that clearly.
  const badge = qs("#aiOpUploadBadge");
  if (badge && (!qs("#aiOpFile")?.files?.[0])) {
    badge.style.display = "inline-flex";
    badge.textContent = "Using current document: " + (f.name || "document") + " (auto-uploading...)";
  }
  const _upId = await uploadFile(f);
  if (!_upId) { logLine("No uploadId returned; aborting run.", "error"); return; }
}

    const btn = qs("#aiOpRun");
    state.running = true;
    if (btn) btn.disabled = true;

    try {
      setStatus("Planning...");
      logLine("Planning...", "info");

      const planResp = await postJSON((state.uploadId ? "/api/ai/plan?uploadId=" + encodeURIComponent(String(state.uploadId)) + "&fileId=" + encodeURIComponent(String(state.uploadId)) + "&documentId=" + encodeURIComponent(String(state.uploadId)) : "/api/ai/plan"), buildPayload(prompt, null));
      if (!planResp.ok) {
        const err = planResp.data?.error || planResp.data?.message || planResp.data?.text || ("Plan failed (HTTP " + planResp.status + ")");
        logLine("PLAN ERROR:\n" + err, "error");
        setStatus("Plan failed");
        return;
      }

      const planText = normalizePlan(planResp.data) || "(No plan returned)";
      logLine("PLAN:\n" + planText, "plan");

      setStatus("Running...");
      logLine("Running...", "info");

      // Run first (avoid /execute 404 noise)
      const runResp = await postJSON((state.uploadId ? "/api/ai/run?uploadId=" + encodeURIComponent(String(state.uploadId)) + "&fileId=" + encodeURIComponent(String(state.uploadId)) + "&documentId=" + encodeURIComponent(String(state.uploadId)) : "/api/ai/run"), buildPayload(prompt, planText));
      if (!runResp.ok) {
        const err = runResp.data?.error || runResp.data?.message || runResp.data?.text || ("Run failed (HTTP " + runResp.status + ")");
        logLine("RUN ERROR:\n" + err, "error");
        setStatus("Run failed");
        return;
      }

      const out = normalizeResult(runResp.data) || "(No output returned)";
      logLine("RESULT:\n" + out, "result");
      setStatus("Done");
    } catch (e) {
      logLine("ERROR:\n" + (e?.message || String(e)), "error");
      setStatus("Error");
    } finally {
      state.running = false;
      if (btn) btn.disabled = false;
    }
  }

  function ensureUI() {
    if (qs("#aiOperatorModal")) return;
    ensureStyles();

    const modal = el("div", { id: "aiOperatorModal", class: "modal", "aria-hidden": "true", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "modal-card", style: "max-width: 780px;" }, [
        el("div", { class: "modal-head", style: "display:flex; justify-content:space-between; align-items:center; gap:10px;" }, [
          el("div", { class: "mh" }, ["AI Operator ", el("span", { class: "aiop-pill" }, ["BETA"])]),
          el("div", { id: "aiOpUploadBadge", style: "display:none; align-items:center; padding:6px 10px; border:1px solid rgba(255,255,255,0.12); border-radius:999px; font-size:12px; color:rgba(255,255,255,0.85);" }, [""]),
          el("button", { id: "aiOpClose", class: "btn btn-secondary", type: "button" }, ["Close"])
        ]),
        el("div", { class: "modal-body" }, [
          el("div", { class: "aiop-muted", style: "margin-bottom:10px;" }, [
            "Attach a document (optional), then type your command and press Run (it plans then runs)."
          ]),
          el("div", { class: "aiop-row", style: "margin-bottom:10px;" }, [
            el("input", { id: "aiOpFile", type: "file" }),
            el("button", { id: "aiOpUploadBtn", class: "btn btn-secondary", type: "button" }, ["Upload"])
          ]),
          el("textarea", { id: "aiOpInput", placeholder: "Example: Summarize this PDF and extract key dates, then generate a clean bullet report." }),
          el("div", { class: "aiop-row", style: "margin-top:12px;" }, [
            el("button", { id: "aiOpRun", class: "btn btn-primary", type: "button" }, ["Run"]),
            el("div", { id: "aiOpStatus", class: "aiop-muted" }, [""])
          ]),
          el("div", { class: "card", style: "margin-top:12px;" }, [
            el("div", { style: "font-weight:600; margin-bottom:8px;" }, ["Output"]),
            el("div", { id: "aiOpLog" }, [])
          ])
        ])
      ])
    ]);

    document.body.appendChild(modal);

    qs("#aiOpClose").addEventListener("click", () => closeModalCompat(modal));
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModalCompat(modal); });

    qs("#aiOpUploadBtn").addEventListener("click", uploadSelectedFile);
    qs("#aiOpRun").addEventListener("click", planThenRun);

    // Selecting a file is NOT the same as uploading it.
    qs("#aiOpFile").addEventListener("change", () => {
      const inp = qs("#aiOpFile");
      const file = inp && inp.files && inp.files[0];
      state.uploadId = null;
      state.uploadName = null;

      const badge = qs("#aiOpUploadBadge");
      if (!badge) return;

      if (!file) {
        badge.style.display = "none";
        badge.textContent = "";
        return;
      }

      badge.style.display = "inline-flex";
      badge.textContent = "Selected: " + file.name + " (click Upload or Run)";
    });

    qs("#aiOpInput").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        qs("#aiOpRun").click();
      }
    });
  }

  function openOperator() {
    ensureUI();
    openModalCompat(qs("#aiOperatorModal"));
  }

  function bindNavHard() {
    // Capture-phase + stopImmediatePropagation so NOTHING else can hijack the click.
    const handler = (e) => {
      try { e.preventDefault(); } catch (_) {}
      try { e.stopImmediatePropagation(); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
      openOperator();
    };

    // Direct bindings (best)
    const nav = qs("#aiOperatorNav");
    if (nav) nav.addEventListener("click", handler, true);

    const nav2 = document.querySelector("a[data-ai-nav='1']");
    if (nav2 && nav2 !== nav) nav2.addEventListener("click", handler, true);

    // Fallback: any link containing ai=1
    document.addEventListener("click", (e) => {
      const a = e.target?.closest?.("a[href*='ai=1']");
      if (!a) return;
      handler(e);
    }, true);
  }

  function init() {
    bindNavHard();

    // Do NOT auto-open on page load. If someone landed on /?ai=1, strip it to avoid confusion.
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("ai") === "1") {
        u.searchParams.delete("ai");
        const cleaned = u.pathname + (u.search || "") + (u.hash || "");
        history.replaceState({}, "", cleaned);
      }
    } catch (_) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
