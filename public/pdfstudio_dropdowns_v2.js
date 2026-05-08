/* PDFREALM_PDFSTUDIO_DROPDOWNS_V2
   - Adds visible badge so you can confirm it is running
   - Works across same-origin iframes + shadow DOM
   - Collapses long PDFStudio toolbars into dropdown popouts
   - Clamps any leftover nowrap toolbars from extending right
*/
(function(){
  "use strict";
  if (window.__PDFSTUDIO_DD_V2__) return;
  window.__PDFSTUDIO_DD_V2__ = true;

  function norm(s){ return (s||"").replace(/\s+/g," ").trim(); }
  function cssEscape(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g,"\\$&"); }

  function ensureBadge(doc){
    try{
      if (doc.getElementById("psPatchBadgeV2")) return;
      var b = doc.createElement("div");
      b.id = "psPatchBadgeV2";
      b.textContent = "PDF Studio dropdown patch: ON";
      b.style.position = "fixed";
      b.style.left = "12px";
      b.style.bottom = "12px";
      b.style.zIndex = "2147483647";
      b.style.padding = "6px 10px";
      b.style.borderRadius = "10px";
      b.style.font = "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      b.style.background = "rgba(20,30,45,.85)";
      b.style.color = "white";
      b.style.border = "1px solid rgba(255,255,255,.15)";
      b.style.backdropFilter = "blur(6px)";
      doc.documentElement.appendChild(b);
    }catch(_){}
  }

  function ensureCss(doc){
    if (doc.getElementById("pdfstudioDropdownCssV2")) return;
    var css =
".ps-toolbox-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;margin:10px 0 12px 0;" +
"background:rgba(10,14,20,.65);border:1px solid rgba(255,255,255,.08);border-radius:14px;backdrop-filter: blur(8px);" +
"max-width:100%;box-sizing:border-box;}\n" +
".ps-dd{position:relative;}\n" +
".ps-dd-btn{height:34px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);" +
"background:rgba(255,255,255,.06);color:inherit;cursor:pointer;}\n" +
".ps-dd-btn:after{content:'▾';margin-left:8px;opacity:.75;font-size:.85em;}\n" +
".ps-dd.open .ps-dd-btn{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.16);} \n" +
".ps-dd-menu{position:absolute;top:calc(100% + 8px);left:0;min-width:340px;max-width:min(980px, calc(100vw - 24px));" +
"max-height:min(64vh, 560px);overflow:auto;padding:12px;border-radius:16px;" +
"background:rgba(12,16,22,.96);border:1px solid rgba(255,255,255,.12);" +
"box-shadow: 0 10px 30px rgba(0,0,0,.45);display:none;z-index:9999;}\n" +
".ps-dd.open .ps-dd-menu{display:block;}\n" +
".ps-grid{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}\n" +
".ps-grid > *{margin:0 !important;}\n" +
".ps-grid button{white-space:nowrap;}\n" +
".ps-grid input,.ps-grid select,.ps-grid textarea{min-width:180px;max-width:360px;}\n" +
"@media (max-width:680px){.ps-dd-menu{min-width:calc(100vw - 24px);} .ps-grid input,.ps-grid select{min-width:140px;}}\n" +
/* Hard clamp for any leftover tool rows that were forcing width */
".ps-clamp, .ps-clamp *{max-width:100% !important; box-sizing:border-box !important;}\n" +
".ps-clamp{overflow-x:hidden !important;}\n" +
".ps-clamp .ps-nowrap-fix{flex-wrap:wrap !important; overflow-x:hidden !important; max-width:100% !important;}\n";

    var style = doc.createElement("style");
    style.id = "pdfstudioDropdownCssV2";
    style.textContent = css;
    doc.head.appendChild(style);
  }

  function isVisible(el){
    try{
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      // near top tool area
      if (r.top > (window.innerHeight * 0.6)) return false;
      var cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      return true;
    }catch(_){ return false; }
  }

  // Collect roots: document + any shadowRoots + same-origin iframe documents
  function collectRoots(doc){
    var roots = [doc];
    try{
      var all = doc.querySelectorAll("*");
      for (var i=0;i<all.length;i++){
        var n = all[i];
        if (n.shadowRoot) roots.push(n.shadowRoot);
      }
      var ifr = doc.querySelectorAll("iframe");
      for (var j=0;j<ifr.length;j++){
        try{
          var idoc = ifr[j].contentDocument;
          if (idoc) roots = roots.concat(collectRoots(idoc));
        }catch(_){}
      }
    }catch(_){}
    return roots;
  }

  function deepQueryAll(doc, sel){
    var out = [];
    var roots = collectRoots(doc);
    for (var i=0;i<roots.length;i++){
      try{
        out = out.concat([].slice.call(roots[i].querySelectorAll(sel)));
      }catch(_){}
    }
    return out;
  }

  function findButtonByText(doc, txt){
    txt = norm(txt);
    var btns = deepQueryAll(doc, "button");
    for (var i=0;i<btns.length;i++){
      var b = btns[i];
      if (norm(b.textContent) === txt && isVisible(b)) return b;
    }
    return null;
  }

  function controlCount(el){
    try{ return el.querySelectorAll("button,input,select,textarea,label").length; }
    catch(_){ return 0; }
  }

  function bestToolbarContainer(doc){
    var selectBtn = findButtonByText(doc, "Select");
    var handBtn   = findButtonByText(doc, "Hand");
    if (!selectBtn || !handBtn) return null;

    // climb from Select to find a container that contains Hand and has many controls
    var el = selectBtn.parentElement;
    var best = null, bestScore = -1;
    while (el && el !== doc.body){
      if (el.contains(handBtn)){
        var n = controlCount(el);
        if (n >= 10){
          var r = el.getBoundingClientRect();
          var score = n + Math.min(200, r.width/10) - Math.max(0, r.top);
          if (score > bestScore){
            bestScore = score;
            best = el;
          }
        }
      }
      el = el.parentElement;
    }
    return best;
  }

  function closeAll(doc){
    try{
      var opens = doc.querySelectorAll(".ps-dd.open");
      for (var i=0;i<opens.length;i++){
        opens[i].classList.remove("open");
        var b = opens[i].querySelector(".ps-dd-btn");
        if (b) b.setAttribute("aria-expanded","false");
      }
    }catch(_){}
  }

  var GROUPS = [
    { id:"tools",  label:"Tools",  test:function(k){ return /^(Select|Hand|Highlight|Ink|Rect|Patch|Redact|Text|Image|Sign)$/i.test(k); } },
    { id:"assets", label:"Assets", test:function(k){ return /(Choose Img|Choose Sig|Replace Asset|Browse)/i.test(k) || /file|asset|img|sig/i.test(k); } },
    { id:"pages",  label:"Pages",  test:function(k){ return /(Rotate|Delete Pages|Duplicate|Insert Blank|Merge PDFs|Pages→|Pages ->|Pages->|Extract)/i.test(k); } },
    { id:"redact", label:"Redact", test:function(k){ return /redact|needles|package|verify needs/i.test(k); } },
    { id:"forms",  label:"Forms",  test:function(k){ return /form|dropdown|radio|field/i.test(k); } },
    { id:"export", label:"Export", test:function(k){ return /export|import|json|contract|project|flatten/i.test(k); } },
    { id:"server", label:"Server", test:function(k){ return /server|optimiz|lineariz|verify|raster|zip|secure/i.test(k); } },
    { id:"ops",    label:"Ops",    test:function(k){ return /ops|oplog|rebuild|replay|snapshot|job|guard/i.test(k) || /^clear$/i.test(k); } },
    { id:"view",   label:"View",   test:function(k){ return /fit|zoom/i.test(k) || k === "-" || k === "+"; } }
  ];

  function labelForAtom(el){
    try{
      if (!el) return "";
      if (el.tagName === "BUTTON") return norm(el.textContent);
      var b = el.querySelector && el.querySelector("button");
      if (b) return norm(b.textContent);

      var inp = (el.tagName === "INPUT") ? el : (el.querySelector ? el.querySelector("input") : null);
      if (inp) return norm(inp.getAttribute("placeholder") || inp.getAttribute("aria-label") || inp.name || inp.type || "input");

      var sel = (el.tagName === "SELECT") ? el : (el.querySelector ? el.querySelector("select") : null);
      if (sel) return norm(sel.getAttribute("aria-label") || sel.name || "select");

      var ta = (el.tagName === "TEXTAREA") ? el : (el.querySelector ? el.querySelector("textarea") : null);
      if (ta) return norm(ta.getAttribute("placeholder") || ta.getAttribute("aria-label") || ta.name || "text");

      return norm(el.textContent).slice(0,40);
    }catch(_){ return ""; }
  }

  function pickGroup(atomLabel){
    var k = (atomLabel || "").toString();
    for (var i=0;i<GROUPS.length;i++){
      if (GROUPS[i].test(k)) return GROUPS[i].id;
    }
    return "tools";
  }

  function buildBar(doc, insertBeforeEl){
    var existing = doc.getElementById("psToolboxBarV2");
    if (existing) return existing;
    var bar = doc.createElement("div");
    bar.id = "psToolboxBarV2";
    bar.className = "ps-toolbox-bar";
    insertBeforeEl.parentNode.insertBefore(bar, insertBeforeEl);
    return bar;
  }

  function makeDropdown(doc, bar, label){
    var dd = doc.createElement("div");
    dd.className = "ps-dd";

    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "ps-dd-btn";
    btn.textContent = label;
    btn.setAttribute("aria-expanded","false");

    var menu = doc.createElement("div");
    menu.className = "ps-dd-menu";
    menu.setAttribute("role","menu");

    var grid = doc.createElement("div");
    grid.className = "ps-grid";
    menu.appendChild(grid);

    dd.appendChild(btn);
    dd.appendChild(menu);
    bar.appendChild(dd);

    btn.addEventListener("click", function(e){
      e.preventDefault(); e.stopPropagation();
      var open = dd.classList.contains("open");
      closeAll(doc);
      if (!open){
        dd.classList.add("open");
        btn.setAttribute("aria-expanded","true");
        // flip if would overflow right edge
        requestAnimationFrame(function(){
          try{
            menu.style.left = "0";
            menu.style.right = "auto";
            var r = menu.getBoundingClientRect();
            if (r.right > doc.defaultView.innerWidth - 8){
              menu.style.left = "auto";
              menu.style.right = "0";
            }
          }catch(_){}
        });
      }
    });

    menu.addEventListener("click", function(e){ e.stopPropagation(); });
    return grid;
  }

  function extractAtoms(row){
    var atoms = [];
    try{
      var kids = [].slice.call(row.children || []);
      for (var i=0;i<kids.length;i++){
        var el = kids[i];
        if (!el) continue;
        if (el.id === "psToolboxBarV2") continue;
        if (el.matches && el.matches("button,input,select,textarea,label")) atoms.push(el);
        else if (el.querySelector && el.querySelector("button,input,select,textarea,label")) atoms.push(el);
      }
    }catch(_){}
    return atoms;
  }

  function findRows(wrapper){
    // pick any child that looks like a toolbar line: lots of controls, not huge height
    var rows = [];
    try{
      var kids = [].slice.call(wrapper.children || []);
      for (var i=0;i<kids.length;i++){
        var ch = kids[i];
        if (!ch || !ch.querySelectorAll) continue;
        var n = ch.querySelectorAll("button,input,select,textarea,label").length;
        if (n < 6) continue;
        var h = ch.getBoundingClientRect().height;
        if (h > 260) continue;
        rows.push(ch);
      }
      // If wrapper itself is the only "row"
      if (!rows.length) rows = [wrapper];
    }catch(_){}
    return rows;
  }

  function clampLeftovers(wrapper){
    try{
      wrapper.classList.add("ps-clamp");
      // try to fix flex rows that are nowrap
      var flexish = wrapper.querySelectorAll("*");
      for (var i=0;i<flexish.length;i++){
        var el = flexish[i];
        var cs = wrapper.ownerDocument.defaultView.getComputedStyle(el);
        if (cs.display === "flex" && cs.flexWrap === "nowrap"){
          el.classList.add("ps-nowrap-fix");
        }
      }
    }catch(_){}
  }

  function wireDoc(doc){
    ensureBadge(doc);
    ensureCss(doc);

    var wrapper = bestToolbarContainer(doc);
    if (!wrapper) return false;

    clampLeftovers(wrapper);

    // avoid re-wiring if already wired inside this wrapper
    if (doc.getElementById("psToolboxBarV2")) return true;

    var rows = findRows(wrapper);
    var bar = buildBar(doc, rows[0]);

    var grids = {};
    function ensureGroup(id){
      if (grids[id]) return grids[id];
      var def = GROUPS.filter(function(g){ return g.id === id; })[0];
      var grid = makeDropdown(doc, bar, def ? def.label : id);
      grids[id] = grid;
      return grid;
    }

    ["tools","assets","pages","redact","forms","export","server","ops","view"].forEach(ensureGroup);

    var moved = 0;
    for (var r=0;r<rows.length;r++){
      var row = rows[r];
      var atoms = extractAtoms(row);
      for (var a=0;a<atoms.length;a++){
        var atom = atoms[a];
        var lab = labelForAtom(atom);
        var gid = pickGroup(lab);
        ensureGroup(gid).appendChild(atom);
        moved++;
      }
      // hide the original row so it can’t extend off-screen
      row.style.display = "none";
    }

    // document-level close handlers
    doc.addEventListener("click", function(){ closeAll(doc); });
    doc.addEventListener("keydown", function(e){ if (e.key === "Escape") closeAll(doc); });

    // sanity: if we barely moved anything, undo (means we grabbed wrong container)
    if (moved < 10){
      try{ bar.remove(); }catch(_){}
      for (var rr=0; rr<rows.length; rr++){ try{ rows[rr].style.display=""; }catch(_){} }
      return false;
    }

    return true;
  }

  function boot(){
    // Try current doc plus any same-origin iframes (PDF Studio might be embedded)
    var docs = [];
    try{
      docs.push(document);
      var ifr = document.querySelectorAll("iframe");
      for (var i=0;i<ifr.length;i++){
        try{ if (ifr[i].contentDocument) docs.push(ifr[i].contentDocument); }catch(_){}
      }
    }catch(_){}

    // run repeatedly for a bit to catch SPA rerenders
    var tries = 0;
    var maxTries = 120; // ~60s
    var timer = setInterval(function(){
      tries++;
      var okAny = false;
      for (var d=0; d<docs.length; d++){
        try{ okAny = wireDoc(docs[d]) || okAny; }catch(_){}
      }
      if (okAny && tries > 5){
        // keep a few extra passes then stop
        if (tries > 20) clearInterval(timer);
      }
      if (tries >= maxTries) clearInterval(timer);
    }, 500);

    // mutation observer for late mounts
    try{
      var obs = new MutationObserver(function(){
        for (var d=0; d<docs.length; d++){
          try{ wireDoc(docs[d]); }catch(_){}
        }
      });
      obs.observe(document.body, { childList:true, subtree:true });
    }catch(_){}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
