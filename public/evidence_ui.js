(() => {
  "use strict";

  // Evidence Core UI injector for Breakthrough → Hash Evidence Machine.
  // Robust: finds the right panel by text, waits for async render, injects once.

  const CONFIG = {
    maxWaitMs: 12000,
    pollMs: 250,
    endpoints: {
      ingest: "/api/evidence/ingest",
      addEvent: (id) => `/api/evidence/${encodeURIComponent(id)}/event`,
      bundle: (id) => `/api/evidence/${encodeURIComponent(id)}/bundle`,
      get: (id) => `/api/evidence/${encodeURIComponent(id)}`
    }
  };

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, String(v));
    }
    for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }

  function findHashEvidencePanelHost() {
    // Look for the right-side content panel by searching for a heading containing "Hash Evidence Machine"
    const walkers = [
      ...document.querySelectorAll("h1,h2,h3,h4,.title,.panel-title,.card-title,.tool-title,div,span")
    ];
    for (const node of walkers) {
      const t = (node.textContent || "").trim();
      if (!t) continue;
      if (/hash evidence machine/i.test(t)) {
        // Prefer a container that looks like a right-side card/panel
        const container = node.closest(".card,.panel,.tool-card,.tool-panel,.right-panel,.tool-right,.content,section,article,div");
        if (container) return container;
        return node.parentElement || null;
      }
    }
    return null;
  }

  function alreadyInjected(host) {
    return !!host.querySelector("#evidenceCorePanel");
  }

  function prettyJson(obj) {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  function makePanel() {
    const state = {
      evidenceId: null,
      artifact: null,
      events: [],
    };

    const out = el("pre", {
      class: "evidence-core-output",
      style: [
        "margin:0",
        "padding:12px",
        "border:1px solid rgba(255,255,255,.10)",
        "border-radius:12px",
        "background:rgba(0,0,0,.18)",
        "max-height:220px",
        "overflow:auto",
        "white-space:pre-wrap"
      ].join(";")
    }, ["Ready. Upload a file and click Ingest."]);

    const file = el("input", {
      type: "file",
      accept: "*/*",
      style: "width:100%;"
    });

    const btnIngest = el("button", {
      type: "button",
      class: "btn btn-primary",
      style: "padding:10px 14px; border-radius:999px; cursor:pointer;"
    }, ["Ingest (Hash + Log)"]);

    const btnEvent = el("button", {
      type: "button",
      class: "btn",
      style: "padding:10px 14px; border-radius:999px; cursor:pointer; opacity:.9;"
    }, ["Append Test Event"]);

    const btnBundle = el("button", {
      type: "button",
      class: "btn",
      style: "padding:10px 14px; border-radius:999px; cursor:pointer; opacity:.9;"
    }, ["Export Evidence Bundle"]);

    const meta = el("div", { style: "display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;" }, [
      el("div", { style: "padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:rgba(0,0,0,.10);" }, [
        el("div", { style: "font-size:12px; opacity:.8;" }, ["Evidence ID"]),
        el("div", { id: "evidenceIdVal", style: "font-size:13px; font-weight:700; word-break:break-all;" }, ["—"]),
      ]),
      el("div", { style: "padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:rgba(0,0,0,.10);" }, [
        el("div", { style: "font-size:12px; opacity:.8;" }, ["SHA-256"]),
        el("div", { id: "evidenceHashVal", style: "font-size:13px; font-weight:700; word-break:break-all;" }, ["—"]),
      ]),
    ]);

    function setOutput(txt) { out.textContent = txt; }
    function setMeta() {
      const idEl = meta.querySelector("#evidenceIdVal");
      const hEl = meta.querySelector("#evidenceHashVal");
      idEl.textContent = state.evidenceId || "—";
      hEl.textContent = (state.artifact && (state.artifact.sha256 || state.artifact.hash || state.artifact.content_hash)) || "—";
    }

    async function ingest() {
      const f = file.files && file.files[0];
      if (!f) return setOutput("Pick a file first.");
      setOutput(`Ingesting: ${f.name} ...`);

      const fd = new FormData();
      fd.append("file", f);

      const r = await fetch(CONFIG.endpoints.ingest, {
        method: "POST",
        body: fd,
        credentials: "include"
      });

      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

      if (!r.ok) {
        setOutput(`INGEST ERROR (${r.status}):\n` + prettyJson(data));
        return;
      }

      state.evidenceId = data.evidenceId || data.id || (data.artifact && data.artifact.id) || null;
      state.artifact = data.artifact || data;
      setMeta();
      setOutput("INGEST OK:\n" + prettyJson(data));
    }

    async function appendEvent() {
      if (!state.evidenceId) {
        setOutput("No evidenceId yet. Ingest a file first.");
        return;
      }
      setOutput("Appending test event...");

      const payload = {
        action: "MANUAL_TEST_EVENT",
        details: { note: "User appended a manual test event from UI", ts: new Date().toISOString() }
      };

      const r = await fetch(CONFIG.endpoints.addEvent(state.evidenceId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include"
      });

      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

      if (!r.ok) {
        setOutput(`EVENT ERROR (${r.status}):\n` + prettyJson(data));
        return;
      }
      setOutput("EVENT OK:\n" + prettyJson(data));
    }

    function exportBundle() {
      if (!state.evidenceId) {
        setOutput("No evidenceId yet. Ingest a file first.");
        return;
      }
      const url = CONFIG.endpoints.bundle(state.evidenceId);
      setOutput("Downloading bundle:\n" + url);
      window.open(url, "_blank", "noopener,noreferrer");
    }

    btnIngest.addEventListener("click", () => ingest().catch(err => setOutput("INGEST FAILED:\n" + (err?.stack || err?.message || String(err)))));
    btnEvent.addEventListener("click", () => appendEvent().catch(err => setOutput("EVENT FAILED:\n" + (err?.stack || err?.message || String(err)))));
    btnBundle.addEventListener("click", exportBundle);

    const panel = el("div", {
      id: "evidenceCorePanel",
      style: [
        "margin-top:14px",
        "padding:14px",
        "border:1px solid rgba(255,255,255,.12)",
        "border-radius:16px",
        "background:rgba(255,255,255,.03)"
      ].join(";")
    }, [
      el("div", { style: "display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px;" }, [
        el("div", {}, [
          el("div", { style: "font-weight:800; font-size:16px;" }, ["🧾 Evidence Core (Live) — Phase 1"]),
          el("div", { style: "font-size:12px; opacity:.8; margin-top:2px;" }, ["Ingest any file → SHA-256 + append-only event log → export evidence bundle."]),
        ]),
        el("span", { style: "font-size:11px; opacity:.75; border:1px solid rgba(255,255,255,.12); padding:4px 8px; border-radius:999px;" }, ["Postgres-backed"]),
      ]),
      el("div", { style: "display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center;" }, [
        file,
        el("div", { style: "display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;" }, [btnIngest, btnEvent, btnBundle]),
      ]),
      meta,
      el("div", { style: "margin-top:10px;" }, [out]),
    ]);

    return panel;
  }

  async function injectWhenReady() {
    const start = Date.now();
    while (Date.now() - start < CONFIG.maxWaitMs) {
      const host = findHashEvidencePanelHost();
      if (host && !alreadyInjected(host)) {
        // Try to inject just under the header area, but within host.
        const panel = makePanel();

        // Prefer injecting near top of host (but after title)
        const headings = host.querySelectorAll("h1,h2,h3,h4");
        if (headings && headings.length) {
          const h = headings[0];
          h.insertAdjacentElement("afterend", panel);
        } else {
          host.insertAdjacentElement("afterbegin", panel);
        }
        return;
      }
      await new Promise(r => setTimeout(r, CONFIG.pollMs));
    }
  }

  // Start after load (safe for your SPA-ish render)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => injectWhenReady().catch(()=>{}), { once: true });
  } else {
    injectWhenReady().catch(()=>{});
  }
})();