// public/chat_vault.js
// PDFRealm Secure Chat (Vault tab) — E2EE messages + encrypted attachments + optional password-wrapped room key.
// No external services (invites are manual links), and does not change other Vault features.

(() => {
  if (window.__PDFREALM_CHAT_VAULT__) return;
  window.__PDFREALM_CHAT_VAULT__ = true;

  // ---- DOM
  const $ = (id) => document.getElementById(id);

  const elThreads = $("chatThreads");
  const elNewThreadBtn = $("chatNewThreadBtn");

  const elActiveTitle = $("chatActiveTitle");
  const elActiveMeta = $("chatActiveMeta");
  const elParticipants = $("chatParticipants");
  const elParticipantsList = $("chatParticipantsList");
  const elParticipantsCount = $("chatParticipantsCount");
  const elMessages = $("chatMessages");
  const elCompose = $("chatCompose");
  const elSendBtn = $("chatSendBtn");
  const elRefreshBtn = $("chatRefreshBtn");

  const elInviteBtn = $("chatInviteBtn");
  const elRoomKeyBtn = $("chatRoomKeyBtn");
  const elPasswordBtn = $("chatPasswordBtn");
  const elRemoveBtn = $("chatRemoveBtn");
  const elCopyInviteBtn = $("chatCopyInviteBtn");
  const elCopyKeyBtn = $("chatCopyKeyBtn");
  const elInviteOut = $("chatInviteOut");
  const elRoomKeyOut = $("chatRoomKeyOut");
  const elInviteStatus = $("chatInviteStatus");

  const elJoinInvite = $("chatJoinInvite");
  const elJoinRoomKey = $("chatJoinRoomKey");
  const elJoinPassword = $("chatJoinPassword");
  const elJoinBtn = $("chatJoinBtn");
  const elJoinClearBtn = $("chatJoinClearBtn");
  const elJoinStatus = $("chatJoinStatus");

  const elAttachBtn = $("chatAttachBtn");
  const elAttachFile = $("chatAttachFile");

  // ---- State
  const LS_ACTIVE = "pdfrealm_active_chat_thread";
  const LS_KEY_PREFIX = "pdfrealm_chat_roomkey_";

  const state = {
    authed: false,
    threads: [],
    activeThreadId: null,
    pollTimer: null,
    pollInFlight: false,
    activeTitle: "",
    participantsTick: 0,
  };

  // ---- Utils
  function norm(s){ return String(s||"").trim(); }

async function touchPresence() {
  if (!state.activeThreadId) return;
  try { await api(`/api/chat/threads/${encodeURIComponent(state.activeThreadId)}/presence`, { method: "POST", body: {} }); } catch (_) {}
}

async function refreshParticipants({ silent = false } = {}) {
  if (!state.activeThreadId) return;
  if (!elParticipants) return;
  try {
    const data = await api(`/api/chat/threads/${encodeURIComponent(state.activeThreadId)}/participants?window_sec=90`);
    const list = (data && data.participants) ? data.participants : [];
    const names = list.map(p => (p.actor_name || p.actor_kind)).filter(Boolean);
    const shown = names.slice(0, 6).join(", ");
    const more = names.length > 6 ? ` +${names.length - 6} more` : "";
    if (elParticipantsCount) elParticipantsCount.textContent = String(names.length || 0);
    if (elParticipantsList) {
      elParticipantsList.innerHTML = "";
      if (!names.length) {
        elParticipantsList.textContent = "—";
      } else {
        const max = 12;
        names.slice(0, max).forEach((n) => {
          const chip = document.createElement("span");
          chip.textContent = n;
          chip.style.cssText = "padding:2px 8px; border-radius:999px; background:rgba(255,255,255,0.06); color:var(--text); font-size:0.78rem; font-weight:700;";
          elParticipantsList.appendChild(chip);
        });
        if (names.length > max) {
          const moreChip = document.createElement("span");
          moreChip.textContent = `+${names.length - max} more`;
          moreChip.style.cssText = "padding:2px 8px; border-radius:999px; background:rgba(255,255,255,0.04); color:var(--muted); font-size:0.78rem; font-weight:700;";
          elParticipantsList.appendChild(moreChip);
        }
      }
    } else if (elParticipants) {
      elParticipants.textContent = `Online: ${names.length ? (shown + more) : "—"}`;
    }
  } catch (e) {
    if (elParticipantsCount) elParticipantsCount.textContent = "0";
    if (elParticipantsList) elParticipantsList.textContent = "—";
    else if (!silent && elParticipants) elParticipants.textContent = "Online: —";
  }
}


  function getCookie(name) {
    const c = document.cookie || "";
    const m = c.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function getToken() {
    return localStorage.getItem("pdfrealm_token") || getCookie("pdfrealm_token") || "";
  }

  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const tok = getToken();
    if (tok) headers.set("Authorization", "Bearer " + tok);
    if (!headers.has("Content-Type") && opts.body && !(opts.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    const resp = await fetch(path, { method: opts.method || "GET", headers, body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined, credentials: "same-origin" });
    const txt = await resp.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
    if (!resp.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : ("HTTP " + resp.status);
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || "";
    el.classList.remove("ok", "error");
    if (kind === "ok") el.classList.add("ok");
    if (kind === "error") el.classList.add("error");
  }

  function setInviteStatus(msg, kind){ setStatus(elInviteStatus, msg, kind); }
  function setJoinStatus(msg, kind){ setStatus(elJoinStatus, msg, kind); }

  async function copyText(text) {
    const t = String(text || "");
    if (!t) return false;
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  // ---- Base64 helpers (standard base64; compatible with chat.html)
  function b64FromBytes(bytes){
    let bin = "";
    for (let i=0; i<bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesFromB64(b64){
    const bin = atob((b64||"").trim());
    const out = new Uint8Array(bin.length);
    for (let i=0; i<bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function aesKeyFromB64(keyB64){
    const raw = bytesFromB64(keyB64);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt","decrypt"]);
  }

  async function encryptText(keyB64, plaintext){
    const key = await aesKeyFromB64(keyB64);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(String(plaintext||""));
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, pt);
    return { nonceB64: b64FromBytes(nonce), ciphertextB64: b64FromBytes(new Uint8Array(ctBuf)) };
  }

  async function decryptText(keyB64, nonceB64, ciphertextB64){
    const key = await aesKeyFromB64(keyB64);
    const nonce = bytesFromB64(nonceB64);
    const ct = bytesFromB64(ciphertextB64);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
    return new TextDecoder().decode(ptBuf);
  }

  async function encryptBytes(keyB64, plainBytes){
    const key = await aesKeyFromB64(keyB64);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plainBytes);
    return { nonceB64: b64FromBytes(nonce), ciphertextBytes: new Uint8Array(ctBuf) };
  }

  async function decryptBytes(keyB64, nonceB64, ciphertextBytes){
    const key = await aesKeyFromB64(keyB64);
    const nonce = bytesFromB64(nonceB64);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertextBytes);
    return new Uint8Array(ptBuf);
  }

  // ---- Password wrapping of room key (PBKDF2 -> AES-GCM wrap)
  async function deriveWrapKey(password, saltBytes){
    const enc = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey("raw", enc, { name: "PBKDF2" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt","decrypt"]
    );
  }

  async function wrapRoomKeyWithPassword(roomKeyB64, password){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const wrapKey = await deriveWrapKey(password, salt);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const roomRaw = bytesFromB64(roomKeyB64);
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, wrapKey, roomRaw);
    return {
      saltB64: b64FromBytes(salt),
      wrapNonceB64: b64FromBytes(nonce),
      wrapCiphertextB64: b64FromBytes(new Uint8Array(ctBuf)),
    };
  }

  async function unwrapRoomKeyWithPassword(wrap, password){
    const salt = bytesFromB64(wrap.saltB64 || wrap.salt || "");
    const nonce = bytesFromB64(wrap.wrapNonceB64 || wrap.nonceB64 || wrap.nonce || "");
    const ct = bytesFromB64(wrap.wrapCiphertextB64 || wrap.ciphertextB64 || wrap.ciphertext || "");
    const wrapKey = await deriveWrapKey(password, salt);
    const roomRawBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, wrapKey, ct);
    return b64FromBytes(new Uint8Array(roomRawBuf));
  }

  function getStoredRoomKey(threadId){
    if (!threadId) return "";
    return localStorage.getItem(LS_KEY_PREFIX + threadId) || "";
  }
  function setStoredRoomKey(threadId, keyB64){
    if (!threadId) return;
    if (keyB64) localStorage.setItem(LS_KEY_PREFIX + threadId, keyB64);
    else localStorage.removeItem(LS_KEY_PREFIX + threadId);
  }

  function setActiveThread(threadId){
    state.activeThreadId = threadId || null;
    if (threadId) localStorage.setItem(LS_ACTIVE, threadId);
    else localStorage.removeItem(LS_ACTIVE);
  }

  function getActiveThread(){
    return state.activeThreadId || localStorage.getItem(LS_ACTIVE) || "";
  }

  function isChatTabActive(){
    const hash = (location.hash || "").replace("#", "").trim();
    return hash === "chat";
  }

  function syncButtons() {
    const authed = !!getToken();
    state.authed = authed;

    const tid = getActiveThread();
    const hasTid = !!tid;
    const hasKey = !!getStoredRoomKey(tid);

    if (elNewThreadBtn) elNewThreadBtn.disabled = !authed;
    if (elInviteBtn) elInviteBtn.disabled = !(authed && hasTid);
    if (elRoomKeyBtn) elRoomKeyBtn.disabled = !(authed && hasTid);
    if (elPasswordBtn) elPasswordBtn.disabled = !(authed && hasTid);
    if (elRemoveBtn) elRemoveBtn.disabled = !(authed && hasTid);
    if (elCopyInviteBtn) elCopyInviteBtn.disabled = !(authed && hasTid && !!(elInviteOut && elInviteOut.value));
    if (elCopyKeyBtn) elCopyKeyBtn.disabled = !(authed && hasTid && !!(elRoomKeyOut && elRoomKeyOut.value));

    if (elSendBtn) elSendBtn.disabled = !(authed && hasTid && hasKey);
    if (elAttachBtn) elAttachBtn.disabled = !(authed && hasTid && hasKey);
    if (elRefreshBtn) elRefreshBtn.disabled = !(authed && hasTid);
  }

  // ---- UI Rendering
  function renderThreads() {
    const tid = getActiveThread();
    if (!elThreads) return;

    if (!state.authed) {
      elThreads.innerHTML = '<div style="padding:12px; color:var(--muted); font-size:0.9rem;">Log in to load threads.</div>';
      return;
    }

    if (!state.threads.length) {
      elThreads.innerHTML = '<div style="padding:12px; color:var(--muted); font-size:0.9rem;">No rooms yet. Click <b>+ New</b>.</div>';
      return;
    }

    elThreads.innerHTML = state.threads.map(t => {
      const id = String(t.id || t.thread_id || "");
      const title = String(t.title || t.name || "Room");
      const when = t.last_message_at || t.updated_at || t.created_at || "";
      const sub = when ? ("Last activity: " + String(when)) : "";
      const active = id && tid && id === tid;
      return `
        <div class="chat-room ${active ? "chat-room-active" : ""}" data-thread-id="${id}">
          <div class="t">${title.replace(/</g,"&lt;")}</div>
          <div class="s">${sub.replace(/</g,"&lt;")}</div>
        </div>`;
    }).join("");

    // bind click
    Array.from(elThreads.querySelectorAll("[data-thread-id]")).forEach(el => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-thread-id");
        selectThread(id).catch(e => setInviteStatus(e.message || String(e), "error"));
      });
    });
  }

  function renderMessagesPlaceholder(msg){
    if (!elMessages) return;
    elMessages.innerHTML = `<div style="color:var(--muted); font-size:0.92rem;">${String(msg||"")}</div>`;
  }

  function bubble(meta, body, mine){
    const safeMeta = String(meta||"").replace(/</g,"&lt;");
    const safeBody = String(body||"").replace(/</g,"&lt;");
    return `<div class="chat-bubble ${mine ? "me" : ""}"><div class="meta">${safeMeta}</div><div class="body" style="white-space:pre-wrap;">${safeBody}</div></div>`;
  }

  function attachmentBubble(meta, att, mine){
    const fname = String(att.filename || "attachment");
    const aid = String(att.attachment_id || att.id || "");
    const size = att.size ? ` (${Math.round(att.size/1024)} KB)` : "";
    const safeMeta = String(meta||"").replace(/</g,"&lt;");
    return `<div class="chat-bubble ${mine ? "me" : ""}">
      <div class="meta">${safeMeta}</div>
      <div class="body">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <div><b>${fname.replace(/</g,"&lt;")}</b>${size}</div>
          <button class="btn btn-secondary" type="button" data-attachment-id="${aid}">Download</button>
        </div>
      </div>
    </div>`;
  }

  // ---- Core actions
  async function loadThreads() {
    const tok = getToken();
    state.authed = !!tok;
    syncButtons();

    if (!tok) {
      state.threads = [];
      renderThreads();
      return;
    }

    const data = await api("/api/chat/threads", { method: "GET" });
    state.threads = data.threads || data.items || data.rows || [];
    renderThreads();

    const saved = getActiveThread();
    if (saved && state.threads.some(t => String(t.id || t.thread_id) === saved)) {
      await selectThread(saved, { silent: true });
    }
  }

  async function selectThread(threadId, opts = {}) {
    const id = String(threadId || "").trim();
    if (!id) return;

    setActiveThread(id);

    const t = state.threads.find(x => String(x.id || x.thread_id) === id) || {};
    const title = String(t.title || t.name || "Room");
    state.activeTitle = title;

    if (elActiveTitle) elActiveTitle.textContent = title;
    if (elActiveMeta) elActiveMeta.textContent = "Loading…";

    // If we don't have a key yet, prompt for it (members only).
    let keyB64 = getStoredRoomKey(id);
    if (!keyB64) {
      const entered = prompt("Room key for this room (base64). If you created the room, click Room Key to reveal it.\n\nLeave blank to continue without sending messages.");
      if (entered && entered.trim()) {
        keyB64 = entered.trim();
        setStoredRoomKey(id, keyB64);
      }
    }
    syncButtons();
    renderThreads();

    await refreshMessages({ silent: !!opts.silent });
    try { await touchPresence(); } catch (_) {}
    try { await refreshParticipants({ silent: true }); } catch (_) {}
  }

  async function createThread() {
    setInviteStatus("", null);
    const title = (prompt("Room name") || "").trim() || "New Room";

    // Always generate a room key client-side (E2EE)
    const roomRaw = new Uint8Array(32);
    crypto.getRandomValues(roomRaw);
    const roomKeyB64 = b64FromBytes(roomRaw);

    const pw = (prompt("Optional room password (leave blank for none)") || "").trim();
    let payload = { title };
    if (pw) {
      const wrap = await wrapRoomKeyWithPassword(roomKeyB64, pw);
      payload.key_wrap = { salt: wrap.saltB64, nonce: wrap.wrapNonceB64, ciphertext: wrap.wrapCiphertextB64 };
    }

    const created = await api("/api/chat/threads", { method: "POST", body: payload });
    const thread = created.thread || created;
    const tid = String(thread.id || thread.thread_id || "");
    if (!tid) throw new Error("Create succeeded but no thread id returned.");

    setStoredRoomKey(tid, roomKeyB64);
    await loadThreads();
    await selectThread(tid);
    setInviteStatus("Room created.", "ok");
  }

  async function generateInvite() {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    const r = await api(`/api/chat/threads/${encodeURIComponent(tid)}/invites`, { method: "POST", body: { allow_write: true, expires_in_seconds: 60*60*24*7 } });
    const token = r.token || (r.invite && r.invite.token) || "";
    if (!token) throw new Error("Invite created but no token returned.");

    const requiresPassword = !!(r.requires_password || r.requiresPassword);
    const base = `${location.origin}/c/${encodeURIComponent(token)}`;

    let url = base;
    if (!requiresPassword) {
      const keyB64 = getStoredRoomKey(tid);
      if (!keyB64) throw new Error("Room key missing. Click Room Key.");
      url = `${base}#k=${encodeURIComponent(keyB64)}`;
    }

    if (elInviteOut) elInviteOut.value = url;
    syncButtons();
    await copyText(url);
    setInviteStatus(requiresPassword ? "Invite link generated (password required). Copied." : "Invite link generated. Copied.", "ok");
  }

  async function showRoomKey() {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    const key = getStoredRoomKey(tid);
    if (!key) throw new Error("No room key stored. If you created this room earlier, you may need to paste the key.");
    if (elRoomKeyOut) elRoomKeyOut.value = key;
    syncButtons();
    setInviteStatus("Room key revealed.", "ok");
  }

  async function setOrClearPassword() {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    const keyB64 = getStoredRoomKey(tid);
    if (!keyB64) throw new Error("Room key missing. Set the room key first.");

    const pw = (prompt("Set / change room password. Leave blank to remove password protection.") || "").trim();
    if (!pw) {
      await api(`/api/chat/threads/${encodeURIComponent(tid)}/password`, { method: "POST", body: { mode: "clear" } });
      setInviteStatus("Password protection removed.", "ok");
      return;
    }
    const wrap = await wrapRoomKeyWithPassword(keyB64, pw);
    await api(`/api/chat/threads/${encodeURIComponent(tid)}/password`, {
      method: "POST",
      body: { mode: "set", key_wrap: { salt: wrap.saltB64, nonce: wrap.wrapNonceB64, ciphertext: wrap.wrapCiphertextB64 } }
    });
    setInviteStatus("Password protection updated.", "ok");
  }

  async function removeRoom() {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    if (!confirm("Remove this room? Owners delete the room; members are removed from it.")) return;
    await api(`/api/chat/threads/${encodeURIComponent(tid)}`, { method: "DELETE" });
    setActiveThread(null);
    if (elInviteOut) elInviteOut.value = "";
    if (elRoomKeyOut) elRoomKeyOut.value = "";
    renderMessagesPlaceholder("No thread selected.");
    await loadThreads();
    syncButtons();
    setInviteStatus("Removed.", "ok");
  }

  function parseInviteInput(s) {
    const raw = (s || "").trim();
    if (!raw) return { token: "" };
    // accept full URL: /c/<token>
    const m = raw.match(/\/c\/([^\/?#\s]+)/);
    const token = m ? m[1] : raw.replace(/[^A-Za-z0-9_\-]/g, "");
    // Try to pull #k= from the pasted link
    const km = raw.match(/[#&]k=([^&]+)/);
    const key = km ? decodeURIComponent(km[1]) : "";
    return { token, key };
  }

  async function joinViaInvite() {
    setJoinStatus("", null);
    const inv = parseInviteInput(elJoinInvite ? elJoinInvite.value : "");
    if (!inv.token) throw new Error("Paste an invite link or token.");

    // Fetch meta (for password-protected rooms)
    const meta = await api(`/api/chat-invite/${encodeURIComponent(inv.token)}/meta`, { method: "GET" });
    const thread = meta.thread || meta;
    const threadId = String(meta.thread_id || meta.threadId || (thread && thread.id) || "");
    const title = String((thread && (thread.title || thread.name)) || "Room");

    // Determine room key
    let keyB64 = (inv.key || "").trim() || (elJoinRoomKey && elJoinRoomKey.value ? elJoinRoomKey.value.trim() : "");
    if (!keyB64) {
      const requiresPassword = !!(meta.requires_password || meta.requiresPassword || (meta.key_wrap || meta.wrap));
      if (requiresPassword) {
        const pw = (elJoinPassword && elJoinPassword.value ? elJoinPassword.value : "").trim();
        if (!pw) throw new Error("This room is password protected. Enter the password.");
        const wrap = meta.key_wrap || meta.wrap || {};
        keyB64 = await unwrapRoomKeyWithPassword({
          saltB64: wrap.salt || wrap.saltB64,
          wrapNonceB64: wrap.nonce || wrap.wrapNonceB64 || wrap.nonceB64,
          wrapCiphertextB64: wrap.ciphertext || wrap.wrapCiphertextB64 || wrap.ciphertextB64
        }, pw);
      } else {
        throw new Error("Room key missing. Paste the full invite link (with #k=...) or paste the room key.");
      }
    }

    // Accept membership (authed users)
    await api(`/api/chat-invite/${encodeURIComponent(inv.token)}/accept`, { method: "POST" });

    setStoredRoomKey(threadId, keyB64);
    setActiveThread(threadId);

    if (elJoinInvite) elJoinInvite.value = "";
    if (elJoinRoomKey) elJoinRoomKey.value = "";
    if (elJoinPassword) elJoinPassword.value = "";

    await loadThreads();
    await selectThread(threadId);
    setJoinStatus(`Joined: ${title}`, "ok");
  }

  async function refreshMessages(opts = {}) {
    const tid = getActiveThread();
    if (!tid) {
      renderMessagesPlaceholder("No thread selected.");
      if (elActiveMeta) elActiveMeta.textContent = "Create or join a room to begin.";
      return;
    }
    const keyB64 = getStoredRoomKey(tid);
    const data = await api(`/api/chat/threads/${encodeURIComponent(tid)}/messages?limit=200`, { method: "GET" });
    let msgs = data.messages || data.items || data.rows || [];
    // Server may return newest-first; normalize to oldest-first
    msgs = msgs.slice().reverse();

    if (!msgs.length) {
      renderMessagesPlaceholder("No messages yet.");
      if (elActiveMeta) elActiveMeta.textContent = state.activeTitle ? "Ready." : "Ready.";
      return;
    }

    // Decrypt and render
    const parts = [];
    for (const m of msgs) {
      const senderKind = String(m.sender_kind || m.senderKind || "");
      const senderName = String(m.sender_name || m.senderName || m.sender || "User");
      const ts = m.created_at || m.sent_at || m.client_ts || "";
      const mine = senderKind === "user" && String(m.sender_id || "") && false; // we don't know self id here; keep simple
      const meta = senderName + (ts ? (" · " + String(ts)) : "");

      const nonce = m.nonce || m.iv || m.nonce_b64 || m.iv_b64 || "";
      const ct = m.ciphertext || m.ciphertext_b64 || m.body || "";
      if (!keyB64) {
        parts.push(bubble(meta, "[Room key required to decrypt]", mine));
        continue;
      }
      try {
        const pt = await decryptText(keyB64, nonce, ct);
        // attachment messages are JSON
        let att = null;
        try {
          const obj = JSON.parse(pt);
          if (obj && obj.type === "attachment") att = obj;
        } catch {}
        if (att) parts.push(attachmentBubble(meta, att, mine));
        else parts.push(bubble(meta, pt, mine));
      } catch {
        parts.push(bubble(meta, "[Unable to decrypt]", mine));
      }
    }

    elMessages.innerHTML = parts.join("");
    elMessages.scrollTop = elMessages.scrollHeight;

    // Bind attachment downloads
    Array.from(elMessages.querySelectorAll("[data-attachment-id]")).forEach(btn => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        const aid = btn.getAttribute("data-attachment-id");
        downloadAttachment(tid, aid).catch(e => setInviteStatus(e.message || String(e), "error"));
      });
    });

    if (elActiveMeta) elActiveMeta.textContent = "Ready.";
    syncButtons();
  }

  async function sendMessage() {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    const keyB64 = getStoredRoomKey(tid);
    if (!keyB64) throw new Error("Room key missing. Click Room Key or paste the key.");

    const txt = (elCompose && elCompose.value ? elCompose.value : "").trim();
    if (!txt) return;

    elSendBtn.disabled = true;
    try {
      const enc = await encryptText(keyB64, txt);
      await api(`/api/chat/threads/${encodeURIComponent(tid)}/messages`, { method: "POST", body: { nonce: enc.nonceB64, ciphertext: enc.ciphertextB64, nonce_b64: enc.nonceB64, ciphertext_b64: enc.ciphertextB64 } });
      if (elCompose) elCompose.value = "";
      await refreshMessages();
    } finally {
      elSendBtn.disabled = false;
    }
  }

  async function sendAttachment(file) {
    const tid = getActiveThread();
    if (!tid) throw new Error("Select a room first.");
    const keyB64 = getStoredRoomKey(tid);
    if (!keyB64) throw new Error("Room key missing.");

    const buf = await file.arrayBuffer();
    const enc = await encryptBytes(keyB64, new Uint8Array(buf));

    const blob = new Blob([enc.ciphertextBytes], { type: "application/octet-stream" });

    const fd = new FormData();
    fd.append("file", blob, file.name);
    fd.append("filename", file.name);
    fd.append("mime", file.type || "application/octet-stream");
    fd.append("size", String(file.size || 0));
    fd.append("nonce", enc.nonceB64);

    setInviteStatus("Uploading attachment…", null);
    const up = await api(`/api/chat/threads/${encodeURIComponent(tid)}/attachments`, { method: "POST", body: fd });

    const attId = up.attachment_id || (up.attachment && up.attachment.id) || up.id;
    if (!attId) throw new Error("Attachment uploaded but no id returned.");

    // Create an attachment message (encrypted JSON)
    const msgObj = {
      type: "attachment",
      attachment_id: String(attId),
      filename: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size || 0,
      nonce: enc.nonceB64
    };
    const msgEnc = await encryptText(keyB64, JSON.stringify(msgObj));
    await api(`/api/chat/threads/${encodeURIComponent(tid)}/messages`, { method: "POST", body: { nonce: msgEnc.nonceB64, ciphertext: msgEnc.ciphertextB64 } });

    setInviteStatus("Attachment sent.", "ok");
    await refreshMessages();
  }

  async function downloadAttachment(threadId, attachmentId) {
    const keyB64 = getStoredRoomKey(threadId);
    if (!keyB64) throw new Error("Room key missing.");

    // Find nonce/filename by re-decrypting latest messages quickly (cheap, and avoids extra server metadata endpoints)
    const data = await api(`/api/chat/threads/${encodeURIComponent(threadId)}/messages?limit=200`, { method: "GET" });
    const msgs = (data.messages || data.items || data.rows || []).slice().reverse();
    let found = null;
    for (const m of msgs) {
      const nonce = m.nonce || m.iv || "";
      const ct = m.ciphertext || m.body || "";
      try {
        const pt = await decryptText(keyB64, nonce, ct);
        const obj = JSON.parse(pt);
        if (obj && obj.type === "attachment" && String(obj.attachment_id) === String(attachmentId)) {
          found = obj;
          break;
        }
      } catch {}
    }
    if (!found) throw new Error("Attachment metadata not found (cannot decrypt message).");

    const resp = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`, { credentials: "same-origin", headers: (() => {
      const h = new Headers();
      const tok = getToken();
      if (tok) h.set("Authorization", "Bearer " + tok);
      return h;
    })() });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(txt || ("HTTP " + resp.status));
    }
    const ctBytes = new Uint8Array(await resp.arrayBuffer());
    const ptBytes = await decryptBytes(keyB64, found.nonce, ctBytes);
    const outBlob = new Blob([ptBytes], { type: found.mime || "application/octet-stream" });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(outBlob);
    a.download = found.filename || "attachment";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!isChatTabActive()) return;
      if (state.pollInFlight) return;
      state.pollInFlight = true;
      try { await refreshMessages({ silent: true }); } catch {}
      state.participantsTick = (state.participantsTick || 0) + 1;
      if (state.participantsTick % 4 === 0) { try { await refreshParticipants({ silent: true }); } catch {} }
      if (state.participantsTick % 4 === 0) { try { await touchPresence(); } catch {} }
      state.pollInFlight = false;
    }, 2500);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // ---- Bindings
  function bind() {
    if (elNewThreadBtn && !elNewThreadBtn.dataset.bound) {
      elNewThreadBtn.dataset.bound = "1";
      elNewThreadBtn.addEventListener("click", () => createThread().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elInviteBtn && !elInviteBtn.dataset.bound) {
      elInviteBtn.dataset.bound = "1";
      elInviteBtn.addEventListener("click", () => generateInvite().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elRoomKeyBtn && !elRoomKeyBtn.dataset.bound) {
      elRoomKeyBtn.dataset.bound = "1";
      elRoomKeyBtn.addEventListener("click", () => showRoomKey().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elPasswordBtn && !elPasswordBtn.dataset.bound) {
      elPasswordBtn.dataset.bound = "1";
      elPasswordBtn.addEventListener("click", () => setOrClearPassword().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elRemoveBtn && !elRemoveBtn.dataset.bound) {
      elRemoveBtn.dataset.bound = "1";
      elRemoveBtn.addEventListener("click", () => removeRoom().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elCopyInviteBtn && !elCopyInviteBtn.dataset.bound) {
      elCopyInviteBtn.dataset.bound = "1";
      elCopyInviteBtn.addEventListener("click", () => copyText(elInviteOut ? elInviteOut.value : "").then(ok => setInviteStatus(ok ? "Copied." : "Copy failed.", ok ? "ok" : "error")));
    }
    if (elCopyKeyBtn && !elCopyKeyBtn.dataset.bound) {
      elCopyKeyBtn.dataset.bound = "1";
      elCopyKeyBtn.addEventListener("click", () => copyText(elRoomKeyOut ? elRoomKeyOut.value : "").then(ok => setInviteStatus(ok ? "Copied." : "Copy failed.", ok ? "ok" : "error")));
    }

    if (elRefreshBtn && !elRefreshBtn.dataset.bound) {
      elRefreshBtn.dataset.bound = "1";
      elRefreshBtn.addEventListener("click", () => refreshMessages().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elSendBtn && !elSendBtn.dataset.bound) {
      elSendBtn.dataset.bound = "1";
      elSendBtn.addEventListener("click", () => sendMessage().catch(e => setInviteStatus(e.message || String(e), "error")));
    }
    if (elCompose && !elCompose.dataset.bound) {
      elCompose.dataset.bound = "1";
      elCompose.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage().catch(err => setInviteStatus(err.message || String(err), "error"));
        }
      });
    }

    if (elJoinBtn && !elJoinBtn.dataset.bound) {
      elJoinBtn.dataset.bound = "1";
      elJoinBtn.addEventListener("click", () => joinViaInvite().catch(e => setJoinStatus(e.message || String(e), "error")));
    }
    if (elJoinClearBtn && !elJoinClearBtn.dataset.bound) {
      elJoinClearBtn.dataset.bound = "1";
      elJoinClearBtn.addEventListener("click", () => {
        if (elJoinInvite) elJoinInvite.value = "";
        if (elJoinRoomKey) elJoinRoomKey.value = "";
        if (elJoinPassword) elJoinPassword.value = "";
        setJoinStatus("", null);
      });
    }

    if (elAttachBtn && elAttachFile && !elAttachBtn.dataset.bound) {
      elAttachBtn.dataset.bound = "1";
      elAttachBtn.addEventListener("click", () => {
        elAttachFile.value = "";
        elAttachFile.click();
      });
      elAttachFile.addEventListener("change", () => {
        const f = elAttachFile.files && elAttachFile.files[0];
        if (!f) return;
        sendAttachment(f).catch(e => setInviteStatus(e.message || String(e), "error"));
      });
    }

    window.addEventListener("hashchange", () => {
      // when switching to chat tab, refresh and poll
      if (isChatTabActive()) {
        refreshMessages({ silent: true }).catch(()=>{});
        touchPresence().catch(()=>{});
        refreshParticipants({ silent: true }).catch(()=>{});
        startPolling();
      } else {
        stopPolling();
      }
    });
  }

  // ---- Init
  async function init() {
    bind();
    syncButtons();
    await loadThreads();
    if (isChatTabActive()) {
      touchPresence().catch(()=>{});
      refreshParticipants({ silent: true }).catch(()=>{});
      startPolling();
    }
  }

  // run once DOM is ready (Vault already loads big script; still safe)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init().catch(()=>{}));
  } else {
    init().catch(()=>{});
  }
})();
