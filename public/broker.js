
      (function () {
        // Footer year
        var y = document.getElementById("year");
        if (y) y.textContent = new Date().getFullYear();

        // -----------------------------------
        // Global: overlay scroll locking (stack-safe)
        // -----------------------------------
        var __lockCount = 0;
        function lockScroll() {
          __lockCount++;
          if (__lockCount === 1) document.body.style.overflow = "hidden";
        }
        function unlockScroll() {
          __lockCount = Math.max(0, __lockCount - 1);
          if (__lockCount === 0) document.body.style.overflow = "";
        }

        // -----------------------------------
        // Broker tabs
        // -----------------------------------
        function setBrokerTab(tab) {
          document.querySelectorAll("[data-broker-tab]").forEach(function (btn) {
            btn.classList.toggle("broker-tab-active", btn.getAttribute("data-broker-tab") === tab);
          });
          document.querySelectorAll("[data-broker-view]").forEach(function (view) {
            view.classList.toggle("broker-view-active", view.getAttribute("data-broker-view") === tab);
          });
        }

        document.addEventListener("click", function (e) {
          var tabBtn = e.target.closest("[data-broker-tab]");
          if (tabBtn) setBrokerTab(tabBtn.getAttribute("data-broker-tab"));
        });

        // -----------------------------------
        // Tools dropdown inside dashboard
        // -----------------------------------
        var toolsToggle = document.getElementById("brokerToolsToggle");
        var toolsMenu = document.getElementById("brokerToolsMenu");

        function closeToolsMenu(){ if (toolsMenu) toolsMenu.classList.remove("open"); }
        if (toolsToggle && toolsMenu) {
          toolsToggle.addEventListener("click", function (e) {
            e.stopPropagation();
            toolsMenu.classList.toggle("open");
          });

          toolsMenu.addEventListener("click", function (e) {
            e.stopPropagation();
            var item = e.target.closest(".broker-tools-item");
            if (!item) return;
            var tool = item.getAttribute("data-tool-target") || "";
            var url = tool ? "/?tool=" + encodeURIComponent(tool) : "/";
            window.open(url, "_blank", "noopener");
            closeToolsMenu();
          });
        }

        // -----------------------------------
        // Industry Packs dropdown
        // -----------------------------------
        var industryWrap = document.getElementById("industryMenuWrap");
        var industryToggle = document.getElementById("industryToggle");
        function closeIndustry(){ if (industryWrap) industryWrap.classList.remove("workspace-open"); }

        if (industryWrap && industryToggle) {
          industryToggle.addEventListener("click", function (e) {
            e.stopPropagation();
            industryWrap.classList.toggle("workspace-open");
          });
          industryWrap.addEventListener("click", function (e) { e.stopPropagation(); });
        }

        // One global click to close both menus (prevents handler collisions)
        document.addEventListener("click", function () {
          closeToolsMenu();
          closeIndustry();
        });

        // -----------------------------------
        // Alerts drawer
        // -----------------------------------
        var openAlertsBtn = document.getElementById("openAlertsBtn");
        var alertsDrawer = document.getElementById("alertsDrawer");
        var alertsBackdrop = document.getElementById("alertsBackdrop");
        var closeAlertsBtn = document.getElementById("closeAlertsBtn");

        function openAlerts() {
          if (!alertsDrawer) return;
          alertsDrawer.classList.add("open");
          alertsDrawer.setAttribute("aria-hidden", "false");
          lockScroll();
        }
        function closeAlerts() {
          if (!alertsDrawer) return;
          if (!alertsDrawer.classList.contains("open")) return;
          alertsDrawer.classList.remove("open");
          alertsDrawer.setAttribute("aria-hidden", "true");
          unlockScroll();
        }
        if (openAlertsBtn) openAlertsBtn.addEventListener("click", function (e) { e.stopPropagation(); openAlerts(); });
        if (alertsBackdrop) alertsBackdrop.addEventListener("click", function () { closeAlerts(); });
        if (closeAlertsBtn) closeAlertsBtn.addEventListener("click", function () { closeAlerts(); });

        // -----------------------------------
        // Load drawer
        // -----------------------------------
        var loadDrawer = document.getElementById("loadDrawer");
        var closeLoadDrawerBtn = document.getElementById("closeLoadDrawerBtn");

        var drawerLoadId = document.getElementById("drawerLoadId");
        var drawerStatusPill = document.getElementById("drawerStatusPill");
        var drawerLanePill = document.getElementById("drawerLanePill");
        var drawerRevenuePill = document.getElementById("drawerRevenuePill");
        var drawerCostPill = document.getElementById("drawerCostPill");
        var drawerMarginPill = document.getElementById("drawerMarginPill");

        function safeText(el){ return el && el.textContent ? el.textContent.trim() : ""; }

        function openLoadDrawerFromRow(tr) {
          if (!tr || !loadDrawer) return;

          var loadId = tr.getAttribute("data-load-id") || "Load";

          var statusCell = tr.querySelector("td:nth-child(3)");
          var pill = statusCell ? statusCell.querySelector(".pill, .pill-status") : null;
          var status = pill ? safeText(pill) : safeText(statusCell);

          var lane = safeText(tr.querySelector("td:nth-child(6)"));
          var revenue = safeText(tr.querySelector("td:nth-child(9)"));
          var cost = safeText(tr.querySelector("td:nth-child(10)"));
          var margin = safeText(tr.querySelector("td:nth-child(11)"));

          if (drawerLoadId) drawerLoadId.textContent = loadId;
          if (drawerStatusPill) drawerStatusPill.textContent = "Status: " + (status || "—");
          if (drawerLanePill) drawerLanePill.textContent = "Lane: " + (lane || "—");
          if (drawerRevenuePill) drawerRevenuePill.textContent = "Revenue: " + (revenue || "—");
          if (drawerCostPill) drawerCostPill.textContent = "Cost: " + (cost || "—");
          if (drawerMarginPill) drawerMarginPill.textContent = "Margin: " + (margin || "—");

          loadDrawer.classList.add("open");
          loadDrawer.setAttribute("aria-hidden", "false");
          lockScroll();
        }

        function closeLoadDrawer() {
          if (!loadDrawer) return;
          if (!loadDrawer.classList.contains("open")) return;
          loadDrawer.classList.remove("open");
          loadDrawer.setAttribute("aria-hidden", "true");
          unlockScroll();
        }
        if (closeLoadDrawerBtn) closeLoadDrawerBtn.addEventListener("click", function () { closeLoadDrawer(); });

        document.addEventListener("click", function (e) {
          var btn = e.target.closest(".openLoadBtn, .openLoadLink");
          if (!btn) return;
          e.preventDefault();
          var tr = btn.closest("tr");
          openLoadDrawerFromRow(tr);
        });

        // Select all loads
        var loadSelectAll = document.getElementById("loadSelectAll");
        if (loadSelectAll) {
          loadSelectAll.addEventListener("change", function () {
            var chks = document.querySelectorAll(".loadChk");
            chks.forEach(function (c) { c.checked = loadSelectAll.checked; });
          });
        }

        // Load view segments (visual only)
        document.addEventListener("click", function (e) {
          var seg = e.target.closest(".seg");
          if (!seg) return;
          document.querySelectorAll(".seg").forEach(function (x) { x.classList.remove("active"); });
          seg.classList.add("active");
        });

        // -----------------------------------
        // Digital Clock w/ Timezone
        // -----------------------------------
        var CLOCK_TZ_KEY = "pdfrealm.broker.clock.timezone.v1";
        var liveClock = document.getElementById("liveClock");
        var liveClockTz = document.getElementById("liveClockTz");
        var tzSelect = document.getElementById("tzSelect");

        var TZ_ALIAS = { "America/Indianapolis": "America/Indiana/Indianapolis" };
        var TZ_LIST = [
          "local","UTC",
          "America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Phoenix",
          "America/Anchorage","Pacific/Honolulu",
          "America/Indiana/Indianapolis","America/Kentucky/Louisville",
          "Europe/London","Europe/Paris","Europe/Berlin",
          "Asia/Dubai","Asia/Kolkata","Asia/Singapore","Asia/Tokyo",
          "Australia/Sydney"
        ];

        function normalizeTz(tz) {
          if (!tz) return "local";
          if (tz === "local") return "local";
          return TZ_ALIAS[tz] || tz;
        }

        function getSavedTz() {
          try {
            var v = localStorage.getItem(CLOCK_TZ_KEY);
            v = normalizeTz(v);
            if (v && (v === "local" || TZ_LIST.indexOf(v) !== -1)) return v;
            return "local";
          } catch (e) { return "local"; }
        }
        function setSavedTz(tz) { try { localStorage.setItem(CLOCK_TZ_KEY, normalizeTz(tz)); } catch (e) {} }
        function prettyTzLabel(tz) { return (tz === "local") ? "Local" : tz; }

        function buildTzOptions() {
          if (!tzSelect) return;
          tzSelect.innerHTML = "";
          TZ_LIST.forEach(function (tz) {
            var opt = document.createElement("option");
            opt.value = tz;
            opt.textContent = prettyTzLabel(tz);
            tzSelect.appendChild(opt);
          });
        }

        function formatTimeForTz(dateObj, tz) {
          var useLocal = (tz === "local");
          var normalized = normalizeTz(tz);
          try {
            if (useLocal) {
              return new Intl.DateTimeFormat(undefined, { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true }).format(dateObj);
            }
            return new Intl.DateTimeFormat(undefined, { timeZone: normalized, hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true }).format(dateObj);
          } catch (e) {
            var h = dateObj.getHours(), m = dateObj.getMinutes(), s = dateObj.getSeconds();
            var ampm = h >= 12 ? "PM" : "AM";
            h = h % 12; if (h === 0) h = 12;
            function p2(n){ return String(n).padStart(2,"0"); }
            return p2(h) + ":" + p2(m) + ":" + p2(s) + " " + ampm;
          }
        }

        function startClock() {
          if (!liveClock || !liveClockTz || !tzSelect) return;
          buildTzOptions();
          var tz = getSavedTz();
          tzSelect.value = tz;
          liveClockTz.textContent = prettyTzLabel(tz);

          function tick() {
            var now = new Date();
            var currentTz = tzSelect.value || "local";
            liveClock.textContent = formatTimeForTz(now, currentTz);
            liveClockTz.textContent = prettyTzLabel(currentTz);
          }

          tick();
          setInterval(tick, 1000);

          tzSelect.addEventListener("change", function () {
            var v = tzSelect.value || "local";
            setSavedTz(v);
            liveClockTz.textContent = prettyTzLabel(v);
            liveClock.textContent = formatTimeForTz(new Date(), v);
          });
        }
        startClock();

        // -----------------------------------
        // Calendar (Broker) - localStorage
        // -----------------------------------
        var CAL_KEY = "pdfrealm.broker.calendar.v1";
        function pad2(n) { return String(n).padStart(2, "0"); }
        function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
        function parseLocalDateTime(dateStr, timeStr) {
          if (!dateStr) return null;
          var parts = dateStr.split("-");
          var yy = Number(parts[0]), mm = Number(parts[1]) - 1, dd = Number(parts[2]);
          var hh = 9, mi = 0;
          if (timeStr) { var t = timeStr.split(":"); hh = Number(t[0] || 0); mi = Number(t[1] || 0); }
          return new Date(yy, mm, dd, hh, mi, 0, 0);
        }
        function uid() { return "evt_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
        function loadEvents() {
          try {
            var raw = localStorage.getItem(CAL_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr;
          } catch (e) { return []; }
        }
        function saveEvents(events) { localStorage.setItem(CAL_KEY, JSON.stringify(events || [])); }
        function eventOccursOn(evt, dateStr) { return evt && evt.date === dateStr; }

        var calModal = document.getElementById("calendarModal");
        var calBackdrop = document.getElementById("calendarBackdrop");
        var calCloseBtn = document.getElementById("calCloseBtn");
        var calGrid = document.getElementById("calGrid");
        var calMonthLabel = document.getElementById("calMonthLabel");
        var calPrevBtn = document.getElementById("calPrevBtn");
        var calNextBtn = document.getElementById("calNextBtn");
        var calTodayBtn = document.getElementById("calTodayBtn");
        var calNewBtn = document.getElementById("calNewBtn");

        var calSideTitle = document.getElementById("calSideTitle");
        var calSideSub = document.getElementById("calSideSub");
        var calEventList = document.getElementById("calEventList");

        var calEventTitle = document.getElementById("calEventTitle");
        var calEventType = document.getElementById("calEventType");
        var calEventDate = document.getElementById("calEventDate");
        var calEventTime = document.getElementById("calEventTime");
        var calEventNotes = document.getElementById("calEventNotes");

        var calRemindMinutes = document.getElementById("calRemindMinutes");
        var calRemindEmail = document.getElementById("calRemindEmail");
        var calRemindPhone = document.getElementById("calRemindPhone");

        var calSaveBtn = document.getElementById("calSaveBtn");
        var calClearBtn = document.getElementById("calClearBtn");
        var calStatus = document.getElementById("calStatus");

        var brokerCalendarBtn = document.getElementById("brokerCalendarBtn");

        var state = {
          viewYear: new Date().getFullYear(),
          viewMonth: new Date().getMonth(),
          selectedDate: ymd(new Date()),
          editingId: null
        };

        function openCalendar() {
          if (!calModal) return;
          calModal.classList.add("open");
          calModal.setAttribute("aria-hidden", "false");
          lockScroll();
          selectDate(state.selectedDate, { silent: true });
          renderCalendar();
          renderSidePanel();
        }
        function closeCalendar() {
          if (!calModal) return;
          if (!calModal.classList.contains("open")) return;
          calModal.classList.remove("open");
          calModal.setAttribute("aria-hidden", "true");
          unlockScroll();
          if (calStatus) calStatus.textContent = "";
        }

        if (brokerCalendarBtn) brokerCalendarBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          ensureNotifyPermission();
          openCalendar();
        });
        if (calBackdrop) calBackdrop.addEventListener("click", function () { closeCalendar(); });
        if (calCloseBtn) calCloseBtn.addEventListener("click", function () { closeCalendar(); });

        if (calPrevBtn) calPrevBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          state.viewMonth -= 1;
          if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear -= 1; }
          renderCalendar();
        });

        if (calNextBtn) calNextBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          state.viewMonth += 1;
          if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear += 1; }
          renderCalendar();
        });

        if (calTodayBtn) calTodayBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var d = new Date();
          state.viewYear = d.getFullYear();
          state.viewMonth = d.getMonth();
          state.selectedDate = ymd(d);
          selectDate(state.selectedDate);
          renderCalendar();
        });

        if (calNewBtn) calNewBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          state.editingId = null;
          calEventTitle.value = "";
          calEventType.value = "appointment";
          calEventDate.value = state.selectedDate || ymd(new Date());
          calEventTime.value = "";
          calEventNotes.value = "";
          calRemindMinutes.value = "";
          calRemindEmail.value = "";
          calRemindPhone.value = "";
          if (calStatus) calStatus.textContent = "New event ready. Fill details and click Save.";
          renderSidePanel();
        });

        function monthName(y2, m2) {
          var d2 = new Date(y2, m2, 1);
          return d2.toLocaleString(undefined, { month: "long", year: "numeric" });
        }

        function getMonthGridStart(y2, m2) {
          var first = new Date(y2, m2, 1);
          var dayOfWeek = first.getDay();
          var start = new Date(y2, m2, 1 - dayOfWeek);
          start.setHours(0,0,0,0);
          return start;
        }

        function renderCalendar() {
          if (!calGrid) return;
          if (calMonthLabel) calMonthLabel.textContent = monthName(state.viewYear, state.viewMonth);

          var start = getMonthGridStart(state.viewYear, state.viewMonth);
          var events = loadEvents();

          calGrid.innerHTML = "";
          for (var i = 0; i < 42; i++) {
            var cellDate = new Date(start.getTime());
            cellDate.setDate(start.getDate() + i);
            var cellStr = ymd(cellDate);

            var isCurrentMonth = (cellDate.getMonth() === state.viewMonth);
            var isSelected = (cellStr === state.selectedDate);

            var dayEvents = events.filter(function (ev) { return eventOccursOn(ev, cellStr); });

            var cell = document.createElement("div");
            cell.className = "cal-day";
            if (!isCurrentMonth) cell.classList.add("cal-day-muted");
            if (isSelected) {
              cell.style.background = "rgba(106,168,255,0.10)";
              cell.style.boxShadow = "inset 0 0 0 1px rgba(106,168,255,0.25)";
            }
            cell.setAttribute("data-date", cellStr);

            var head = document.createElement("div");
            head.className = "cal-day-head";

            var num = document.createElement("div");
            num.className = "cal-day-num";
            num.textContent = String(cellDate.getDate());

            var badges = document.createElement("div");
            badges.className = "cal-badges";
            if (dayEvents.length > 0) {
              var dot = document.createElement("div");
              dot.className = "cal-dot";
              badges.appendChild(dot);
            }

            head.appendChild(num);
            head.appendChild(badges);

            var items = document.createElement("div");
            items.className = "cal-items";
            dayEvents.slice(0, 2).forEach(function (ev) {
              var it = document.createElement("div");
              it.className = "cal-item";
              var t = ev.time ? ("<small>" + ev.time + "</small> ") : "";
              it.innerHTML = t + (ev.title || "(Untitled)");
              items.appendChild(it);
            });
            if (dayEvents.length > 2) {
              var more = document.createElement("div");
              more.className = "cal-item";
              more.style.borderColor = "rgba(255,255,255,0.16)";
              more.style.background = "rgba(255,255,255,0.03)";
              more.textContent = "+" + (dayEvents.length - 2) + " more";
              items.appendChild(more);
            }

            cell.appendChild(head);
            cell.appendChild(items);
            calGrid.appendChild(cell);
          }

          calGrid.onclick = function (e) {
            var day = e.target.closest(".cal-day");
            if (!day) return;
            var dstr = day.getAttribute("data-date");
            if (!dstr) return;

            var parts = dstr.split("-");
            var ny = Number(parts[0]);
            var nm = Number(parts[1]) - 1;
            if (nm !== state.viewMonth || ny !== state.viewYear) {
              state.viewYear = ny;
              state.viewMonth = nm;
            }

            selectDate(dstr);
            renderCalendar();
          };
        }

        function selectDate(dateStr, opts) {
          state.selectedDate = dateStr;
          if (calSideTitle) calSideTitle.textContent = "Selected: " + dateStr;
          if (calSideSub) calSideSub.textContent = "Add appointments, deadlines, or notes for this day.";
          if (!opts || !opts.silent) {
            if (!state.editingId && calEventDate) calEventDate.value = dateStr;
          }
          renderSidePanel();
        }

        function renderSidePanel() {
          var events = loadEvents();
          var dayEvents = events
            .filter(function (ev) { return eventOccursOn(ev, state.selectedDate); })
            .sort(function (a, b) {
              if (a.time && b.time) return a.time.localeCompare(b.time);
              if (a.time && !b.time) return -1;
              if (!a.time && b.time) return 1;
              return (a.createdAt || 0) - (b.createdAt || 0);
            });

          if (!calEventList) return;

          calEventList.innerHTML = "";
          if (dayEvents.length === 0) {
            var empty = document.createElement("div");
            empty.style.color = "var(--muted)";
            empty.style.fontSize = "0.95rem";
            empty.style.marginTop = "10px";
            empty.textContent = "No events yet. Create one using the form above.";
            calEventList.appendChild(empty);
            return;
          }

          dayEvents.forEach(function (ev) {
            var row = document.createElement("div");
            row.className = "cal-event-row";

            var title = document.createElement("div");
            title.className = "t";
            title.textContent =
              (ev.time ? ev.time + " • " : "") +
              (ev.title || "(Untitled)") +
              (ev.type ? " (" + ev.type + ")" : "");

            var meta = document.createElement("div");
            meta.className = "m";
            meta.textContent = ev.notes ? ev.notes : "—";

            var rem = document.createElement("div");
            rem.className = "m";
            var rm = [];
            if (ev.remindMinutes) rm.push("Reminder: " + ev.remindMinutes + " min before");
            if (ev.remindEmail) rm.push("Email: " + ev.remindEmail);
            if (ev.remindPhone) rm.push("SMS: " + ev.remindPhone);
            rem.textContent = rm.length ? rm.join(" • ") : "Reminder: none";

            var actions = document.createElement("div");
            actions.className = "a";

            var editBtn = document.createElement("button");
            editBtn.className = "btn btn-secondary";
            editBtn.type = "button";
            editBtn.textContent = "Edit";
            editBtn.onclick = function () {
              state.editingId = ev.id;
              calEventTitle.value = ev.title || "";
              calEventType.value = ev.type || "appointment";
              calEventDate.value = ev.date || state.selectedDate;
              calEventTime.value = ev.time || "";
              calEventNotes.value = ev.notes || "";
              calRemindMinutes.value = ev.remindMinutes || "";
              calRemindEmail.value = ev.remindEmail || "";
              calRemindPhone.value = ev.remindPhone || "";
              if (calStatus) calStatus.textContent = "Editing event. Make changes and click Save.";
            };

            var delBtn = document.createElement("button");
            delBtn.className = "btn btn-secondary";
            delBtn.type = "button";
            delBtn.textContent = "Delete";
            delBtn.onclick = function () {
              var all = loadEvents();
              var next = all.filter(function (x) { return x.id !== ev.id; });
              saveEvents(next);
              if (state.editingId === ev.id) state.editingId = null;
              if (calStatus) calStatus.textContent = "Event deleted.";
              renderCalendar();
              renderSidePanel();
            };

            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            row.appendChild(title);
            row.appendChild(meta);
            row.appendChild(rem);
            row.appendChild(actions);

            calEventList.appendChild(row);
          });
        }

        function clearFormToSelected() {
          state.editingId = null;
          calEventTitle.value = "";
          calEventType.value = "appointment";
          calEventDate.value = state.selectedDate || ymd(new Date());
          calEventTime.value = "";
          calEventNotes.value = "";
          calRemindMinutes.value = "";
          calRemindEmail.value = "";
          calRemindPhone.value = "";
        }

        if (calClearBtn) calClearBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          clearFormToSelected();
          if (calStatus) calStatus.textContent = "Cleared.";
        });

        if (calSaveBtn) calSaveBtn.addEventListener("click", function (e) {
          e.stopPropagation();

          var title = (calEventTitle.value || "").trim();
          var type = calEventType.value || "appointment";
          var date = calEventDate.value || state.selectedDate;
          var time = calEventTime.value || "";
          var notes = (calEventNotes.value || "").trim();

          var remindMinutes = calRemindMinutes.value || "";
          var remindEmail = (calRemindEmail.value || "").trim();
          var remindPhone = (calRemindPhone.value || "").trim();

          if (!date) { if (calStatus) calStatus.textContent = "Please select a date."; return; }

          var all = loadEvents();
          var ev = {
            id: state.editingId || uid(),
            title: title || "(Untitled)",
            type: type,
            date: date,
            time: time,
            notes: notes,
            remindMinutes: remindMinutes,
            remindEmail: remindEmail,
            remindPhone: remindPhone,
            createdAt: Date.now(),
            lastRemindedAt: null
          };

          if (state.editingId) {
            all = all.map(function (x) { return x.id === state.editingId ? ev : x; });
            if (calStatus) calStatus.textContent = "Saved changes.";
          } else {
            all.push(ev);
            if (calStatus) calStatus.textContent = "Event saved.";
          }

          saveEvents(all);

          state.selectedDate = date;
          var parts = date.split("-");
          state.viewYear = Number(parts[0]);
          state.viewMonth = Number(parts[1]) - 1;

          state.editingId = null;

          renderCalendar();
          renderSidePanel();
        });

        function shouldTriggerReminder(ev, now) {
          if (!ev.remindMinutes) return false;
          var mins = Number(ev.remindMinutes);
          if (!isFinite(mins) || mins <= 0) return false;

          var dt = parseLocalDateTime(ev.date, ev.time || "");
          if (!dt) return false;

          var triggerAt = new Date(dt.getTime() - mins * 60 * 1000);
          var windowMs = 60 * 1000;
          var diff = now.getTime() - triggerAt.getTime();
          if (diff < 0 || diff > windowMs) return false;

          if (ev.lastRemindedAt && (now.getTime() - ev.lastRemindedAt) < 5 * 60 * 1000) return false;
          return true;
        }

        function tryBrowserNotify(title, body) {
          if (!("Notification" in window)) return;
          if (Notification.permission === "granted") {
            try { new Notification(title, { body: body }); } catch (e) {}
          }
        }

        function reminderTick() {
          var now = new Date();
          var all = loadEvents();
          var changed = false;

          for (var i = 0; i < all.length; i++) {
            var ev = all[i];
            if (shouldTriggerReminder(ev, now)) {
              var msg =
                (ev.title || "Event") + " (" + ev.type + ") at " + (ev.time || "09:00") + " on " + ev.date +
                (ev.notes ? (" — " + ev.notes) : "");

              tryBrowserNotify("PDFRealm Reminder", msg);
              alert("PDFRealm Reminder:\n\n" + msg);

              ev.lastRemindedAt = now.getTime();
              all[i] = ev;
              changed = true;
            }
          }
          if (changed) saveEvents(all);
        }

        setInterval(reminderTick, 30000);

        function ensureNotifyPermission() {
          if (!("Notification" in window)) return;
          if (Notification.permission === "default") {
            try { Notification.requestPermission(); } catch (e) {}
          }
        }

        (function initCalendarDefaults() {
          var d = new Date();
          state.viewYear = d.getFullYear();
          state.viewMonth = d.getMonth();
          state.selectedDate = ymd(d);
          clearFormToSelected();
        })();

        // -----------------------------------
        // Account modal + Auth (JWT Bearer)
        // Fixes your issue: broker endpoints require Authorization header.
        // We do NOT use cookies (/api/me). We use /api/broker/me.
        // -----------------------------------
        var TOKEN_KEY = "pdfrealm_token";

        function getToken() {
          try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
        }
        function setToken(t) {
          try { localStorage.setItem(TOKEN_KEY, t || ""); } catch (e) {}
        }
        function clearToken() {
          try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        }
        function authHeaders(extra) {
          var h = Object.assign({}, extra || {});
          var t = getToken();
          if (t) h["Authorization"] = "Bearer " + t;
          return h;
        }

        var accountModal = document.getElementById("accountModal");
        var accountBackdrop = document.getElementById("accountBackdrop");
        var accountLoginBtn = document.getElementById("accountLoginBtn");
        var accountModalClose = document.getElementById("accountModalClose");
        var accountDot = document.getElementById("accountDot");

        var loginEmail = document.getElementById("loginEmail");
        var loginPassword = document.getElementById("loginPassword");
        var loginSubmitBtn = document.getElementById("loginSubmitBtn");
        var subscribeMonthlyBtn = document.getElementById("subscribeMonthlyBtn");
        var subscribeYearlyBtn = document.getElementById("subscribeYearlyBtn");
        var logoutBtn = document.getElementById("logoutBtn");
        var loginStatus = document.getElementById("loginStatus");

        function openAccountModal() {
          if (!accountModal) return;
          accountModal.classList.add("open");
          accountModal.setAttribute("aria-hidden", "false");
          lockScroll();
        }
        function closeAccountModal() {
          if (!accountModal) return;
          if (!accountModal.classList.contains("open")) return;
          accountModal.classList.remove("open");
          accountModal.setAttribute("aria-hidden", "true");
          unlockScroll();
        }
    // Expose for other modules
    window.openAccountModal = openAccountModal;
    window.closeAccountModal = closeAccountModal;


        if (accountLoginBtn) accountLoginBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          openAccountModal();
          refreshBrokerMe();
        });
        if (accountModalClose) accountModalClose.addEventListener("click", function () { closeAccountModal(); });
        if (accountBackdrop) accountBackdrop.addEventListener("click", function () { closeAccountModal(); });

        function setDot(isAuthed) {
          if (!accountDot) return;
          accountDot.style.opacity = "1";
          accountDot.style.background = isAuthed ? "rgba(93,230,194,0.95)" : "rgba(255,255,255,0.25)";
          accountDot.style.boxShadow = isAuthed ? "0 0 0 2px rgba(93,230,194,0.15)" : "none";
        }

        async function refreshBrokerMe() {
          if (!loginStatus) return;
          var t = getToken();
          if (!t) {
            setDot(false);
            if (logoutBtn) logoutBtn.style.display = "none";
            if (loginSubmitBtn) loginSubmitBtn.disabled = false;
            loginStatus.textContent = "Not signed in.";
            return;
          }

          try {
            var res = await fetch("/api/broker/me", {
              method: "GET",
              headers: authHeaders({ "Accept": "application/json" })
            });

            if (!res.ok) throw new Error("not authed");
            var data = await res.json();

            setDot(true);
            if (logoutBtn) logoutBtn.style.display = "";
            if (loginSubmitBtn) loginSubmitBtn.disabled = true;

            var email =
              (data && data.user && data.user.email) ? data.user.email :
              (data && (data.email || data.userEmail)) ? (data.email || data.userEmail) :
              "Logged in";

            loginStatus.textContent = "Signed in as: " + email;
          } catch (e) {
            // Token invalid/expired → clear so we don't get stuck in 401 loops.
            clearToken();
            setDot(false);
            if (logoutBtn) logoutBtn.style.display = "none";
            if (loginSubmitBtn) loginSubmitBtn.disabled = false;
            loginStatus.textContent = "Not signed in.";
          }
        }

        async function doLogin() {
          if (!loginEmail || !loginPassword || !loginStatus) return;

          var email = (loginEmail.value || "").trim();
          var password = (loginPassword.value || "").trim();

          if (!email || !password) {
            loginStatus.textContent = "Enter email + password.";
            return;
          }

          loginStatus.textContent = "Signing in…";

          try {
            var res = await fetch("/api/login", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ email: email, password: password })
            });

            var payload = null;
            try { payload = await res.json(); } catch (e) {}

            if (!res.ok) {
              var msg = (payload && (payload.error || payload.message))
                ? (payload.error || payload.message)
                : ("Login failed (" + res.status + ")");
              loginStatus.textContent = msg;
              setDot(false);
              return;
            }

            if (!payload || !payload.token) {
              loginStatus.textContent = "Login succeeded but no token returned.";
              setDot(false);
              return;
            }

            setToken(payload.token);
            loginStatus.textContent = "Signed in.";
            await refreshBrokerMe();
          } catch (err) {
            loginStatus.textContent = "Login error: " + (err && err.message ? err.message : String(err));
            setDot(false);
          }
        }

        async function doLogout() {
          if (!loginStatus) return;
          loginStatus.textContent = "Signing out…";

          // Optional: server may or may not use this; safe no-op.
          try {
            await fetch("/api/logout", {
              method: "POST",
              headers: authHeaders({ "Accept": "application/json" })
            });
          } catch (e) {}

          clearToken();
          if (loginPassword) loginPassword.value = "";
          loginStatus.textContent = "Signed out.";
          setDot(false);
          if (logoutBtn) logoutBtn.style.display = "none";
          if (loginSubmitBtn) loginSubmitBtn.disabled = false;
        }

        if (loginSubmitBtn) loginSubmitBtn.addEventListener("click", function (e) {
          e.preventDefault();
          doLogin();
        });
        if (logoutBtn) logoutBtn.addEventListener("click", function (e) {
          e.preventDefault();
          doLogout();
        });

        // Subscribe buttons remain non-breaking
        async function tryCheckout(kind) {
          if (!loginStatus) return;
          loginStatus.textContent = "Opening checkout…";
          try {
            var url = (kind === "yearly")
              ? "/api/billing/create-checkout-session"
              : "/api/paywall/create-checkout-session";

            var res = await fetch(url, {
              method: "POST",
              headers: authHeaders({ "Accept": "application/json" })
            });

            if (!res.ok) {
              loginStatus.textContent = "Subscribe is not wired on this deployment yet.";
              return;
            }

            var data = null;
            try { data = await res.json(); } catch (e) {}
            var redirect = data && (data.url || data.checkoutUrl);
            if (redirect) window.location.href = redirect;
            else loginStatus.textContent = "Checkout created (no redirect URL returned).";
          } catch (e) {
            loginStatus.textContent = "Subscribe is not wired on this deployment yet.";
          }
        }

        if (subscribeMonthlyBtn) subscribeMonthlyBtn.addEventListener("click", function (e) {
          e.preventDefault(); tryCheckout("monthly");
        });
        if (subscribeYearlyBtn) subscribeYearlyBtn.addEventListener("click", function (e) {
          e.preventDefault(); tryCheckout("yearly");
        });

        // -----------------------------------
        // Global Escape handling (no scroll bugs)
        // -----------------------------------
        document.addEventListener("keydown", function (e) {
          if (e.key !== "Escape") return;
          if (alertsDrawer && alertsDrawer.classList.contains("open")) closeAlerts();
          if (loadDrawer && loadDrawer.classList.contains("open")) closeLoadDrawer();
          if (calModal && calModal.classList.contains("open")) closeCalendar();
          if (accountModal && accountModal.classList.contains("open")) closeAccountModal();
        });

        // Initial auth indicator (header dot) without opening modal
        window.addEventListener("DOMContentLoaded", function () {
          refreshBrokerMe();
        });

      })();
    
// ================================
// Loads Tab (API-backed)
// ================================
const loadsState = {
  loaded: false,
  loading: false,
  cache: new Map(), // id -> load
};

function getAuthToken() {
  return localStorage.getItem("pdfrealm_token") || "";
}

async function apiJson(path, { method="GET", body=null, headers={} } = {}) {
  const h = { ...headers };
  const token = getAuthToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers: h, body });
  let data = null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => null);
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : (typeof data === "string" ? data : `HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtMoney(n) {
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusPillClass(status) {
  const s = String(status || "")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");

  // Match existing dashboard styling: .pill.good / .pill.warn / .pill.bad
  if (["PAID","DELIVERED","BILLED","COMPLETED"].includes(s)) return "pill good";
  if (["BOOKED","IN_TRANSIT","INTRANSIT","PICKED_UP","PICKEDUP"].includes(s)) return "pill warn";
  if (["EXCEPTION","CANCELLED","CANCELED","REJECTED"].includes(s)) return "pill bad";
  return "pill";
}

function safeText(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  document.body.classList.add("no-scroll");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
  document.body.classList.remove("no-scroll");
}

function setLoadFormMsg(msg) {
  const el = document.getElementById("loadFormMsg");
  if (el) el.textContent = msg || "";
}

function loadFormGetPayload() {
  const get = (id) => (document.getElementById(id)?.value || "").trim();
  const num = (id) => {
    const v = (document.getElementById(id)?.value || "").trim();
    return v === "" ? null : Number(v);
  };

  return {
    load_number: get("load_number") || null,
    status: get("status") || "NEW",
    shipper_name: get("shipper_name") || null,
    pickup_city: get("pickup_city") || null,
    pickup_state: (get("pickup_state") || null),
    delivery_city: get("delivery_city") || null,
    delivery_state: (get("delivery_state") || null),
    pickup_date: get("pickup_date") || null,
    delivery_date: get("delivery_date") || null,
    rate_total: num("rate_total"),
  };
}

function loadFormFill(load) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v ?? ""); };
  set("loadId", load?.id || "");
  set("load_number", load?.load_number || "");
  set("status", (load?.status || "NEW").toUpperCase());
  set("shipper_name", load?.shipper_name || "");
  set("pickup_city", load?.pickup_city || "");
  set("pickup_state", (load?.pickup_state || ""));
  set("delivery_city", load?.delivery_city || "");
  set("delivery_state", (load?.delivery_state || ""));
  set("pickup_date", load?.pickup_date ? String(load.pickup_date).slice(0,10) : "");
  set("delivery_date", load?.delivery_date ? String(load.delivery_date).slice(0,10) : "");
  set("rate_total", load?.rate_total ?? "");
}

function openLoadModal(load=null) {
  const title = document.getElementById("loadModalTitle");
  if (title) title.textContent = load?.id ? "Edit Load" : "New Load";
  setLoadFormMsg("");
  loadFormFill(load || {});
  openModal("loadModal");
  setTimeout(() => document.getElementById("load_number")?.focus(), 50);
}

function normalizeLoadStatus(v) {
  const s = String(v || "")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
  return s;
}

function statusLabel(v) {
  const s = normalizeLoadStatus(v);
  if (!s) return "—";
  return s.split("_").filter(Boolean).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

function getLoadField(l, key, fallbackKeys = []) {
  if (!l) return null;
  if (l[key] !== undefined && l[key] !== null && l[key] !== "") return l[key];
  const d = (l.data && typeof l.data === "object") ? l.data : null;
  if (d && d[key] !== undefined && d[key] !== null && d[key] !== "") return d[key];
  for (const k of fallbackKeys) {
    if (l[k] !== undefined && l[k] !== null && l[k] !== "") return l[k];
    if (d && d[k] !== undefined && d[k] !== null && d[k] !== "") return d[k];
  }
  return null;
}

function fmtShortDateTime(v) {
  if (!v) return "—";
  const raw = String(v);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hasTime = /T|:/.test(raw);
  if (!hasTime) return `${mm}/${dd}`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function moneyFromMaybeCents(val, treatAsCents) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return treatAsCents ? (n / 100) : n;
}

function deriveLoadDisplay(l) {
  const loadNumber =
    getLoadField(l, "load_number", ["reference", "id"]) ||
    "—";

  const statusRaw = getLoadField(l, "status", ["load_status"]) || "NEW";
  const statusNorm = normalizeLoadStatus(statusRaw);
  const statusText = statusLabel(statusRaw);

  const customer =
    getLoadField(l, "shipper_name", ["shipper", "customer", "customer_name"]) ||
    "—";

  const carrier =
    getLoadField(l, "carrier_name", ["carrier", "carrier_mc", "carrier_name"]) ||
    "—";

  const puCity = getLoadField(l, "pickup_city", ["origin_city"]);
  const puState = getLoadField(l, "pickup_state", ["origin_state"]);
  const delCity = getLoadField(l, "delivery_city", ["destination_city"]);
  const delState = getLoadField(l, "delivery_state", ["destination_state"]);

  const origin = getLoadField(l, "origin");
  const destination = getLoadField(l, "destination");

  const lane =
    (puCity || puState || delCity || delState)
      ? [
          [puCity, puState].filter(Boolean).join(", "),
          [delCity, delState].filter(Boolean).join(", "),
        ].filter(Boolean).join(" → ")
      : ([origin, destination].filter(Boolean).join(" → ") || "—");

  const pickup = fmtShortDateTime(getLoadField(l, "pickup_date", ["pickup_at", "pickup_datetime"]));
  const delivery = fmtShortDateTime(getLoadField(l, "delivery_date", ["delivery_at", "delivery_datetime"]));

  const revCents = getLoadField(l, "revenue_cents", ["rate_cents"]);
  const costCents = getLoadField(l, "cost_cents", []);
  const marginCents = getLoadField(l, "margin_cents", []);

  const rateTotal = getLoadField(l, "rate_total", ["rate", "revenue"]);

  const revenue = revCents != null ? moneyFromMaybeCents(revCents, true) : moneyFromMaybeCents(rateTotal, false);
  const cost = costCents != null ? moneyFromMaybeCents(costCents, true) : null;
  const margin = marginCents != null ? moneyFromMaybeCents(marginCents, true) : ((revenue != null && cost != null) ? (revenue - cost) : null);

  const revenueText = revenue == null ? "—" : fmtMoney(revenue);
  const costText = cost == null ? "—" : fmtMoney(cost);
  const marginText = margin == null ? "—" : fmtMoney(margin);

  return {
    loadNumber,
    statusNorm,
    statusText,
    customer,
    carrier,
    lane,
    pickup,
    delivery,
    revenue,
    cost,
    margin,
    revenueText,
    costText,
    marginText,
  };
}

function renderLoads(loads) {
  const tbody = document.getElementById("loadsTbody");
  if (!tbody) return;

  loadsState.cache.clear();
  tbody.innerHTML = "";

  if (!loads || loads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="padding:14px; opacity:.8;">No loads found.</td></tr>`;
    return;
  }

  for (const l of loads) {
    const d = deriveLoadDisplay(l);

    // Cache by both DB id and load number for compatibility with existing click handlers.
    if (l && l.id) loadsState.cache.set(String(l.id), l);
    loadsState.cache.set(String(d.loadNumber), l);

    const tr = document.createElement("tr");
    tr.dataset.loadId = String(d.loadNumber);

    const marginClass =
      (typeof d.margin === "number" && Number.isFinite(d.margin))
        ? (d.margin < 0 ? "money neg" : "money pos")
        : "";

    tr.innerHTML = `
      <td><input class="loadChk" type="checkbox" /></td>
      <td class="mono"><a href="#" class="openLoadLink">${safeText(d.loadNumber)}</a></td>
      <td><span class="${statusPillClass(d.statusNorm)}">${safeText(d.statusText)}</span></td>
      <td>${safeText(d.customer)}</td>
      <td>${safeText(d.carrier)}</td>
      <td>${safeText(d.lane)}</td>
      <td class="mono">${safeText(d.pickup)}</td>
      <td class="mono">${safeText(d.delivery)}</td>
      <td class="mono">${safeText(d.revenueText)}</td>
      <td class="mono">${safeText(d.costText)}</td>
      <td class="mono ${marginClass}">${safeText(d.marginText)}</td>
      <td><button class="btn btn-secondary openLoadBtn" type="button">Open</button></td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadLoads({ force=false } = {}) {
  // If a refresh is requested while a fetch is in flight, queue one and await the current run.
  if (loadsState.loading) {
    if (force) loadsState.queuedForce = true;
    return loadsState.inflight || Promise.resolve();
  }
  if (loadsState.loaded && !force) return;

  const qRaw = (document.getElementById("loadSearch")?.value || "").trim().toLowerCase();
  const statusSel = (document.getElementById("loadStatusFilter")?.value || "").trim();

  loadsState.loading = true;

  const run = (async () => {
    const data = await apiJson(`/api/broker/loads`);
    let loads = data.loads || [];

    // Client-side filters to match the UI (server-side search is schema-dependent).
    if (statusSel) {
      const want = normalizeLoadStatus(statusSel);
      loads = loads.filter((l) => normalizeLoadStatus(getLoadField(l, "status") || "NEW") === want);
    }

    if (qRaw) {
      loads = loads.filter((l) => {
        const d = deriveLoadDisplay(l);
        const hay = [
          d.loadNumber,
          d.customer,
          d.carrier,
          d.lane,
          d.statusText,
        ].join(" ").toLowerCase();
        return hay.includes(qRaw);
      });
    }

    renderLoads(loads);
    loadsState.loaded = true;
  })();

  loadsState.inflight = run;

  try {
    await run;
  } catch (e) {
    console.error(e);
    renderLoads([]);
    if (e.status === 401) {
      try { openAccountModal?.(); } catch(_) {}
    } else {
      alert(`Loads error: ${e.message}`);
    }
  } finally {
    loadsState.loading = false;
    loadsState.inflight = null;

    if (loadsState.queuedForce) {
      loadsState.queuedForce = false;
      // Run one forced refresh after the inflight request resolves.
      return loadLoads({ force: true });
    }
  }
}

async function saveLoadFromModal(ev) {
  ev?.preventDefault?.();
  const btn = document.getElementById("loadSaveBtn");
  if (btn) btn.disabled = true;
  setLoadFormMsg("Saving…");

  const id = (document.getElementById("loadId")?.value || "").trim();
  const payload = loadFormGetPayload();

  if (payload.pickup_state) payload.pickup_state = payload.pickup_state.toUpperCase().slice(0,2);
  if (payload.delivery_state) payload.delivery_state = payload.delivery_state.toUpperCase().slice(0,2);

  try {
    if (!payload.load_number) {
      payload.load_number = `L-${String(Date.now()).slice(-6)}`;
    }

    if (id) {
      await apiJson(`/api/broker/loads/${encodeURIComponent(id)}`, { method: "PUT", body: payload });
    } else {
      await apiJson(`/api/broker/loads`, { method: "POST", body: payload });
    }
    setLoadFormMsg("Saved.");
    closeModal("loadModal");
    await loadLoads({ force: true });
  } catch (e) {
    console.error(e);
    setLoadFormMsg(e.message || "Save failed.");
    if (e.status === 401) {
      try { openAccountModal?.(); } catch(_) {}
    } else {
      alert(`Save error: ${e.message}`);
    }
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setLoadFormMsg(""), 1500);
  }
}

// Wire up modal close controls
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const close = t.getAttribute("data-close");
  if (close === "loadModal") closeModal("loadModal");
});

// Wire up Loads tab behaviors
document.addEventListener("DOMContentLoaded", () => {
  const newBtn = document.getElementById("newLoadBtn");
  if (newBtn) newBtn.addEventListener("click", () => openLoadModal(null));

  const form = document.getElementById("loadForm");
  if (form) form.addEventListener("submit", saveLoadFromModal);

  const tbody = document.getElementById("loadsTbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
      const tr = ev.target?.closest?.("tr");
      const id = tr?.dataset?.loadId;
      if (!id) return;
      const load = loadsState.cache.get(id);
      openLoadModal(load || null);
    });
  }

  const search = document.getElementById("loadSearch");
  const status = document.getElementById("loadStatusFilter");
  let tmr = null;
  const schedule = () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => loadLoads({ force: true }), 250);
  };
  if (search) search.addEventListener("input", schedule);
  if (status) status.addEventListener("change", schedule);

  document.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("[data-broker-tab]");
    const tab = btn?.getAttribute?.("data-broker-tab");
    if (tab === "loads") loadLoads({ force: true });
  });

  const active = document.querySelector('.tabs button.active[data-broker-tab="loads"]');
  if (active) loadLoads({ force: true });
});





// -------------------- Broker TMS UI wiring: Carriers / Shippers / Documents / Tasks / Driver Status --------------------
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const STORE_KEY = "pdfrealm_broker_ui_store_v1";

  function uid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now();
  }

  function safeVal(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }
  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v ?? "";
  }

  async function requireAuthOrPrompt() {
    try {
      const me = await apiJson("/api/broker/me");
      if (me?.ok) return me;
    } catch (e) {}
    try { window.openAccountModal?.(); } catch {}
    throw new Error("Not authenticated");
  }

  async function getSettingsData() {
    try {
      const r = await apiJson("/api/broker/settings");
      const row = r?.settings || {};
      // prefer json column variants
      const data = row.data || row.settings || row.config || row.json || row.payload || {};
      return { row, data: (data && typeof data === "object") ? data : {} };
    } catch {
      return { row: {}, data: {} };
    }
  }

  async function patchSettingsData(patch) {
    const cur = await getSettingsData();
    const next = { ...(cur.data || {}), ...(patch || {}) };
    await apiJson("/api/broker/settings", { method: "POST", body: { data: next } });
    return next;
  }

  // -------------------- Carriers --------------------
  async function refreshCarriers() {
    const tbody = document.getElementById("carriersTbody");
    if (!tbody) return;

    try {
      await requireAuthOrPrompt();
      const r = await apiJson("/api/broker/carriers");
      const carriers = Array.isArray(r?.carriers) ? r.carriers : [];

      tbody.innerHTML = carriers.map((c) => {
        const name = escapeHtml(c.name || "—");
        const mc = escapeHtml(c.mc || c.mc_number || "—");
        const email = escapeHtml(c.email || "—");
        const phone = escapeHtml(c.phone || "—");
        const notes = escapeHtml(c.notes || "");
        return `<tr data-id="${escapeAttr(c.id || "")}">
          <td><strong>${name}</strong><div class="muted">MC: ${mc}</div></td>
          <td>${email}</td>
          <td>${phone}</td>
          <td class="muted">${notes}</td>
        </tr>`;
      }).join("");

      // row select -> fill form
      tbody.onclick = (ev) => {
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const id = tr.getAttribute("data-id") || "";
        const carrier = carriers.find((x) => String(x.id) === String(id));
        if (!carrier) return;
        tbody.querySelectorAll("tr").forEach(r => r.classList.remove("row-active"));
        tr.classList.add("row-active");
        setVal("carrierMc", carrier.mc || carrier.mc_number || "");
        setVal("carrierName", carrier.name || "");
        setVal("carrierEmail", carrier.email || "");
        setVal("carrierPhone", carrier.phone || "");
        setVal("carrierNotes", carrier.notes || "");
        tbody.setAttribute("data-selected-id", carrier.id || "");
      };
    } catch (e) {
      // leave sample UI if unauth
    }
  }

  function readCarrierForm() {
    return {
      id: undefined,
      mc: safeVal("carrierMc"),
      name: safeVal("carrierName"),
      email: safeVal("carrierEmail"),
      phone: safeVal("carrierPhone"),
      notes: safeVal("carrierNotes"),
    };
  }
  function clearCarrierForm() {
    ["carrierMc","carrierName","carrierEmail","carrierPhone","carrierNotes"].forEach(id => setVal(id,""));
    const tbody = document.getElementById("carriersTbody");
    if (tbody) tbody.removeAttribute("data-selected-id");
  }

  async function saveCarrier() {
    await requireAuthOrPrompt();
    const tbody = document.getElementById("carriersTbody");
    const selectedId = tbody?.getAttribute("data-selected-id") || "";
    const payload = readCarrierForm();
    if (!payload.name && !payload.mc) return alert("Enter at least Carrier Name or MC.");
    payload.id = selectedId || uid();
    await apiJson("/api/broker/carriers", { method: "POST", body: { carrier: payload } });
    clearCarrierForm();
    await refreshCarriers();
  }

  async function deleteSelectedCarrier() {
    await requireAuthOrPrompt();
    const tbody = document.getElementById("carriersTbody");
    const selectedId = tbody?.getAttribute("data-selected-id") || "";
    if (!selectedId) return alert("Select a carrier row first.");
    if (!confirm("Delete this carrier?")) return;
    await apiJson(`/api/broker/carriers/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
    clearCarrierForm();
    await refreshCarriers();
  }

  // -------------------- Shippers --------------------
  async function refreshShippers() {
    const tbody = document.getElementById("shippersTbody");
    if (!tbody) return;

    try {
      await requireAuthOrPrompt();
      const r = await apiJson("/api/broker/shippers");
      const shippers = Array.isArray(r?.shippers) ? r.shippers : [];

      tbody.innerHTML = shippers.map((s) => {
        const name = escapeHtml(s.name || "—");
        const email = escapeHtml(s.email || "—");
        const phone = escapeHtml(s.phone || "—");
        const addr = escapeHtml(s.address || "—");
        const notes = escapeHtml(s.notes || "");
        return `<tr data-id="${escapeAttr(s.id || "")}">
          <td><strong>${name}</strong><div class="muted">${addr}</div></td>
          <td>${email}</td>
          <td>${phone}</td>
          <td class="muted">${notes}</td>
        </tr>`;
      }).join("");

      tbody.onclick = (ev) => {
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const id = tr.getAttribute("data-id") || "";
        const shipper = shippers.find((x) => String(x.id) === String(id));
        if (!shipper) return;
        tbody.querySelectorAll("tr").forEach(r => r.classList.remove("row-active"));
        tr.classList.add("row-active");
        setVal("shipperName", shipper.name || "");
        setVal("shipperEmail", shipper.email || "");
        setVal("shipperPhone", shipper.phone || "");
        setVal("shipperAddr", shipper.address || "");
        setVal("shipperNotes", shipper.notes || "");
        tbody.setAttribute("data-selected-id", shipper.id || "");
      };
    } catch {}
  }

  function readShipperForm() {
    return {
      id: undefined,
      name: safeVal("shipperName"),
      email: safeVal("shipperEmail"),
      phone: safeVal("shipperPhone"),
      address: safeVal("shipperAddr"),
      notes: safeVal("shipperNotes"),
    };
  }
  function clearShipperForm() {
    ["shipperName","shipperEmail","shipperPhone","shipperAddr","shipperNotes"].forEach(id => setVal(id,""));
    const tbody = document.getElementById("shippersTbody");
    if (tbody) tbody.removeAttribute("data-selected-id");
  }

  async function saveShipper() {
    await requireAuthOrPrompt();
    const tbody = document.getElementById("shippersTbody");
    const selectedId = tbody?.getAttribute("data-selected-id") || "";
    const payload = readShipperForm();
    if (!payload.name) return alert("Enter Shipper Name.");
    payload.id = selectedId || uid();
    await apiJson("/api/broker/shippers", { method: "POST", body: { shipper: payload } });
    clearShipperForm();
    await refreshShippers();
  }

  async function deleteSelectedShipper() {
    await requireAuthOrPrompt();
    const tbody = document.getElementById("shippersTbody");
    const selectedId = tbody?.getAttribute("data-selected-id") || "";
    if (!selectedId) return alert("Select a shipper row first.");
    if (!confirm("Delete this shipper?")) return;
    await apiJson(`/api/broker/shippers/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
    clearShipperForm();
    await refreshShippers();
  }

  // -------------------- Driver Status (stored in broker_settings.data) --------------------
  async function refreshDrivers() {
    const tbody = document.getElementById("driversTbody");
    if (!tbody) return;

    try {
      await requireAuthOrPrompt();
      const { data } = await getSettingsData();
      const list = Array.isArray(data.driver_statuses) ? data.driver_statuses : [];

      tbody.innerHTML = list.map((d) => {
        const name = escapeHtml(d.driver || "—");
        const truck = escapeHtml(d.truck || "—");
        const onLoad = escapeHtml(d.onLoad || "—");
        const status = escapeHtml(d.status || "—");
        const ping = escapeHtml(d.updatedAt || d.updated_at || "—");
        return `<tr data-id="${escapeAttr(d.id || "")}">
          <td><strong>${name}</strong></td>
          <td>${truck}</td>
          <td>${onLoad}</td>
          <td><span class="tag">${status}</span></td>
          <td class="muted">${ping}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="5" class="muted">No driver status updates yet.</td></tr>`;
    } catch {}
  }

  async function updateDriverStatus() {
    await requireAuthOrPrompt();
    const driver = safeVal("driverName");
    const location = safeVal("driverLocation");
    const status = safeVal("driverStatus");
    if (!driver) return alert("Enter Driver Name.");
    const now = new Date().toISOString();
    const { data } = await getSettingsData();
    const list = Array.isArray(data.driver_statuses) ? data.driver_statuses : [];
    const existing = list.find((x) => (x.driver || "").toLowerCase() === driver.toLowerCase());
    if (existing) {
      existing.location = location;
      existing.status = status || existing.status;
      existing.updatedAt = now;
    } else {
      list.unshift({ id: uid(), driver, location, status: status || "Unknown", updatedAt: now, truck: "", onLoad: "" });
    }
    await patchSettingsData({ driver_statuses: list });

    // also log a task for auditability
    try {
      await apiJson("/api/broker/tasks", { method: "POST", body: { task: { title: `Driver update: ${driver} — ${status || "Unknown"}`, status: "OPEN", data: { driver, location, status } } } });
    } catch {}

    await refreshDrivers();
  }

  // -------------------- Workflow Tasks (broker_tasks) --------------------
  async function refreshTasks() {
    const tbody = document.getElementById("tasksTbody");
    if (!tbody) return;

    try {
      await requireAuthOrPrompt();
      const r = await apiJson("/api/broker/tasks");
      const tasks = Array.isArray(r?.tasks) ? r.tasks : [];

      tbody.innerHTML = tasks.map((t) => {
        const id = escapeAttr(t.id || "");
        const title = escapeHtml(t.title || t.name || "—");
        const due = escapeHtml(t.due_at || t.dueAt || "—");
        const assignee = escapeHtml(t.assignee || t.owner || "—");
        const status = escapeHtml(t.status || "OPEN");
        return `<tr data-id="${id}">
          <td><strong>${title}</strong></td>
          <td class="muted">${due}</td>
          <td class="muted">${assignee}</td>
          <td><span class="tag">${status}</span></td>
        </tr>`;
      }).join("") || `<tr><td colspan="4" class="muted">No tasks yet.</td></tr>`;

      // click to toggle status
      tbody.onclick = async (ev) => {
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const id = tr.getAttribute("data-id");
        const task = tasks.find(x => String(x.id) === String(id));
        if (!task) return;
        const next = (String(task.status || "OPEN").toUpperCase() === "DONE") ? "OPEN" : "DONE";
        await apiJson(`/api/broker/tasks/${encodeURIComponent(id)}`, { method: "PUT", body: { task: { status: next } } });
        await refreshTasks();
      };
    } catch {}
  }

  // -------------------- Documents (Vault + broker_docs) --------------------
  let _docsFileInput = null;

  function ensureDocsFileInput() {
    if (_docsFileInput) return _docsFileInput;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    _docsFileInput = input;
    return input;
  }

  async function uploadFilesToVault(files, loadId = null) {
    await requireAuthOrPrompt();
    const results = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder_id", "");
      const up = await fetch("/api/vault/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${window.getToken?.() || localStorage.getItem("pdfrealm_token") || ""}` },
        body: fd,
      });
      const j = await up.json().catch(() => ({}));
      if (!up.ok || !j.ok) throw new Error(j.error || "Upload failed");
      results.push({ file, vault: j });
      // link to broker_docs (best-effort)
      try {
        await apiJson("/api/broker/docs", {
          method: "POST",
          body: {
            doc: {
              title: file.name,
              doc_type: "UPLOAD",
              load_id: loadId,
              vault_key: j.key,
              vault_object_id: j.object?.id || null,
              data: { size: file.size, type: file.type },
            },
          },
        });
      } catch {}
    }
    return results;
  }

  async function refreshDocs() {
    const dz = document.getElementById("docsDropzone");
    if (!dz) return;
    try {
      await requireAuthOrPrompt();
      const r = await apiJson("/api/broker/docs");
      const docs = Array.isArray(r?.docs) ? r.docs : [];
      const list = docs.slice(0, 50).map((d) => {
        const title = escapeHtml(d.title || "Document");
        const type = escapeHtml(d.doc_type || "—");
        const id = escapeAttr(d.id || "");
        return `<div class="doc-pill" data-id="${id}">
          <strong>${title}</strong>
          <span class="muted" style="margin-left:8px;">${type}</span>
          <button class="btn btn-secondary btn-xs" data-doc-del="${id}" style="margin-left:10px;">Delete</button>
        </div>`;
      }).join("");
      dz.innerHTML = list || `<div class="muted">Drop documents here or click Upload.</div>`;

      dz.onclick = async (ev) => {
        const del = ev.target.closest("[data-doc-del]");
        if (!del) return;
        const id = del.getAttribute("data-doc-del");
        if (!id) return;
        if (!confirm("Delete this document metadata entry? (Vault object delete is separate)")) return;
        await apiJson(`/api/broker/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
        await refreshDocs();
      };
    } catch {}
  }

  function wireDocsUploadButtons() {
    const docView = document.querySelector('[data-broker-view="documents"]');
    if (!docView) return;

    const input = ensureDocsFileInput();

    // Header upload button and any "Upload" buttons inside documents view
    const uploadBtns = $$('button', docView).filter(b => (b.textContent || "").trim().toLowerCase().startsWith("upload"));
    uploadBtns.forEach((btn) => {
      btn.addEventListener("click", () => input.click());
    });

    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      input.value = "";
      try {
        await uploadFilesToVault(files, null);
        await refreshDocs();
        alert(`Uploaded ${files.length} file(s).`);
      } catch (e) {
        alert(String(e?.message || e));
      }
    });

    // Dropzone
    const dz = document.getElementById("docsDropzone");
    if (dz) {
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drop-active"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("drop-active"));
      dz.addEventListener("drop", async (e) => {
        e.preventDefault();
        dz.classList.remove("drop-active");
        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length) return;
        try {
          await uploadFilesToVault(files, null);
          await refreshDocs();
          alert(`Uploaded ${files.length} file(s).`);
        } catch (err) {
          alert(String(err?.message || err));
        }
      });
    }
  }

  // -------------------- Load Drawer Note Save --------------------
  async function wireDrawerNotes() {
    const btn = document.getElementById("drawerSaveNoteBtn");
    const ta = document.getElementById("drawerNoteText");
    if (!btn || !ta) return;

    btn.addEventListener("click", async () => {
      const text = String(ta.value || "").trim();
      const drawer = document.getElementById("loadDrawer");
      const loadId = drawer?.getAttribute("data-load-id") || "";
      if (!loadId) return alert("Open a load first.");
      if (!text) return alert("Enter a note.");
      try {
        await requireAuthOrPrompt();
        await apiJson(`/api/broker/loads/${encodeURIComponent(loadId)}/notes`, { method: "POST", body: { note: text } });
        ta.value = "";
        alert("Note saved.");
      } catch (e) {
        alert(String(e?.message || e));
      }
    });
  }

  // -------------------- EDI Tender accept/decline wiring --------------------
  function wireEdiButtons() {
    const ediView = document.querySelector('[data-broker-view="edi"]');
    if (!ediView) return;

    ediView.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const txt = (btn.textContent || "").trim().toLowerCase();
      if (!txt.includes("accept") && !txt.includes("decline")) return;
      const tr = btn.closest("tr");
      if (!tr) return;
      const tds = Array.from(tr.querySelectorAll("td")).map(td => (td.textContent || "").trim());
      const ref = tds[0] || "TENDER";
      const lane = tds[1] || "";
      const equip = tds[2] || "";
      const rpm = tds[3] || "";
      const pickup = tds[4] || "";
      const delivery = tds[5] || "";

      try {
        await requireAuthOrPrompt();
        if (txt.includes("accept")) {
          const load = {
            reference: ref,
            status: "TENDER_ACCEPTED",
            lane,
            equipment: equip,
            pickup_window: pickup,
            delivery_window: delivery,
            rate: rpm,
          };
          await apiJson("/api/broker/loads", { method: "POST", body: load });
          await apiJson("/api/broker/tasks", { method: "POST", body: { task: { title: `Tender accepted: ${ref}`, status: "OPEN", data: load } } });
          alert("Tender accepted and load created.");
        } else {
          await apiJson("/api/broker/tasks", { method: "POST", body: { task: { title: `Tender declined: ${ref}`, status: "OPEN", data: { ref, lane, equip } } } });
          alert("Tender declined (task logged).");
        }
      } catch (e) {
        alert(String(e?.message || e));
      }
    });
  }

  // -------------------- HTML escaping helpers --------------------
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll("`", "&#096;");
  }

  function initWiring() {
    // Buttons
    const cs = document.getElementById("carrierSaveBtn");
    const cc = document.getElementById("carrierClearBtn");
    const ss = document.getElementById("shipperSaveBtn");
    const sc = document.getElementById("shipperClearBtn");
    const du = document.getElementById("driverUpdateBtn");

    if (cs) cs.addEventListener("click", () => saveCarrier().catch(e => alert(String(e?.message || e))));
    if (cc) cc.addEventListener("click", () => clearCarrierForm());
    if (ss) ss.addEventListener("click", () => saveShipper().catch(e => alert(String(e?.message || e))));
    if (sc) sc.addEventListener("click", () => clearShipperForm());
    if (du) du.addEventListener("click", () => updateDriverStatus().catch(e => alert(String(e?.message || e))));

    // Add simple delete on Delete key within carriers/shippers tables
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Delete") return;
      const carriersView = document.querySelector('[data-broker-view="carriers"].broker-view-active');
      const shippersView = document.querySelector('[data-broker-view="shippers"].broker-view-active');
      if (carriersView) deleteSelectedCarrier().catch(() => {});
      if (shippersView) deleteSelectedShipper().catch(() => {});
    });

    wireDocsUploadButtons();
    wireEdiButtons();
    wireDrawerNotes();

    // Refresh on tab switch: hook into tab clicks
    $$('.broker-nav button[data-broker-tab]').forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-broker-tab");
        if (tab === "carriers") refreshCarriers();
        if (tab === "shippers") refreshShippers();
        if (tab === "documents") refreshDocs();
        if (tab === "workflow") refreshTasks();
        if (tab === "drivers") refreshDrivers();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initWiring();
    // Ensure loads are pulled from the API on every refresh (no demo HTML rows).
    try { loadsState.loaded = false; } catch(_) {}
    try { loadLoads({ force: true }); } catch(_) {}
    // initial best-effort preloads
    refreshCarriers();
    refreshShippers();
    refreshDocs();
    refreshTasks();
    refreshDrivers();
  });
})();
