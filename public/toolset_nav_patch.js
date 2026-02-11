/* PDFREALM_TOOLSET_NAV_PATCH_V7
   Goals:
   - Stable dropdown menus for ALL top toolset tabs (Standard / Premium / Secure / Governance / Breakthrough)
   - Build menus from the canonical tool list in the DOM (.tool-tab[data-tool]) using PDFREALM_TIER mapping when available
   - NO tier-pager clicking, NO body[data-toolset] CSS gating, NO MutationObserver loops
   - Click-to-open dropdown (hover disabled via injected CSS)
*/
(function () {
  "use strict";

  if (window.__PDFREALM_TOOLSET_NAV_PATCH_V7__) return;
  window.__PDFREALM_TOOLSET_NAV_PATCH_V7__ = true;

  var SECURE_ORDER = ["secure_send", "secure_chat", "secure_video", "secure_voip", "secure_containers"];
  var GOV_TOOL_ID = "breakthrough";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escCss(s) {
    s = String(s || "");
    try {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    } catch (_) {}
    return s.replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  function safeText(t) {
    try { return String(t || "").replace(/\s+/g, " ").trim(); } catch (_) { return ""; }
  }

  function injectCssOnce() {
    if (document.getElementById("pdfrealmToolsetPatchV7Style")) return;
    var st = document.createElement("style");
    st.id = "pdfrealmToolsetPatchV7Style";
    st.textContent = [
      "/* V7: click-only dropdown; disable hover-open */",
      ".toolset-tab:hover .toolset-menu{ display:none !important; }",
      ".toolset-tab.open .toolset-menu{ display:block !important; }",
      "/* Ensure dropdown above everything */",
      ".toolset-menu{ z-index: 9999 !important; }"
    ].join("\n");
    document.head.appendChild(st);
  }

  function getTierForTool(toolId) {
    var id = String(toolId || "").trim();
    if (!id) return "standard";

    // Prefer the canonical tier map if present
    try {
      if (window.PDFREALM_TIER && typeof window.PDFREALM_TIER.getTierForTool === "function") {
        return window.PDFREALM_TIER.getTierForTool(id) || "standard";
      }
    } catch (_) {}

    // DOM hint
    try {
      var btn = document.querySelector('.tool-tab[data-tool="' + escCss(id) + '"]');
      if (btn && btn.dataset && btn.dataset.tier) return btn.dataset.tier;
    } catch (_) {}

    // Heuristic fallback
    if (id.indexOf("secure_") === 0) return "secure";
    return "standard";
  }

  function setTier(tier) {
    var t = String(tier || "").trim();
    if (!(t === "standard" || t === "premium" || t === "secure")) return;
    try {
      if (window.PDFREALM_TIER && typeof window.PDFREALM_TIER.setTier === "function") {
        window.PDFREALM_TIER.setTier(t);
      }
    } catch (_) {}
  }

  function activateTool(toolId) {
    var id = String(toolId || "").trim();
    if (!id) return;

    // Make sure the correct tier is visible (prevents "I clicked premium but still seeing standard")
    setTier(getTierForTool(id));

    // Prefer clicking the sidebar tab (keeps all existing behavior)
    var sel = '.tool-tab[data-tool="' + escCss(id) + '"]';
    var btn = document.querySelector(sel);
    if (btn) {
      try { btn.scrollIntoView({ block: "nearest" }); } catch (_) {}
      try { btn.click(); } catch (_) {}
      return;
    }

    // Fallback to activator if exposed
    try {
      if (typeof window.__pdfrealmActivateTool === "function") window.__pdfrealmActivateTool(id);
    } catch (_) {}
  }

  function allToolTabs() {
    var btns = $$(".tool-tab[data-tool]");
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var id = safeText(b.getAttribute("data-tool"));
      if (!id || seen[id]) continue;
      seen[id] = true;
      var label = safeText(b.textContent) || id;
      var disabled = !!b.disabled || b.getAttribute("aria-disabled") === "true";
      out.push({ id: id, label: label, disabled: disabled, tier: getTierForTool(id) });
    }
    return out;
  }

  function sortTools(suite, tools) {
    if (suite === "secure") {
      var index = {};
      for (var i = 0; i < SECURE_ORDER.length; i++) index[SECURE_ORDER[i]] = i;
      tools.sort(function (a, b) {
        var ia = (a.id in index) ? index[a.id] : 999;
        var ib = (b.id in index) ? index[b.id] : 999;
        if (ia !== ib) return ia - ib;
        return a.label.localeCompare(b.label);
      });
      return tools;
    }
    tools.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return tools;
  }

  function suiteTools(suite, all) {
    suite = String(suite || "").trim();

    if (suite === "governance" || suite === "breakthrough") {
      // Show the governance entry even if its tier is "secure"
      var bt = all.filter(function (t) { return t.id === GOV_TOOL_ID; });
      if (!bt.length) bt = [{ id: GOV_TOOL_ID, label: "Breakthrough", disabled: false, tier: getTierForTool(GOV_TOOL_ID) }];
      return bt;
    }

    if (suite === "standard" || suite === "premium" || suite === "secure") {
      return all.filter(function (t) { return t.tier === suite; });
    }

    // Unknown suite -> empty
    return [];
  }

  function priceHint(toolId) {
    try {
      if (window.PDFREALM_TIER && typeof window.PDFREALM_TIER.getPriceLabelForTool === "function") {
        return window.PDFREALM_TIER.getPriceLabelForTool(toolId) || "";
      }
    } catch (_) {}
    return "";
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

    var grid = document.createElement("div");
    grid.className = "toolset-menu-grid";

    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      var item = document.createElement("button");
      item.type = "button";
      item.className = "toolset-item";
      item.setAttribute("role", "menuitem");
      item.dataset.tool = t.id;

      var label = document.createElement("span");
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

    menuEl.appendChild(grid);
  }

  function closeAll(tabs, except) {
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (except && tab === except) continue;
      tab.classList.remove("open");
      var btn = $(".toolset-btn", tab);
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  }

  function wire() {
    injectCssOnce();

    var bar = document.getElementById("toolsetTabs");
    if (!bar) return;

    var tabs = $$(".toolset-tab[data-toolset]", bar);
    if (!tabs.length) return;

    // Build menus once after DOM settles a bit (tools may be wired after app.js init)
    setTimeout(function () {
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        var suite = tab.getAttribute("data-toolset") || "";
        buildMenu($(".toolset-menu", tab), suite);
      }
    }, 250);

    for (var i = 0; i < tabs.length; i++) (function (tab) {
      var btn = $(".toolset-btn", tab);
      var menu = $(".toolset-menu", tab);
      if (!btn || !menu) return;

      // Stop clicks inside menu from closing everything
      menu.addEventListener("click", function (e) { e.stopPropagation(); });

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();

        var isOpen = tab.classList.contains("open");
        if (isOpen) {
          closeAll(tabs);
          return;
        }

        // Rebuild this suite lazily on open (handles dynamic tool lists without observers)
        try {
          var suite = tab.getAttribute("data-toolset") || "";
          buildMenu(menu, suite);
        } catch (_) {}

        closeAll(tabs, tab);
        tab.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      });

      menu.addEventListener("click", function (e) {
        var target = e.target && e.target.closest ? e.target.closest(".toolset-item[data-tool]") : null;
        if (!target) return;
        if (target.disabled || target.getAttribute("aria-disabled") === "true") return;

        e.preventDefault();
        e.stopPropagation();

        var toolId = target.getAttribute("data-tool");
        closeAll(tabs);
        activateTool(toolId);
      });
    })(tabs[i]);

    document.addEventListener("click", function () { closeAll(tabs); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(tabs); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();