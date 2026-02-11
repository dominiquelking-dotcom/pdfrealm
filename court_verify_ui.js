(() => {
  "use strict";

  function el(tag, attrs={}, kids=[]){
    const n=document.createElement(tag);
    for(const [k,v] of Object.entries(attrs)){
      if(k==="class") n.className=v;
      else if(k==="style") n.setAttribute("style", v);
      else if(k.startsWith("on") && typeof v==="function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for(const c of kids) n.appendChild(typeof c==="string"?document.createTextNode(c):c);
    return n;
  }

  function findHashSectionRoot(){
    const tool = document.querySelector('.tool-view[data-tool-view="breakthrough"]') ||
                 document.querySelector('#toolView_breakthrough') ||
                 document.querySelector('[data-tool="breakthrough"]');
    if(!tool) return null;
    const hash = tool.querySelector('.bt-section[data-bt-section="hash"]') ||
                 tool.querySelector('[data-section="hash"]') ||
                 tool;
    return hash;
  }

  function ensurePanel(){
    const root = findHashSectionRoot();
    if(!root) return false;
    if(root.querySelector('[data-court-verify-panel="1"]')) return true;

    const panel = el("div", {
      "data-court-verify-panel":"1",
      "class":"card",
      "style":"margin-top:12px; padding:14px; border:1px solid rgba(255,255,255,.12); border-radius:14px; background:rgba(255,255,255,.03);"
    }, [
      el("div", {"style":"display:flex; align-items:center; justify-content:space-between; gap:12px;"}, [
        el("div", {}, [
          el("div", {"style":"font-weight:800; font-size:14px;"}, ["⚖️ Court Verify Tool"]),
          el("div", {"style":"opacity:.8; font-size:12px; margin-top:2px; line-height:1.35;"}, [
            "Upload an Evidence Bundle (.tar.gz) to prove it’s intact. This checks the original file’s SHA-256 against the manifest and verifies the bundle structure."
          ])
        ]),
        el("span", {"style":"font-size:11px; opacity:.75; padding:6px 10px; border-radius:999px; border:1px solid rgba(255,255,255,.14);"}, ["Court Mode"])
      ]),
      el("div", {"style":"margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;"}, [
        el("input", {"type":"file", "accept":".tar.gz,.tgz,application/gzip", "id":"courtVerifyFile", "style":"max-width:420px;"}),
        el("button", {"class":"btn", "id":"courtVerifyBtn", "style":"padding:8px 12px; border-radius:10px; font-size:12px;"}, ["Verify Bundle"]),
        el("button", {"class":"btn", "id":"courtVerifyDebugBtn", "style":"padding:8px 12px; border-radius:10px; font-size:12px; opacity:.85;"}, ["Show Raw JSON"])
      ]),
      el("div", {"id":"courtVerifyStatus", "style":"margin-top:10px; font-size:12px; opacity:.9;"}, ["Ready."]),
      el("pre", {"id":"courtVerifyJson", "style":"margin-top:10px; display:none; max-height:260px; overflow:auto; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); font-size:11px;"}, [""])
    ]);

    const existingEvidence = root.querySelector('[data-evidence-core-panel="1"]') || root.querySelector('[data-evidence-panel="1"]');
    if(existingEvidence && existingEvidence.parentNode === root){
      existingEvidence.insertAdjacentElement("afterend", panel);
    } else {
      root.appendChild(panel);
    }

    wire(panel);
    return true;
  }

  async function verifyBundle(file){
    const fd = new FormData();
    fd.append("bundle", file);
    const r = await fetch("/api/evidence/verify-bundle", { method:"POST", body: fd });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { json = { ok:false, error:"Non-JSON response", raw: txt.slice(0, 2000) }; }
    if(!r.ok) throw json;
    return json;
  }

  function setStatus(msg, emph){
    const box = document.querySelector("#courtVerifyStatus");
    if(!box) return;
    box.textContent = msg;
    box.style.fontWeight = emph ? "700" : "400";
  }

  function wire(panel){
    const fileInp = panel.querySelector("#courtVerifyFile");
    const btn = panel.querySelector("#courtVerifyBtn");
    const dbgBtn = panel.querySelector("#courtVerifyDebugBtn");
    const pre = panel.querySelector("#courtVerifyJson");

    btn.addEventListener("click", async () => {
      pre.style.display = "none";
      pre.textContent = "";

      const f = fileInp.files && fileInp.files[0];
      if(!f){
        setStatus("Choose an Evidence Bundle (.tar.gz) first.", true);
        return;
      }
      setStatus("Verifying bundle…", true);
      try{
        const out = await verifyBundle(f);

        if(out?.valid){
          setStatus(`✅ VALID — bundle matches manifest hash. Evidence ID: ${out.evidenceId || "(unknown)"}`, true);
        } else {
          const reason = out?.reason || out?.error || "Bundle failed verification";
          setStatus(`❌ TAMPERED / INVALID — ${reason}`, true);
        }

        pre.textContent = JSON.stringify(out, null, 2);
      }catch(err){
        const reason = err?.reason || err?.error || err?.detail || "Verification failed";
        setStatus(`❌ ERROR — ${reason}`, true);
        pre.textContent = JSON.stringify(err, null, 2);
      }
    });

    dbgBtn.addEventListener("click", () => {
      if(pre.textContent.trim().length === 0){
        setStatus("No JSON yet — run Verify first.", true);
        return;
      }
      pre.style.display = (pre.style.display === "none" ? "block" : "none");
    });
  }

  let tries = 0;
  const maxTries = 120;
  const t = setInterval(() => {
    tries++;
    if(ensurePanel()){
      clearInterval(t);
      return;
    }
    if(tries >= maxTries) clearInterval(t);
  }, 100);
})();