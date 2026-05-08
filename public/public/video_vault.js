/* PDFRealm Secure Video Chat (Vault) — WebRTC + DB-backed signaling + manual invite links */
(function () {
  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    if (typeof window.toast === "function") return window.toast(msg);
    console.log("[video]", msg);
    try { alert(msg); } catch {}
  }

  function setStatus(msg) {
    const el = $("videoStatus");
    if (el) el.textContent = String(msg || "");
  }

  async function api(path, opts) {
    // IMPORTANT:
    // vault.html's apiFetch/state live inside an IIFE and are NOT global.
    // This video module must therefore attach auth headers itself.
    opts = opts || {};

    // Prefer any global apiFetch if present (some builds expose it), but fall back safely.
    if (typeof window.apiFetch === "function") {
      return window.apiFetch(path, opts);
    }

    // Resolve token from localStorage/cookie (same logic as Vault)
    let token = null;
    try {
      token = localStorage.getItem("pdfrealm_token") || null;
    } catch {}
    if (!token) {
      try {
        const m = document.cookie.match(/(?:^|;\s*)pdfrealm_token=([^;]+)/);
        if (m && m[1]) token = decodeURIComponent(m[1]);
      } catch {}
    }

    // Build headers
    const headers = new Headers(opts.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type") && opts.body && !(opts.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    const resp = await fetch(path, {
      ...opts,
      headers,
      credentials: "same-origin",
    });

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!resp.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function origin() {
    try { return window.location.origin; } catch { return ""; }
  }

  function isVideoTabActive() {
    return String(window.location.hash || "").includes("video");
  }

  function b64(s) {
    return btoa(unescape(encodeURIComponent(String(s))));
  }

  let state = {
    roomId: null,
    peerId: null,
    localStream: null,
    screenStream: null,
    pcs: new Map(), // peerId -> RTCPeerConnection
    remoteEls: new Map(), // peerId -> <video>
    pollTimer: null,
    pollParticipantsTimer: null,
    filesPollTimer: null,
    lastSignalId: 0,
    muted: false,
    roomKeyB64: null,
    roomKeyCrypto: null,
    filesUI: null,
    pendingFile: null,
  };



// --------- Key + File share helpers (client-side encryption) ----------
function b64urlEncode(bytes) {
  const bin = Array.from(bytes, b => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function getOrCreateRoomKeyB64(roomId) {
  if (!roomId) return null;
  const kname = `pdfrealm_video_room_key_${roomId}`;
  try {
    const existing = localStorage.getItem(kname);
    if (existing) return existing;
  } catch {}
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = b64urlEncode(bytes);
  try { localStorage.setItem(kname, b64); } catch {}
  return b64;
}
async function importRoomKey(roomId) {
  const b64 = getOrCreateRoomKeyB64(roomId);
  if (!b64) throw new Error("Missing room key.");
  if (state.roomKeyB64 === b64 && state.roomKeyCrypto) return state.roomKeyCrypto;
  const raw = b64urlDecode(b64);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt","decrypt"]);
  state.roomKeyB64 = b64;
  state.roomKeyCrypto = key;
  return key;
}
function fmtBytes(n) {
  n = Number(n || 0);
  const u = ["B","KB","MB","GB","TB"];
  let i=0;
  while (n>=1024 && i<u.length-1) { n/=1024; i++; }
  return `${n.toFixed(i?1:0)} ${u[i]}`;
}
async function apiBinary(path, opts) {
  opts = opts || {};
  if (typeof window.apiFetch === "function") {
    const resp = await fetch(path, { ...opts, headers: opts.headers, credentials: "same-origin" });
    if (!resp.ok) throw new Error(await resp.text());
    return await resp.arrayBuffer();
  }
  let token = null;
  try { token = localStorage.getItem("pdfrealm_token") || null; } catch {}
  if (!token) {
    try {
      const m = document.cookie.match(/(?:^|;\s*)pdfrealm_token=([^;]+)/);
      if (m && m[1]) token = decodeURIComponent(m[1]);
    } catch {}
  }
  const headers = new Headers(opts.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const resp = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  if (!resp.ok) throw new Error(await resp.text());
  return await resp.arrayBuffer();
}
function ensureVideoFilesPanel() {
  if (state.filesUI) return state.filesUI;
  const anchor = $("videoRemoteGrid") || $("videoLocal") || $("videoRoomsSelect") || document.body;
  const panel = document.createElement("div");
  panel.className = "card";
  panel.style.marginTop = "12px";
  panel.innerHTML = `    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div style="min-width:220px;">
        <div style="font-weight:700;">Shared Files</div>
        <div id="videoFilesHint" style="font-size:12px;opacity:.8;margin-top:2px;">Encrypted (client-side). Requires room key in invite link.</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
        <input id="videoFileInput" type="file" style="max-width:260px;display:none;" />
        <button id="videoPickFileBtn" class="btn" type="button">Choose file</button>
        <button id="videoUploadFileBtn" class="btn" type="button">Upload</button>
      </div>
    </div>

    <div id="videoDropZone" style="margin-top:10px;border:1px dashed rgba(255,255,255,.25);border-radius:12px;padding:12px;cursor:pointer;">
      <div style="font-weight:600;">Drag & drop a file here</div>
      <div id="videoDropLabel" style="font-size:12px;opacity:.8;margin-top:4px;">No file selected.</div>
    </div>

    <div id="videoFilesList" style="margin-top:12px;display:flex;flex-direction:column;gap:8px;"></div>`;
  // Try to place right under the remote grid
  if (anchor && anchor.parentNode) {
    if (anchor.id === "videoRemoteGrid") anchor.parentNode.appendChild(panel);
    else anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  } else {
    document.body.appendChild(panel);
  }
  state.filesUI = {
    panel,
    input: panel.querySelector("#videoFileInput"),
    pickBtn: panel.querySelector("#videoPickFileBtn"),
    uploadBtn: panel.querySelector("#videoUploadFileBtn"),
    dropZone: panel.querySelector("#videoDropZone"),
    dropLabel: panel.querySelector("#videoDropLabel"),
    list: panel.querySelector("#videoFilesList"),
    hint: panel.querySelector("#videoFilesHint"),
  };
  return state.filesUI;
}
function setFilesEnabled(on) {
  const ui = ensureVideoFilesPanel();
  if (ui.input) ui.input.disabled = !on;
  if (ui.pickBtn) ui.pickBtn.disabled = !on;
  if (ui.uploadBtn) ui.uploadBtn.disabled = !on;
  if (ui.dropZone) {
    ui.dropZone.style.opacity = on ? "1" : ".5";
    ui.dropZone.style.pointerEvents = on ? "auto" : "none";
  }
}
async function loadVideoFiles() {
  const rid = state.roomId || $("videoRoomsSelect")?.value;
  const ui = ensureVideoFilesPanel();
  if (!rid) {
    ui.list.innerHTML = `<div style="opacity:.75;font-size:13px;">Select a room to view files.</div>`;
    setFilesEnabled(false);
    return;
  }
  setFilesEnabled(true);
  const data = await api(`/api/video/rooms/${rid}/files`, { method: "GET" });
  const files = (data && data.files) ? data.files : [];
  if (!files.length) {
    ui.list.innerHTML = `<div style="opacity:.75;font-size:13px;">No shared files yet.</div>`;
    return;
  }
  ui.list.innerHTML = "";
  for (const f of files) {
    const row = document.createElement("div");
    row.style.display="flex";
    row.style.alignItems="center";
    row.style.justifyContent="space-between";
    row.style.gap="10px";
    row.style.padding="10px";
    row.style.border="1px solid rgba(255,255,255,.08)";
    row.style.borderRadius="12px";
    const meta = document.createElement("div");
    meta.style.display="flex";
    meta.style.flexDirection="column";
    meta.style.gap="2px";
    meta.innerHTML = `
      <div style="font-weight:600;">${escapeHtml(f.filename || "file")}</div>
      <div style="font-size:12px;opacity:.75;">${fmtBytes(f.size)} · ${escapeHtml(f.uploader_name || f.uploader_id || "")}${f.created_at ? " · " + new Date(f.created_at).toLocaleString() : ""}</div>
    `;
    const actions = document.createElement("div");
    actions.style.display="flex";
    actions.style.gap="8px";
    const b = document.createElement("button");
    b.className="btn";
    b.textContent="Download";
    b.addEventListener("click", () => downloadVideoFile(rid, f).catch(e => toast(String(e?.message || e))));
    actions.appendChild(b);
    row.appendChild(meta);
    row.appendChild(actions);
    ui.list.appendChild(row);
  }
}
function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
async function uploadVideoFile(roomId, file) {
  if (!roomId) throw new Error("Select a room first.");
  if (!file) throw new Error("Choose a file.");
  const key = await importRoomKey(roomId);
  const plain = await file.arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);

  const fd = new FormData();
  fd.append("file", new Blob([ct], { type: "application/octet-stream" }), "blob.bin");
  fd.append("filename", file.name || "file");
  fd.append("mime", file.type || "application/octet-stream");
  fd.append("size", String(file.size || plain.byteLength || 0));
  fd.append("iv", b64urlEncode(iv));
  fd.append("nonce", b64urlEncode(iv));

  await api(`/api/video/rooms/${roomId}/files`, { method: "POST", body: fd });
}
async function downloadVideoFile(roomId, f) {
  const key = await importRoomKey(roomId);
  const ivB64 = f.iv || f.nonce;
  if (!ivB64) throw new Error("Missing IV/nonce for this file.");
  const iv = b64urlDecode(ivB64);
  const buf = await apiBinary(`/api/video/rooms/${roomId}/files/${f.id}`, { method: "GET" });
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf);
  const blob = new Blob([pt], { type: f.mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = f.filename || "file";
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ try { URL.revokeObjectURL(a.href); } catch {} try { a.remove(); } catch {} }, 250);
}

  function ensurePeerId() {
    if (!state.peerId) {
      // short random peer id
      state.peerId = (crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(16).slice(2) + Date.now().toString(16))).replace(/-/g,"").slice(0, 16);
      const you = $("videoYouLabel");
      if (you) you.textContent = `peer:${state.peerId}`;
    }
    return state.peerId;
  }

  function clearRemote(peerId) {
    const el = state.remoteEls.get(peerId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    state.remoteEls.delete(peerId);
  }

  function stopAll() {
    try {
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (state.pollParticipantsTimer) clearInterval(state.pollParticipantsTimer);
      if (state.filesPollTimer) clearInterval(state.filesPollTimer);
    } catch {}
    state.pollTimer = null;
    state.pollParticipantsTimer = null;
    state.filesPollTimer = null;
    state.lastSignalId = 0;

    for (const [pid, pc] of state.pcs.entries()) {
      try { pc.close(); } catch {}
      clearRemote(pid);
    }
    state.pcs.clear();

    if (state.screenStream) {
      try { state.screenStream.getTracks().forEach(t => t.stop()); } catch {}
      state.screenStream = null;
    }
    if (state.localStream) {
      try { state.localStream.getTracks().forEach(t => t.stop()); } catch {}
      state.localStream = null;
    }
    const lv = $("videoLocal");
    if (lv) lv.srcObject = null;

    setStatus("Idle");
    const others = $("videoOthersLabel");
    if (others) others.textContent = "—";
  }

  async function ensureLocalMedia() {
    if (state.localStream) return state.localStream;
    setStatus("Requesting camera/mic…");
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.localStream = stream;
    const lv = $("videoLocal");
    if (lv) lv.srcObject = stream;
    setStatus("Local media ready");
    return stream;
  }

  function iceConfig() {
    const stun = (window.PDFREALM_STUN_URLS && Array.isArray(window.PDFREALM_STUN_URLS)) ? window.PDFREALM_STUN_URLS : ["stun:stun.l.google.com:19302"];
    return { iceServers: stun.map(u => ({ urls: u })) };
  }

  function getOrCreateRemoteEl(peerId) {
    let el = state.remoteEls.get(peerId);
    if (el) return el;
    const grid = $("videoRemoteGrid");
    if (!grid) return null;
    el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute("data-peer", peerId);
    el.style.width = "100%";
    el.style.borderRadius = "14px";
    el.style.background = "#000";
    el.style.minHeight = "220px";
    grid.appendChild(el);
    state.remoteEls.set(peerId, el);
    return el;
  }

  async function sendSignal(toPeer, type, payload) {
    if (!state.roomId) throw new Error("No room selected");
    const fromPeer = ensurePeerId();
    await api(`/api/video/rooms/${state.roomId}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_peer: fromPeer,
        to_peer: toPeer || null,
        type,
        payload,
      }),
    });
  }

  async function ensurePc(remotePeerId) {
    let pc = state.pcs.get(remotePeerId);
    if (pc) return pc;

    const stream = await ensureLocalMedia();
    pc = new RTCPeerConnection(iceConfig());
    state.pcs.set(remotePeerId, pc);

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.ontrack = (ev) => {
      const el = getOrCreateRemoteEl(remotePeerId);
      if (el) el.srcObject = ev.streams[0];
      const others = $("videoOthersLabel");
      if (others) others.textContent = `${state.remoteEls.size} participant(s)`;
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendSignal(remotePeerId, "candidate", ev.candidate).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        clearRemote(remotePeerId);
        try { pc.close(); } catch {}
        state.pcs.delete(remotePeerId);
      }
    };

    return pc;
  }

  async function makeOffer(remotePeerId) {
    const pc = await ensurePc(remotePeerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal(remotePeerId, "offer", offer);
  }

  async function handleSignal(sig) {
    const myPeer = ensurePeerId();
    if (sig.from_peer === myPeer) return;
    if (sig.to_peer && sig.to_peer !== myPeer) return;

    const remotePeer = sig.from_peer || "unknown";
    if (!remotePeer || remotePeer === myPeer) return;

    const pc = await ensurePc(remotePeer);

    if (sig.type === "offer") {
      await pc.setRemoteDescription(sig.payload);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await sendSignal(remotePeer, "answer", ans);
      return;
    }

    if (sig.type === "answer") {
      await pc.setRemoteDescription(sig.payload);
      return;
    }

    if (sig.type === "candidate") {
      try { await pc.addIceCandidate(sig.payload); } catch {}
      return;
    }
  }

  async function touchPresence() {
    if (!state.roomId) return;
    const peerId = ensurePeerId();
    await api(`/api/video/rooms/${state.roomId}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: peerId,
        actor_name: null, // server will derive if possible
      }),
    });
  }

  function renderOnline(list) {
    const chips = $("videoOnlineChips");
    const count = $("videoOnlineCount");
    if (!chips || !count) return;
    chips.innerHTML = "";
    const uniq = [];
    const seen = new Set();
    for (const a of (list || [])) {
      const key = `${a.actor_kind}:${a.actor_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(a);
    }
    count.textContent = String(uniq.length);
    for (const a of uniq) {
      const span = document.createElement("span");
      span.className = "pill";
      const nm = a.actor_name || (a.actor_kind === "guest" ? "Guest" : "Member");
      span.textContent = nm;
      chips.appendChild(span);
    }
  }

  async function refreshParticipants() {
    if (!state.roomId) return;
    try {
      const data = await api(`/api/video/rooms/${state.roomId}/participants`, { method: "GET" });
      renderOnline(data.participants || []);
      // Auto-offer logic: establish connections to any other peers present
      const myPeer = ensurePeerId();
      const peers = (data.participants || []).map(p => p.peer_id).filter(Boolean).filter(p => p !== myPeer);

      // If no remotes, clean up remote grid
      const remotePeersSet = new Set(peers);
      for (const existing of Array.from(state.pcs.keys())) {
        if (!remotePeersSet.has(existing)) {
          try { state.pcs.get(existing).close(); } catch {}
          state.pcs.delete(existing);
          clearRemote(existing);
        }
      }

      for (const rp of peers) {
        if (!state.pcs.has(rp)) {
          // Deterministic initiator: lexicographically smaller peer initiates
          if (String(myPeer) < String(rp)) {
            makeOffer(rp).catch(() => {});
          } else {
            // wait for offer
            ensurePc(rp).catch(() => {});
          }
        }
      }
    } catch (e) {
      // do not spam
    }
  }

  async function pollSignals() {
    if (!state.roomId) return;
    try {
      const data = await api(`/api/video/rooms/${state.roomId}/signals?since_id=${encodeURIComponent(String(state.lastSignalId || 0))}`, { method: "GET" });
      const signals = data.signals || [];
      for (const s of signals) {
        if (s.id > state.lastSignalId) state.lastSignalId = s.id;
        await handleSignal(s);
      }
    } catch (e) {
      // ignore transient
    }
  }

  async function loadRooms(selectId) {
    const sel = $("videoRoomsSelect");
    if (!sel) return;
    sel.innerHTML = "";
    try {
      const data = await api("/api/video/rooms", { method: "GET" });
      const rooms = data.rooms || [];
      if (!rooms.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no rooms yet)";
        sel.appendChild(opt);
      } else {
        for (const r of rooms) {
          const opt = document.createElement("option");
          opt.value = r.id;
          opt.textContent = r.title || r.id;
          sel.appendChild(opt);
        }
      }
      if (selectId) sel.value = selectId;
      state.roomId = sel.value || null;
    } catch (e) {
      // If not logged in, avoid breaking the rest of vault
      const msg = String(e?.message || e);
      setStatus("Login required for video rooms");
      console.warn("[video] loadRooms:", msg);
    }
  }

  async function createRoom() {
    const title = prompt("Room name:", "Video Room");
    if (title === null) return;
    const data = await api("/api/video/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    await loadRooms(data.room?.id || data.id);
    toast("Room created");
  }

  async function deleteRoom() {
    const rid = state.roomId || $("videoRoomsSelect")?.value;
    if (!rid) return toast("Select a room first");
    if (!confirm("Remove this room? (soft delete)")) return;
    await api(`/api/video/rooms/${rid}`, { method: "DELETE" });
    stopAll();
    await loadRooms();
    toast("Room removed");
  }

  async function createInvite() {
    const rid = state.roomId || $("videoRoomsSelect")?.value;
    if (!rid) return toast("Select a room first");
    const pw = $("videoInvitePassword") ? $("videoInvitePassword").value : "";
    const data = await api(`/api/video/rooms/${rid}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_in_seconds: 0,
        password: pw ? String(pw) : null,
        allow_write: true,
      }),
    });
    const k = getOrCreateRoomKeyB64(rid);
    const link = `${origin()}/v/${data.token}${k ? `#k=${encodeURIComponent(k)}` : ""}`;
    const inp = $("videoInviteLink");
    if (inp) inp.value = link;
    toast("Invite link created");
  }

  async function copyInvite() {
    const inp = $("videoInviteLink");
    if (!inp || !inp.value) return toast("No invite link");
    try {
      await navigator.clipboard.writeText(inp.value);
      toast("Copied");
    } catch {
      inp.select();
      document.execCommand("copy");
      toast("Copied");
    }
  }

  async function start() {
    const sel = $("videoRoomsSelect");
    const rid = sel ? sel.value : state.roomId;
    if (!rid) return toast("Select a room first");
    state.roomId = rid;
    ensurePeerId();
    await ensureLocalMedia();
    await touchPresence().catch(()=>{});
    setStatus("Connecting…");
    // start loops
    if (!state.pollTimer) state.pollTimer = setInterval(pollSignals, 1200);
    if (!state.filesPollTimer) state.filesPollTimer = setInterval(() => { loadVideoFiles().catch(()=>{}); }, 2500);
    if (!state.pollParticipantsTimer) state.pollParticipantsTimer = setInterval(async () => {
      await touchPresence().catch(()=>{});
      await refreshParticipants().catch(()=>{});
    }, 2500);
    await refreshParticipants().catch(()=>{});
    setStatus("Live");
  }

  function toggleMute() {
    state.muted = !state.muted;
    const btn = $("videoMuteBtn");
    if (btn) btn.textContent = state.muted ? "Unmute" : "Mute";
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => t.enabled = !state.muted);
    }
  }

  async function shareScreen() {
    if (!state.localStream) return toast("Start first");
    if (state.screenStream) {
      // stop sharing and revert
      try { state.screenStream.getTracks().forEach(t => t.stop()); } catch {}
      state.screenStream = null;
      // revert to camera track
      const camTrack = state.localStream.getVideoTracks()[0];
      for (const pc of state.pcs.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender && camTrack) sender.replaceTrack(camTrack).catch(()=>{});
      }
      toast("Stopped sharing");
      return;
    }

    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      state.screenStream = ds;
      const screenTrack = ds.getVideoTracks()[0];
      // replace track in all peer connections
      for (const pc of state.pcs.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender && screenTrack) sender.replaceTrack(screenTrack).catch(()=>{});
      }
      // show locally
      const lv = $("videoLocal");
      if (lv) lv.srcObject = ds;
      screenTrack.onended = () => {
        // revert when stopped by browser UI
        shareScreen().catch(()=>{});
      };
      toast("Sharing screen");
    } catch (e) {
      toast("Screen share blocked");
    }
  }

  function bind() {
    const sel = $("videoRoomsSelect");
    if (sel) sel.addEventListener("change", () => {
      state.roomId = sel.value || null;
      state.lastSignalId = 0;
      // do not auto-start
      refreshParticipants().catch(()=>{});
      loadVideoFiles().catch(()=>{});
    });

    const bNew = $("videoNewRoomBtn");
    if (bNew) bNew.addEventListener("click", () => createRoom().catch(e => toast(String(e?.message || e))));

    const bDel = $("videoDeleteRoomBtn");
    if (bDel) bDel.addEventListener("click", () => deleteRoom().catch(e => toast(String(e?.message || e))));

    const bStart = $("videoStartBtn");
    if (bStart) bStart.addEventListener("click", () => start().catch(e => toast(String(e?.message || e))));

    const bHang = $("videoHangupBtn");
    if (bHang) bHang.addEventListener("click", () => stopAll());

    const bMute = $("videoMuteBtn");
    if (bMute) bMute.addEventListener("click", () => toggleMute());

    const bShare = $("videoShareBtn");
    if (bShare) bShare.addEventListener("click", () => shareScreen());

    const bInvite = $("videoInviteBtn");
    if (bInvite) bInvite.addEventListener("click", () => createInvite().catch(e => toast(String(e?.message || e))));

    const bCopy = $("videoCopyInviteBtn");
    if (bCopy) bCopy.addEventListener("click", () => copyInvite().catch(()=>{}));

// File share (drag & drop + picker)
const ui = ensureVideoFilesPanel();

// Bind "Choose file"
if (ui.pickBtn && !ui.pickBtn.__bound) {
  ui.pickBtn.__bound = true;
  ui.pickBtn.addEventListener("click", () => {
    try { ui.input && ui.input.click(); } catch {}
  });
}

// Track picker selection
if (ui.input && !ui.input.__bound) {
  ui.input.__bound = true;
  ui.input.addEventListener("change", () => {
    const f = ui.input && ui.input.files ? ui.input.files[0] : null;
    state.pendingFile = f || null;
    if (ui.dropLabel) ui.dropLabel.textContent = f ? `Selected: ${f.name} (${Math.round((f.size||0)/1024)} KB)` : "No file selected.";
  });
}

// Drag & drop support
if (ui.dropZone && !ui.dropZone.__bound) {
  ui.dropZone.__bound = true;

  const highlight = (on) => {
    try {
      ui.dropZone.style.borderColor = on ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.25)";
      ui.dropZone.style.background = on ? "rgba(255,255,255,.06)" : "transparent";
    } catch {}
  };

  ui.dropZone.addEventListener("click", () => {
    try { ui.input && ui.input.click(); } catch {}
  });

  ui.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); highlight(true); });
  ui.dropZone.addEventListener("dragleave", () => highlight(false));
  ui.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    highlight(false);
    const dt = e.dataTransfer;
    const f = dt && dt.files && dt.files[0] ? dt.files[0] : null;
    if (!f) return;
    state.pendingFile = f;
    if (ui.dropLabel) ui.dropLabel.textContent = `Selected: ${f.name} (${Math.round((f.size||0)/1024)} KB)`;
  });
}

// Upload
if (ui.uploadBtn && !ui.uploadBtn.__bound) {
  ui.uploadBtn.__bound = true;
  ui.uploadBtn.addEventListener("click", async () => {
    const rid = state.roomId || $("videoRoomsSelect")?.value;
    const file = state.pendingFile || (ui.input && ui.input.files ? ui.input.files[0] : null);
    if (!file) throw new Error("Choose a file (or drag & drop) first.");
    await uploadVideoFile(rid, file);

    state.pendingFile = null;
    if (ui.input) ui.input.value = "";
    if (ui.dropLabel) ui.dropLabel.textContent = "No file selected.";

    await loadVideoFiles();
    toast("File uploaded.");
  });
}



  }

  async function init() {
    ensureVideoFilesPanel();
    bind();
    await loadRooms();
    if (isVideoTabActive()) {
      refreshParticipants().catch(()=>{});
      loadVideoFiles().catch(()=>{});
    }
    window.addEventListener("hashchange", () => {
      if (!isVideoTabActive()) return;
      loadRooms().catch(()=>{});
      refreshParticipants().catch(()=>{});
      loadVideoFiles().catch(()=>{});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();