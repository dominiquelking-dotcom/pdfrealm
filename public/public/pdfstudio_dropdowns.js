/* PDFREALM_PDFSTUDIO_DROPDOWNS_V1
   Collapses the long PDFStudio toolbar rows into compact dropdown groups.
   Safe: purely DOM moves (keeps existing event listeners).
*/
(function(){
  "use strict";

  function $(sel, root){ return (root||document).querySelector(sel); }
  function $$(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
  function norm(s){ return (s||"").replace(/\s+/g," ").trim(); }

  function btnByText(txt){
    txt = norm(txt);
    var btns = $$("button");
    for (var i=0;i<btns.length;i++){
      if (norm(btns[i].textContent) === txt) return btns[i];
    }
    return null;
  }

  function findToolbarSeed(){
    var a = btnByText("Select");
    var b = btnByText("Hand");
    if (!a || !b) return null;

    // walk up from Select to find a container that also contains Hand and has lots of controls
    var el = a.parentElement;
    while (el && el !== document.body){
      if (el.contains(b)){
        var n = el.querySelectorAll("button,input,select,textarea").length;
        if (n >= 10) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function findToolbarRows(seed){
    // Find a common wrapper that contains multiple "control rows"
    var wrapper = seed;
    for (var i=0;i<5 && wrapper.parentElement;i++){
      var p = wrapper.parentElement;
      var rowish = $$( ":scope > *", p).filter(function(ch){
        if (!ch.querySelector) return false;
        var count = ch.querySelectorAll("button,input,select,textarea").length;
        if (count < 6) return false;
        var h = ch.getBoundingClientRect().height;
        if (h > 220) return false;
        return true;
      });
      if (rowish.length >= 2) wrapper = p;
      else break;
    }

    var rows = $$( ":scope > *", wrapper).filter(function(ch){
      if (!ch.querySelector) return false;
      var count = ch.querySelectorAll("button,input,select,textarea").length;
      if (count < 6) return false;
      var h = ch.getBoundingClientRect().height;
      if (h > 220) return false;
      return true;
    });

    if (!rows.length) rows = [seed];
    return { wrapper: wrapper, rows: rows };
  }

  function ensureCss(){
    if ($("#pdfstudioDropdownCss")) return;
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
"@media (max-width:680px){.ps-dd-menu{min-width:calc(100vw - 24px);} .ps-grid input,.ps-grid select{min-width:140px;}}\n";

    var style = document.createElement("style");
    style.id = "pdfstudioDropdownCss";
    style.textContent = css;
    document.head.appendChild(style);
  }

  var GROUPS = [
    { id:"tools",  label:"Tools",  test:function(k){ return /^(Select|Hand|Highlight|Ink|Rect|Patch|Text|Image|Sign)$/i.test(k); } },
    { id:"assets", label:"Assets", test:function(k){ return /(Choose Img|Choose Sig|Replace Asset|Browse)/i.test(k) || /file|asset/i.test(k); } },
    { id:"pages",  label:"Pages",  test:function(k){ return /(Rotate|Delete Pages|Duplicate|Insert Blank|Merge PDFs|Pages→|Pages ->|Pages->|Extract)/i.test(k); } },
    { id:"redact", label:"Redact", test:function(k){ return /redact|needles|package/i.test(k); } },
    { id:"forms",  label:"Forms",  test:function(k){ return /form|dropdown|radio|field/i.test(k); } },
    { id:"export", label:"Export", test:function(k){ return /export|import|json|contract|project/i.test(k); } },
    { id:"server", label:"Server", test:function(k){ return /server|optimiz|lineariz|verify|raster|zip/i.test(k); } },
    { id:"ops",    label:"Ops",    test:function(k){ return /ops|oplog|rebuild|replay|snapshot|job/i.test(k) || /^clear$/i.test(k); } },
    { id:"view",   label:"View",   test:function(k){ return /fit|zoom/i.test(k) || k === "-" || k === "+"; } }
  ];

  function labelForAtom(el){
    var btn = el.tagName === "BUTTON" ? el : $("button", el);
    if (btn) return norm(btn.textContent);

    var inp = el.tagName === "INPUT" ? el : $("input", el);
    if (inp) return norm(inp.getAttribute("placeholder") || inp.getAttribute("aria-label") || inp.name || inp.type);

    var sel = el.tagName === "SELECT" ? el : $("select", el);
    if (sel) return norm(sel.getAttribute("aria-label") || sel.name || "select");

    return norm(el.textContent).slice(0,40);
  }

  function pickGroup(atomLabel){
    var k = (atomLabel || "").toString();
    for (var i=0;i<GROUPS.length;i++){
      if (GROUPS[i].test(k)) return GROUPS[i].id;
    }
    return "tools";
  }

  function closeAll(){
    $$(".ps-dd.open").forEach(function(dd){
      dd.classList.remove("open");
      var b = $(".ps-dd-btn", dd);
      if (b) b.setAttribute("aria-expanded","false");
    });
  }

  function buildBar(insertBeforeEl){
    var existing = $("#psToolboxBar");
    if (existing) return existing;

    var bar = document.createElement("div");
    bar.id = "psToolboxBar";
    bar.className = "ps-toolbox-bar";
    insertBeforeEl.parentNode.insertBefore(bar, insertBeforeEl);
    return bar;
  }

  function makeDropdown(bar, label){
    var dd = document.createElement("div");
    dd.className = "ps-dd";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-dd-btn";
    btn.textContent = label;
    btn.setAttribute("aria-expanded","false");

    var menu = document.createElement("div");
    menu.className = "ps-dd-menu";
    menu.setAttribute("role","menu");

    var grid = document.createElement("div");
    grid.className = "ps-grid";
    menu.appendChild(grid);

    dd.appendChild(btn);
    dd.appendChild(menu);
    bar.appendChild(dd);

    btn.addEventListener("click", function(e){
      e.preventDefault(); e.stopPropagation();
      var open = dd.classList.contains("open");
      closeAll();
      if (!open){
        dd.classList.add("open");
        btn.setAttribute("aria-expanded","true");
        requestAnimationFrame(function(){
          try{
            menu.style.left = "0";
            menu.style.right = "auto";
            var r = menu.getBoundingClientRect();
            if (r.right > window.innerWidth - 8){
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

  function extractAtomsFromRow(row){
    var kids = Array.prototype.slice.call(row.children || []);
    var atoms = [];
    for (var i=0;i<kids.length;i++){
      var el = kids[i];
      if (!el || !el.querySelector) continue;
      if (el.id === "psToolboxBar") continue;

      if (el.matches("button,input,select,textarea")) atoms.push(el);
      else if (el.querySelector("button,input,select,textarea")) atoms.push(el);
    }
    return atoms;
  }

  function wire(){
    ensureCss();

    var seed = findToolbarSeed();
    if (!seed) return false;

    var found = findToolbarRows(seed);
    var rows = found.rows;

    var bar = buildBar(rows[0]);

    var gridsById = {};
    function ensureGroup(id){
      if (gridsById[id]) return gridsById[id];
      var gdef = GROUPS.filter(function(g){ return g.id === id; })[0];
      var grid = makeDropdown(bar, gdef ? gdef.label : id);
      gridsById[id] = grid;
      return grid;
    }

    ["tools","assets","pages","redact","forms","export","server","ops","view"].forEach(function(id){ ensureGroup(id); });

    var moved = 0;
    for (var r=0;r<rows.length;r++){
      var row = rows[r];
      var atoms = extractAtomsFromRow(row);
      for (var a=0;a<atoms.length;a++){
        var atom = atoms[a];
        var lab = labelForAtom(atom);
        var gid = pickGroup(lab);
        ensureGroup(gid).appendChild(atom);
        moved++;
      }
      try{ row.style.display = "none"; }catch(_){}
    }

    document.addEventListener("click", closeAll);
    document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeAll(); });

    if (moved < 8){
      try{ bar.parentNode && bar.parentNode.removeChild(bar); }catch(_){}
      for (var rr=0; rr<rows.length; rr++){ try{ rows[rr].style.display=""; }catch(_){} }
      return false;
    }

    return true;
  }

  function boot(){
    if ($("#psToolboxBar")) return;

    var attempts = 0;
    var max = 80; // ~16s at 200ms
    var timer = setInterval(function(){
      attempts++;
      if (wire()){
        clearInterval(timer);
        return;
      }
      if (attempts >= max) clearInterval(timer);
    }, 200);

    try{
      var obs = new MutationObserver(function(){
        if (!$("#psToolboxBar")) wire();
      });
      obs.observe(document.body, { childList:true, subtree:true });
    }catch(_){}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
