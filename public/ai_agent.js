(() => {
  "use strict";

  const state = {
    uploadId:   null,
    uploadName: null,
    running:    false,
    currentPlan: null,
  };

  const EXAMPLE_PROMPTS = [
    "Compress this PDF and add a CONFIDENTIAL watermark",
    "Remove all metadata and flatten form fields",
    "Add page numbers starting from 1 in the bottom right",
    "Rotate 90 degrees and compress",
    "Stamp APPROVED on all pages and add page numbers",
    "Extract all text via OCR",
    "Convert to Word document",
  ];

  const TOOL_ICONS = {
    rotate:             "🔄",
    encrypt:            "🔒",
    decrypt:            "🔓",
    compress:           "🗜️",
    watermark:          "💧",
    stamp:              "📮",
    flatten:            "📄",
    merge:              "🔀",
    split:              "✂️",
    reorder:            "🔃",
    delete_page:        "🗑️",
    page_numbers:       "🔢",
    remove_metadata:    "🧹",
    repair:             "🔧",
    ocr:                "🔍",
    pdf_to_word:        "📝",
    html_to_pdf:        "🌐",
    url_to_pdf:         "🌍",
    redact:             "⬛",
    remove_blank_pages: "📃",
  };

  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class")                              n.className = v;
      else if (k === "style")                         n.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v === false || v === null || v === undefined)  {}
      else                                            n.setAttribute(k, String(v));
    }
    for (const c of kids) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  };

  // ── Styles ──────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (qs("#aiopInlineStyles")) return;
    const css = `
      #aiOperatorModal .modal-card { max-height: 92vh; display:flex; flex-direction:column; overflow:hidden; }
      #aiOperatorModal .modal-body { flex:1; min-height:0; overflow:auto; padding-bottom: 16px; }
      #aiOperatorModal textarea#aiOpInput { width:100%; min-height:80px; resize:vertical; }

      /* row / layout */
      #aiOperatorModal .aiop-row   { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      #aiOperatorModal .aiop-muted { color: var(--muted, #aaa); font-size: 0.88rem; }
      #aiOperatorModal .aiop-pill  { padding: 3px 8px; border-radius:999px; background: rgba(255,255,255,0.08); font-size: 0.8rem; }

      /* example chips */
      #aiOpExamples { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
      .aiop-chip {
        cursor:pointer; padding:4px 10px; border-radius:999px;
        background: rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.12);
        font-size:0.78rem; color: rgba(255,255,255,0.75);
        transition: background 0.15s;
      }
      .aiop-chip:hover { background: rgba(255,255,255,0.14); color:#fff; }

      /* step plan cards */
      #aiOpPlanCards { margin: 10px 0; }
      .aiop-step-card {
        display:flex; align-items:flex-start; gap:10px;
        padding:8px 10px; border-radius:8px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.09);
        margin-bottom:6px;
      }
      .aiop-step-icon  { font-size:1.3rem; flex-shrink:0; }
      .aiop-step-name  { font-weight:600; font-size:0.9rem; color:#fff; }
      .aiop-step-desc  { font-size:0.82rem; color:rgba(255,255,255,0.6); }
      .aiop-step-badge {
        margin-left:auto; flex-shrink:0; font-size:0.75rem; padding:2px 7px;
        border-radius:999px;
      }
      .aiop-badge-ok    { background:rgba(34,197,94,0.2);  color:#4ade80; }
      .aiop-badge-err   { background:rgba(239,68,68,0.2);  color:#f87171; }
      .aiop-badge-skip  { background:rgba(234,179,8,0.2);  color:#fbbf24; }
      .aiop-badge-run   { background:rgba(59,130,246,0.2); color:#60a5fa; }

      /* warnings */
      .aiop-warnings {
        padding:8px 12px; border-radius:8px; margin:8px 0;
        background:rgba(234,179,8,0.1); border:1px solid rgba(234,179,8,0.3);
        font-size:0.85rem; color:#fbbf24;
      }
      .aiop-warnings ul { margin:4px 0 0; padding-left:18px; }

      /* summary box */
      .aiop-summary {
        padding:10px 14px; border-radius:8px; margin:8px 0;
        background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.3);
        font-size:0.9rem; color:rgba(255,255,255,0.9);
      }

      /* result actions */
      #aiOpResultArea { margin-top:10px; }
      #aiOpOcrText {
        width:100%; height:160px; resize:vertical; margin-top:6px;
        font-family:monospace; font-size:0.82rem;
        background:rgba(0,0,0,0.3); color:#ccc; border:1px solid rgba(255,255,255,0.12);
        border-radius:6px; padding:8px;
      }
      .aiop-spinner { display:inline-block; animation: aiop-spin 0.8s linear infinite; }
      @keyframes aiop-spin { to { transform: rotate(360deg); } }

      /* upload badge */
      #aiOpUploadBadge {
        align-items:center; padding:5px 10px;
        border:1px solid rgba(255,255,255,0.12); border-radius:999px;
        font-size:12px; color:rgba(255,255,255,0.85);
      }
    `;
    document.head.appendChild(el("style", { id: "aiopInlineStyles" }, [css]));
  }

  // ── Modal helpers ────────────────────────────────────────────────────────────
  function openModalCompat(modal) {
    if (!modal) return;
    if (typeof window.openModal === "function") { try { window.openModal(modal.id); } catch (_) {} }
    modal.classList.add("open", "modal-open");
    modal.setAttribute("aria-hidden", "false");
  }
  function closeModalCompat(modal) {
    if (!modal) return;
    if (typeof window.closeModal === "function") { try { window.closeModal(modal.id); } catch (_) {} }
    modal.classList.remove("open", "modal-open");
    modal.setAttribute("aria-hidden", "true");
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function setStatus(t) { const n = qs("#aiOpStatus"); if (n) n.textContent = t || ""; }

  async function readTextSafe(r) { try { return await r.text(); } catch { return ""; } }

  async function postJSON(url, payload) {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(payload || {}),
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let data = null;
    if (ct.includes("application/json")) { try { data = await r.json(); } catch { data = null; } }
    if (data === null) { const t = await readTextSafe(r); data = t ? { text: t } : {}; }
    return { ok: r.ok, status: r.status, data };
  }

  // ── Upload logic ─────────────────────────────────────────────────────────────
  async function uploadFile(file) {
    if (!file) return null;
    setStatus("Uploading…");

    const fd = new FormData();
    fd.append("file", file);

    let r;
    try {
      r = await fetch("/api/ai/upload", { method: "POST", body: fd });
    } catch (e) {
      setStatus("Upload failed");
      renderError("Upload failed: " + (e?.message || String(e)));
      return null;
    }

    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let data = null;
    if (ct.includes("application/json")) { try { data = await r.json(); } catch { data = null; } }
    if (!data) { const t = await readTextSafe(r); data = t ? { text: t } : {}; }

    if (!r.ok) {
      const err = data.error || data.message || data.text || `Upload failed (HTTP ${r.status})`;
      renderError(err);
      setStatus("Upload failed");
      return null;
    }

    // Support both single-upload and multi-upload response shapes
    const firstUpload = data.uploads?.[0];
    const uid = firstUpload?.id || data.uploadId || data.upload_id || data.id || data.fileId || null;
    const name = firstUpload?.name || data.filename || data.name || file.name;

    if (!uid) {
      renderError("Upload response did not include an uploadId.\n" + JSON.stringify(data, null, 2));
      setStatus("Upload failed");
      return null;
    }

    state.uploadId   = String(uid);
    state.uploadName = name;

    const badge = qs("#aiOpUploadBadge");
    if (badge) { badge.textContent = "📎 " + state.uploadName; badge.style.display = "inline-flex"; }

    setStatus("");
    return state.uploadId;
  }

  async function uploadSelectedFile() {
    const inp  = qs("#aiOpFile");
    const file = inp?.files?.[0];
    if (!file) { alert("Choose a document first."); return null; }
    return await uploadFile(file);
  }

  function findCurrentDocumentFile() {
    const priorityIds = [
      "studioFile","splitPdfFile","deletePdfFile","mergeFile1","mergeFile2",
      "compressPdfFile","rotatePdfFile","reorderPdfFile","watermarkPdfFile",
      "metaPdfFile","flattenPdfFile","repairPdfFile","resizePdfFile",
      "pageNumsPdfFile","stampPdfFile","redactPdfFile",
      "pdf2pngFile","pdf2jpgFile","pdf2txtFile","pdf2csvFile","pdf2pptxFile","pdf2xlsxFile",
      "pdfcropFile","visualdiffA","visualdiffB",
    ];
    for (const id of priorityIds) { const f = document.getElementById(id)?.files?.[0]; if (f) return f; }
    const isVisible = n => { try { if (!n || n.closest("[hidden]")) return false; const cs = getComputedStyle(n); return cs.display !== "none" && cs.visibility !== "hidden"; } catch { return true; } };
    const all = Array.from(document.querySelectorAll("input[type='file']"))
      .filter(inp => inp.id !== "aiOpFile" && inp.files?.[0]);
    if (!all.length) return null;
    return all.sort((a, b) => (isVisible(b) ? 1 : 0) - (isVisible(a) ? 1 : 0))[0]?.files?.[0] || null;
  }

  function buildPayload(prompt) {
    const p = String(prompt || "").trim();
    const payload = { prompt: p };
    if (state.uploadId) {
      const uid = String(state.uploadId);
      Object.assign(payload, { uploadId: uid, fileId: uid, documentId: uid });
    }
    return payload;
  }

  // ── UI rendering helpers ─────────────────────────────────────────────────────
  function clearResultArea() {
    const a = qs("#aiOpResultArea"); if (a) a.innerHTML = "";
    const p = qs("#aiOpPlanCards");  if (p) p.innerHTML = "";
    const s = qs("#aiOpSummaryBox"); if (s) s.innerHTML = "";
    const w = qs("#aiOpWarningsBox"); if (w) w.innerHTML = "";
    const x = qs("#aiOpExecuteRow"); if (x) x.style.display = "none";
  }

  function renderError(msg) {
    const a = qs("#aiOpResultArea");
    if (!a) return;
    a.innerHTML = "";
    a.appendChild(el("div", {
      style: "padding:10px 14px; border-radius:8px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#f87171; font-size:0.88rem; white-space:pre-wrap;"
    }, [msg]));
  }

  function renderPlanCards(steps) {
    const box = qs("#aiOpPlanCards");
    if (!box) return;
    box.innerHTML = "";
    steps.forEach((step, i) => {
      const name = String(step.tool || "?");
      const icon = TOOL_ICONS[name] || "⚙️";
      const desc = step.description || name;
      box.appendChild(
        el("div", { class: "aiop-step-card", id: `aiop-step-${i}` }, [
          el("div", { class: "aiop-step-icon" }, [icon]),
          el("div", { style: "flex:1; min-width:0;" }, [
            el("div", { class: "aiop-step-name" }, [name]),
            el("div", { class: "aiop-step-desc" }, [desc]),
          ]),
        ])
      );
    });
  }

  function renderWarnings(warnings) {
    const box = qs("#aiOpWarningsBox");
    if (!box || !warnings?.length) return;
    const items = warnings.map(w => el("li", {}, [w]));
    box.innerHTML = "";
    box.appendChild(
      el("div", { class: "aiop-warnings" }, [
        "⚠️ Things to note:",
        el("ul", {}, items),
      ])
    );
  }

  function markStepRunning(i) {
    const card = qs(`#aiop-step-${i}`);
    if (!card) return;
    let badge = card.querySelector(".aiop-step-badge");
    if (!badge) { badge = el("div", { class: "aiop-step-badge aiop-badge-run" }); card.appendChild(badge); }
    badge.className = "aiop-step-badge aiop-badge-run";
    badge.textContent = "⏳ running";
  }

  function markStepDone(i, status, detail) {
    const card = qs(`#aiop-step-${i}`);
    if (!card) return;
    let badge = card.querySelector(".aiop-step-badge");
    if (!badge) { badge = el("div", { class: "aiop-step-badge" }); card.appendChild(badge); }
    if (status === "ok") {
      badge.className  = "aiop-step-badge aiop-badge-ok";
      badge.textContent = detail ? `✅ ${detail}` : "✅ done";
    } else if (status === "error") {
      badge.className  = "aiop-step-badge aiop-badge-err";
      badge.textContent = "❌ error";
      // Show error inline
      const errSpan = el("div", { class: "aiop-step-desc", style: "color:#f87171; margin-top:2px;" }, [detail || "failed"]);
      card.querySelector("div > div")?.appendChild(errSpan);
    } else {
      badge.className  = "aiop-step-badge aiop-badge-skip";
      badge.textContent = "⏭️ skipped";
    }
  }

  function renderSummary(text) {
    const box = qs("#aiOpSummaryBox");
    if (!box || !text) return;
    box.innerHTML = "";
    box.appendChild(el("div", { class: "aiop-summary" }, ["✨ " + text]));
  }

  function renderResult(data) {
    const area = qs("#aiOpResultArea");
    if (!area) return;
    area.innerHTML = "";

    if (data.hasText && data.textPreview !== null) {
      // OCR / text result
      area.appendChild(el("div", { style: "font-weight:600; margin-bottom:4px; font-size:0.9rem;" }, ["📄 Extracted Text"]));
      const ta = el("textarea", { id: "aiOpOcrText", readonly: "readonly" }, [data.textPreview || ""]);
      area.appendChild(ta);
      const copyBtn = el("button", { class: "btn btn-secondary", type: "button", style: "margin-top:6px; font-size:0.85rem;" }, ["📋 Copy text"]);
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(ta.value).then(() => { copyBtn.textContent = "✅ Copied!"; setTimeout(() => { copyBtn.textContent = "📋 Copy text"; }, 2000); });
      });
      area.appendChild(copyBtn);
      if (data.textUrl) {
        const fullLink = el("a", { href: data.textUrl, target: "_blank", class: "btn btn-secondary", style: "margin-top:6px; margin-left:6px; font-size:0.85rem; text-decoration:none;" }, ["⬇️ Download full text"]);
        area.appendChild(fullLink);
      }
    } else if (data.downloadUrl) {
      const dlBtn = el("a", {
        href:     data.downloadUrl,
        download: "",
        class:    "btn btn-primary",
        style:    "text-decoration:none; display:inline-block; margin-top:6px;",
      }, ["⬇️ Download Result"]);
      area.appendChild(dlBtn);
    } else {
      area.appendChild(el("div", { class: "aiop-muted", style: "margin-top:6px;" }, ["No downloadable result produced."]));
    }
  }

  // ── Main flow ────────────────────────────────────────────────────────────────
  async function planThenRun() {
    const prompt = String(qs("#aiOpInput")?.value || "").trim();
    if (!prompt) return alert("Type a command first.");

    // Ensure we have an uploadId (or it's a no-file tool request)
    if (!state.uploadId) {
      let f = qs("#aiOpFile")?.files?.[0] || findCurrentDocumentFile();
      if (!f) {
        renderError("No document selected. Choose a PDF first, or pick one in any tool tab and click Run.");
        setStatus("No document");
        return;
      }
      const badge = qs("#aiOpUploadBadge");
      if (badge && !qs("#aiOpFile")?.files?.[0]) {
        badge.style.display = "inline-flex";
        badge.textContent   = "Using: " + f.name + " (uploading…)";
      }
      const uid = await uploadFile(f);
      if (!uid) { setStatus("Upload failed"); return; }
    }

    const btn = qs("#aiOpRun");
    state.running = true;
    if (btn) btn.disabled = true;
    clearResultArea();

    try {
      // ── 1. Plan ──────────────────────────────────────────────────────────────
      setStatus("🧠 Planning…");
      qs("#aiOpPlanCards").innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:rgba(255,255,255,0.5);font-size:0.88rem;"><span class="aiop-spinner">⏳</span> Generating plan…</div>`;

      const planResp = await postJSON("/api/ai/plan", buildPayload(prompt));
      if (!planResp.ok) {
        renderError("Plan failed: " + (planResp.data?.error || planResp.data?.message || `HTTP ${planResp.status}`));
        setStatus("Plan failed");
        return;
      }

      const plan = planResp.data?.plan || planResp.data;
      state.currentPlan = plan;

      if (!plan?.steps?.length) {
        renderError("No steps were planned for that request. Try rephrasing.");
        setStatus("");
        return;
      }

      renderWarnings(planResp.data?.warnings || plan.warnings || []);
      renderPlanCards(plan.steps);

      // Show summary from plan
      const planSummary = planResp.data?.summary || plan.summary;
      if (planSummary) renderSummary(planSummary);

      setStatus(`📋 Plan ready (${plan.steps.length} step${plan.steps.length !== 1 ? "s" : ""})`);

      // ── 2. Show "Execute Plan" button ─────────────────────────────────────────
      await new Promise(resolve => {
        const execRow = qs("#aiOpExecuteRow");
        const execBtn = qs("#aiOpExecuteBtn");
        if (!execRow || !execBtn) { resolve(); return; } // no execute row → run immediately
        execRow.style.display = "flex";
        execBtn.onclick = () => { execRow.style.display = "none"; resolve(); };
      });

      // ── 3. Run ────────────────────────────────────────────────────────────────
      // Animate each step card with "running" before we send the run request
      plan.steps.forEach((_, i) => markStepRunning(i));
      setStatus("⚙️ Running…");

      const runPayload = Object.assign(buildPayload(prompt), { plan });
      const runResp = await postJSON("/api/ai/run", runPayload);

      if (!runResp.ok) {
        renderError("Run failed: " + (runResp.data?.error || runResp.data?.message || `HTTP ${runResp.status}`));
        setStatus("Run failed");
        return;
      }

      const data = runResp.data;

      // Update step cards with actual status from stepLog
      if (Array.isArray(data.stepLog)) {
        data.stepLog.forEach((s, i) => {
          const detail = s.status === "ok" && s.outputBytes
            ? `${Math.round(s.outputBytes / 1024)}KB`
            : (s.status === "ok" && s.output === "text" ? "text extracted" : s.error || "");
          markStepDone(i, s.status, detail);
        });
      }

      // Overwrite summary with run summary
      if (data.summary) renderSummary(data.summary);
      if (data.warnings?.length) renderWarnings(data.warnings);

      renderResult(data);
      setStatus("✅ Done");
    } catch (e) {
      renderError("Error: " + (e?.message || String(e)));
      setStatus("Error");
    } finally {
      state.running = false;
      if (btn) btn.disabled = false;
    }
  }

  // ── ensureUI ─────────────────────────────────────────────────────────────────
  function ensureUI() {
    if (qs("#aiOperatorModal")) return;
    ensureStyles();

    // Example prompt chips
    const chips = EXAMPLE_PROMPTS.map(p =>
      el("span", { class: "aiop-chip" }, [p])
    );

    const modal = el("div", {
      id: "aiOperatorModal",
      class: "modal",
      "aria-hidden": "true",
      role: "dialog",
      "aria-modal": "true",
    }, [
      el("div", { class: "modal-card", style: "max-width: 800px;" }, [
        // ── Header
        el("div", { class: "modal-head", style: "display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;" }, [
          el("div", { class: "mh" }, ["AI Operator ", el("span", { class: "aiop-pill" }, ["BETA"])]),
          el("div", { id: "aiOpUploadBadge", style: "display:none;" }, [""]),
          el("button", { id: "aiOpClose", class: "btn btn-secondary", type: "button" }, ["Close"]),
        ]),

        // ── Body
        el("div", { class: "modal-body" }, [
          // Description
          el("div", { class: "aiop-muted", style: "margin-bottom:10px;" }, [
            "Attach a PDF, describe what you want, and the AI Operator will plan and execute it automatically."
          ]),

          // Upload row
          el("div", { class: "aiop-row", style: "margin-bottom:10px;" }, [
            el("input", { id: "aiOpFile", type: "file", accept: ".pdf,application/pdf" }),
            el("button", { id: "aiOpUploadBtn", class: "btn btn-secondary", type: "button" }, ["Upload"]),
          ]),

          // Example prompts
          el("div", { id: "aiOpExamples" }, chips),

          // Prompt input
          el("textarea", { id: "aiOpInput", placeholder: 'e.g. "Compress this PDF, add page numbers, and stamp APPROVED on all pages"' }),

          // Run row
          el("div", { class: "aiop-row", style: "margin-top:10px;" }, [
            el("button", { id: "aiOpRun", class: "btn btn-primary", type: "button" }, ["▶ Run"]),
            el("div", { id: "aiOpStatus", class: "aiop-muted" }, [""]),
          ]),

          // Summary box (populated after plan/run)
          el("div", { id: "aiOpSummaryBox" }),

          // Warnings box
          el("div", { id: "aiOpWarningsBox" }),

          // Plan step cards
          el("div", { style: "margin-top:8px; font-weight:600; font-size:0.88rem; color:rgba(255,255,255,0.5);" }, ["PLAN"]),
          el("div", { id: "aiOpPlanCards" }),

          // Execute button (shown after planning)
          el("div", { id: "aiOpExecuteRow", class: "aiop-row", style: "display:none; margin-top:8px;" }, [
            el("button", { id: "aiOpExecuteBtn", class: "btn btn-primary", type: "button" }, ["⚡ Execute Plan"]),
            el("div", { class: "aiop-muted" }, ["Review the steps above, then execute."]),
          ]),

          // Result area
          el("div", { id: "aiOpResultArea" }),
        ]),
      ]),
    ]);

    document.body.appendChild(modal);

    // ── Wire events ──────────────────────────────────────────────────────────
    qs("#aiOpClose").addEventListener("click", () => closeModalCompat(modal));
    modal.addEventListener("click", e => { if (e.target === modal) closeModalCompat(modal); });

    qs("#aiOpUploadBtn").addEventListener("click", uploadSelectedFile);
    qs("#aiOpRun").addEventListener("click", planThenRun);

    qs("#aiOpFile").addEventListener("change", () => {
      const file = qs("#aiOpFile")?.files?.[0];
      state.uploadId   = null;
      state.uploadName = null;
      const badge = qs("#aiOpUploadBadge");
      if (!badge) return;
      if (!file) { badge.style.display = "none"; badge.textContent = ""; return; }
      badge.style.display = "inline-flex";
      badge.textContent   = "Selected: " + file.name + " (click Upload or Run)";
    });

    qs("#aiOpInput").addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); qs("#aiOpRun").click(); }
    });

    // Chip clicks populate the textarea
    qsa(".aiop-chip", modal).forEach(chip => {
      chip.addEventListener("click", () => {
        const ta = qs("#aiOpInput");
        if (ta) { ta.value = chip.textContent; ta.focus(); }
      });
    });
  }

  // ── Open / nav wiring ────────────────────────────────────────────────────────
  function openOperator() {
    ensureUI();
    openModalCompat(qs("#aiOperatorModal"));
  }

  function bindNavHard() {
    const handler = e => {
      try { e.preventDefault(); } catch (_) {}
      try { e.stopImmediatePropagation(); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
      openOperator();
    };
    const nav = qs("#aiOperatorNav");
    if (nav) nav.addEventListener("click", handler, true);
    const nav2 = document.querySelector("a[data-ai-nav='1']");
    if (nav2 && nav2 !== nav) nav2.addEventListener("click", handler, true);
    document.addEventListener("click", e => {
      const a = e.target?.closest?.("a[href*='ai=1']");
      if (a) handler(e);
    }, true);
  }

  function init() {
    bindNavHard();
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("ai") === "1") {
        u.searchParams.delete("ai");
        history.replaceState({}, "", u.pathname + (u.search || "") + (u.hash || ""));
      }
    } catch (_) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
