/* PDFREALM_TOOLSET_NAV_PATCH_V9
   Fixes:
   - Keep the TOP "toolset" tabs (Standard / Premium / Secure / Governance / Breakthrough) across the top,
     NOT inside the left sidebar.
   - Click-to-open dropdown menus for each toolset tab (hover disabled).
   - PDF Studio cleanup: tools inside collapsible dropdown sections (Organize, Edit, Annotate, Convert, etc.)
   - Constrain dropdown width + 2-col layout so the tool list doesn't blow out the UI.
*/
(function () {
  // Prevent double-inject
  if (window.__PDFREALM_TOOLSET_NAV_PATCH_V9__) return;
  window.__PDFREALM_TOOLSET_NAV_PATCH_V9__ = true;

  // ---- Config ----
  var TOOLSET_SUITES = [
    { id: "standard", label: "Standard Tools" },
    { id: "premium", label: "Premium Tools" },
    { id: "secure", label: "Secure Tools" },
    { id: "governance", label: "Governance Tools" },
    { id: "breakthrough", label: "Breakthrough Tools" },
  ];

  // The secure tools in a preferred order (if present); others follow alphabetically
  var SECURE_ORDER = [
    "secure-redact",
    "secure-sanitize",
    "secure-encrypt",
    "secure-decrypt",
    "secure-password",
    "secure-sign",
    "secure-verify",
    "secure-permissions",
  ];

  // If you have a single tool that represents "breakthrough" / AI, put it here to force into that suite.
  var GOV_TOOL_ID = "governance";

  // ---- Small helpers ----
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function on(el, ev, fn) {
    if (!el) return;
    el.addEventListener(ev, fn, { passive: false });
  }
  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function injectCSSOnce() {
    if (document.getElementById("pdfrealm-toolset-nav-patch-css")) return;
    var st = document.createElement("style");
    st.id = "pdfrealm-toolset-nav-patch-css";
    st.textContent = [
      "/* toolset_nav_patch_v9 */",
      "#pdfrealmToolsetDock{display:flex;flex-direction:column;gap:10px;}",
      ".tool-tabbar{display:flex;gap:6px;overflow:auto;padding:6px 6px 0;scrollbar-width:thin;}",
      ".tool-tabbar button{white-space:nowrap;}",
      ".tool-tabbar button.active{outline:2px solid rgba(255,255,255,.15);}",
      "/* Ensure dropdown renders above everything */",
      ".toolset-menu{ z-index: 10001 !important; }",
      ".toolset-menu{ box-sizing:border-box; width:360px; max-width:min(92vw,420px); max-height:calc(100vh - 140px); overflow:auto; }",
      ".toolset-group{ border-top: 1px solid rgba(255,255,255,0.10); }",
      ".toolset-group-title{ cursor:pointer; padding:10px 12px; font-weight:600; list-style:none; display:flex; align-items:center; justify-content:space-between; }",
      ".toolset-group summary::-webkit-details-marker{ display:none; }",
      ".toolset-group[open]>.toolset-group-title{ background: rgba(255,255,255,0.06); }",
      ".toolset-menu-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; padding:8px 12px 12px; }",
      ".toolset-item{ display:flex; flex-direction:column; gap:2px; text-align:left; width:100%; }",
      ".toolset-label{ font-weight:500; }",
      ".toolset-hint{ font-size:12px; opacity:.75; }",
      ".toolset-empty{ padding:10px 12px; opacity:.8; }",
    ].join("\n");
    document.head.appendChild(st);
  }

  function normalizeSuiteId(id) {
    return String(id || "").toLowerCase().trim();
  }

  // Tool tabs in the DOM (your existing tool buttons). Expected:
  //   <button class="tool-tab" data-tool="merge" data-suite="standard">Merge</button>
  // If your markup differs, adjust these selectors once here.
  function allToolTabs() {
    return $all(".tool-tab[data-tool]");
  }

  function suiteForToolTab(tab) {
    var s = tab.getAttribute("data-suite") || "";
    s = normalizeSuiteId(s);
    // Fallback heuristics:
    if (!s) {
      var tid = normalizeSuiteId(tab.getAttribute("data-tool"));
      if (tid === GOV_TOOL_ID) return "governance";
      if (tid.indexOf("secure-") === 0 || tid.indexOf("redact") !== -1) return "secure";
      return "standard";
    }
    return s;
  }

  function labelForToolTab(tab) {
    // Prefer an explicit label attr, else button text
    return (tab.getAttribute("data-label") || tab.textContent || "").trim();
  }

  function toolIdForToolTab(tab) {
    return normalizeSuiteId(tab.getAttribute("data-tool"));
  }

  function isToolDisabled(tab) {
    return tab.disabled || tab.getAttribute("aria-disabled") === "true";
  }

  function suiteTools(suite, tabs) {
    var s = normalizeSuiteId(suite);
    var out = [];
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var sid = suiteForToolTab(tab);
      if (sid !== s) continue;

      out.push({
        id: toolIdForToolTab(tab),
        label: labelForToolTab(tab),
        disabled: isToolDisabled(tab),
      });
    }
    return out;
  }

  function sortTools(suite, tools) {
    suite = normalizeSuiteId(suite);
    if (suite === "secure") {
      tools.sort(function (a, b) {
        var ai = SECURE_ORDER.indexOf(a.id);
        var bi = SECURE_ORDER.indexOf(b.id);
        if (ai === -1 && bi === -1) return a.label.localeCompare(b.label);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      return;
    }
    tools.sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });
  }

  function priceHint(toolId) {
    // Optional tier hint text beneath a tool button (adjust if needed)
    if (!toolId) return "";
    if (toolId.indexOf("secure-") === 0) return "Secure";
    if (toolId.indexOf("premium-") === 0) return "Premium";
    return "";
  }

  // --- PDF Studio menu grouping (dropdown sections) ---
  function toolSearchText(t) {
    return ((t && t.label) ? String(t.label) : "") + " " + ((t && t.id) ? String(t.id) : "");
  }

  var GROUP_ORDER = [
    "Organize Pages",
    "Edit",
    "Annotate",
    "Convert & OCR",
    "Forms",
    "Sign",
    "Security",
    "Optimize",
    "Other"
  ];

  var GROUP_RULES = [
    // Put more specific buckets first so they win keyword matches
    { name: "Sign", keys: ["sign", "signature", "esign", "e-sign", "pades", "certificate", "cert"] },
    { name: "Forms", keys: ["form", "fields", "field", "fill", "flatten"] },
    { name: "Convert & OCR", keys: ["convert", "export", "import", " to ", "ocr", "word", "docx", "excel", "xlsx", "ppt", "pptx", "image", "jpg", "jpeg", "png", "tiff", "html"] },
    { name: "Security", keys: ["redact", "sanitize", "permission", "permissions", "encrypt", "decrypt", "password", "protect", "unlock", "security"] },
    { name: "Optimize", keys: ["compress", "optimize", "linearize", "reduce size", "shrink"] },
    { name: "Annotate", keys: ["annotat", "highlight", "underline", "strike", "comment", "note", "callout", "ink", "draw", "shape", "markup", "stamp"] },
    { name: "Edit", keys: ["edit", "replace", "erase", "whiteout", "text", "image"] },
    { name: "Organize Pages", keys: ["merge", "split", "reorder", "organize", "rotate", "crop", "trim", "extract", "insert", "delete", "duplicate", "page", "watermark", "header", "footer", "number", "bookmark", "background"] }
  ];

  function classifyGroup(t) {
    var s = toolSearchText(t).toLowerCase().replace(/\s+/g, " ").trim();
    for (var i = 0; i < GROUP_RULES.length; i++) {
      var rule = GROUP_RULES[i];
      for (var k = 0; k < rule.keys.length; k++) {
        var key = rule.keys[k];
        if (key.length && s.indexOf(key) !== -1) return rule.name;
      }
    }
    return "Other";
  }

  function groupTools(tools) {
    var groups = {};
    for (var i = 0; i < GROUP_ORDER.length; i++) groups[GROUP_ORDER[i]] = [];
    for (var j = 0; j < tools.length; j++) {
      var t = tools[j];
      var g = classifyGroup(t);
      if (!groups[g]) groups[g] = [];
      groups[g].push(t);
    }
    return groups;
  }

  function buildMenu(menuEl, suite) {
    if (!menuEl) return;
    menuEl.innerHTML = "";

    var all = allToolTabs();
    var tools = suiteTools(suite, all);
    sortTools(suite, tools);

    if (!tools.length) {
      var empty = document.createElement("div");
      empty.className = "toolset-empty";
      empty.textContent = "No tools in this suite yet.";
      menuEl.appendChild(empty);
      return;
    }

    var groups = groupTools(tools);

    for (var gi = 0; gi < GROUP_ORDER.length; gi++) {
      var groupName = GROUP_ORDER[gi];
      var items = groups[groupName] || [];
      if (!items.length) continue;

      var details = document.createElement("details");
      details.className = "toolset-group";
      // Open the first meaningful group by default (keeps UI compact)
      details.open = (gi === 0);

      var summary = document.createElement("summary");
      summary.className = "toolset-group-title";
      summary.textContent = groupName;
      details.appendChild(summary);

      var grid = document.createElement("div");
      grid.className = "toolset-menu-grid";
      grid.dataset.group = groupName;

      for (var i = 0; i < items.length; i++) {
        var t = items[i];

        var item = document.createElement("button");
        item.type = "button";
        item.className = "toolset-item";
        item.setAttribute("role", "menuitem");
        item.dataset.tool = t.id;

        var label = document.createElement("span");
        label.className = "toolset-label";
        label.textContent = t.label;
        item.appendChild(label);

        var ph = priceHint(t.id);
        if (ph) {
          var hint = document.createElement("span");
          hint.className = "toolset-hint";
          hint.textContent = ph;
          item.appendChild(hint);
        }

        if (t.disabled) {
          item.disabled = true;
          item.setAttribute("aria-disabled", "true");
          item.style.opacity = "0.6";
        }

        grid.appendChild(item);
      }

      details.appendChild(grid);
      menuEl.appendChild(details);
    }
  }

  function positionMenu(menuEl, anchorBtn) {
    // Use your existing positioning if present; fallback to a safe one.
    // If app CSS already positions .toolset-menu, this stays out of the way.
    if (!menuEl || !anchorBtn) return;

    var r = anchorBtn.getBoundingClientRect();
    menuEl.style.position = "fixed";
    menuEl.style.top = Math.round(r.bottom + 8) + "px";
    menuEl.style.left = Math.round(Math.min(r.left, window.innerWidth - 420)) + "px";
  }

  function closeAllMenus() {
    $all(".toolset-menu").forEach(function (m) {
      m.style.display = "none";
      m.setAttribute("aria-hidden", "true");
    });
    $all(".tool-tabbar button").forEach(function (b) {
      b.classList.remove("active");
      b.setAttribute("aria-expanded", "false");
    });
  }

  function ensureDock() {
    injectCSSOnce();

    var dock = document.getElementById("pdfrealmToolsetDock");
    if (dock) return dock;

    // Try to place into an existing left pane header area if present
    var host =
      document.getElementById("leftPane") ||
      document.querySelector(".left-pane") ||
      document.body;

    dock = document.createElement("div");
    dock.id = "pdfrealmToolsetDock";

    // Insert at top of host
    if (host.firstChild) host.insertBefore(dock, host.firstChild);
    else host.appendChild(dock);

    return dock;
  }

  function buildTopTabbar(dock) {
    // Create / reuse bar
    var bar = $(".tool-tabbar", dock);
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "tool-tabbar";
      dock.appendChild(bar);
    }
    bar.innerHTML = "";

    TOOLSET_SUITES.forEach(function (suite) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toolset-suite-btn";
      btn.textContent = suite.label;
      btn.dataset.suite = suite.id;
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
      bar.appendChild(btn);

      // Dedicated menu panel
      var menu = document.createElement("div");
      menu.className = "toolset-menu";
      menu.dataset.suite = suite.id;
      menu.style.display = "none";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-hidden", "true");
      document.body.appendChild(menu);

      on(btn, "click", function (e) {
        stop(e);

        var isOpen = menu.style.display !== "none";
        closeAllMenus();

        if (isOpen) return;

        btn.classList.add("active");
        btn.setAttribute("aria-expanded", "true");

        buildMenu(menu, suite.id);
        menu.style.display = "block";
        menu.setAttribute("aria-hidden", "false");
        positionMenu(menu, btn);
      });
    });

    // Click outside closes
    on(document, "click", function () {
      closeAllMenus();
    });

    // Menu item click -> click the original tool tab
    on(document, "click", function (e) {
      var t = e.target;
      // Walk up to .toolset-item
      while (t && t !== document.body && !(t.classList && t.classList.contains("toolset-item"))) {
        t = t.parentNode;
      }
      if (!t || !t.dataset || !t.dataset.tool) return;

      stop(e);

      var toolId = t.dataset.tool;
      var original = $('.tool-tab[data-tool="' + toolId + '"]');
      if (original && !original.disabled) {
        original.click();
      }
      closeAllMenus();
    });

    // ESC closes
    on(document, "keydown", function (e) {
      if (e.key === "Escape") closeAllMenus();
    });
  }

  function init() {
    var dock = ensureDock();
    buildTopTabbar(dock);
  }

  // init when DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
