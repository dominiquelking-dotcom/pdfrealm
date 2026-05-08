
(() => {
  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  function injectStyles() {
    const css = `
      .secure-ai-bar {
        display:flex;
        align-items:center;
        gap:10px;
        padding:10px 12px;
        border:1px solid rgba(255,255,255,.10);
        border-radius:12px;
        margin: 10px 0 14px;
        background: rgba(0,0,0,.25);
        flex-wrap: wrap;
      }
      .secure-ai-pill {
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        font-size:12px;
      }
      .secure-ai-indicator {
        display:none;
        align-items:center;
        gap:6px;
        font-weight:600;
      }
      .secure-ai-indicator.on {
        display:inline-flex;
      }
      .secure-ai-dot {
        width:9px; height:9px; border-radius:999px;
        background: #ff4d4d;
        box-shadow: 0 0 0 4px rgba(255,77,77,.20);
      }
      .secure-ai-status {
        color: rgba(255,255,255,.78);
        font-size: 12px;
        margin-left:auto;
      }
      .secure-ai-modal-backdrop{
        position:fixed; inset:0; background: rgba(0,0,0,.6);
        display:none; align-items:center; justify-content:center;
        z-index: 9999;
      }
      .secure-ai-modal-backdrop.show{ display:flex; }
      .secure-ai-modal{
        width:min(560px, calc(100vw - 24px));
        background:#121212;
        border:1px solid rgba(255,255,255,.12);
        border-radius:14px;
        padding:16px;
        box-shadow: 0 20px 60px rgba(0,0,0,.6);
      }
      .secure-ai-modal h3{ margin:0 0 8px; font-size:16px; }
      .secure-ai-modal p{ margin:0 0 10px; color: rgba(255,255,255,.78); }
      .secure-ai-modal .row{ display:flex; gap:10px; justify-content:flex-end; margin-top:14px; flex-wrap:wrap; }
    `;
    const style = el("style", {}, [css]);
    document.head.appendChild(style);
  }

  function pickMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
    for (const t of candidates) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
      } catch {}
    }
    return "";
  }

  function parseRoomIdFromLink(link) {
    if (!link) return null;
    try {
      const u = new URL(link, window.location.origin);
      const invite = u.searchParams.get("invite");
      if (invite) return invite;
      // fall back: last path segment
      const segs = u.pathname.split("/").filter(Boolean);
      return segs[segs.length - 1] || null;
    } catch {
      // raw token
      return String(link).trim() || null;
    }
  }

  function createConsentModal() {
    const backdrop = el("div", { class: "secure-ai-modal-backdrop", id: "secureAiConsentModal" });
    const modal = el("div", { class: "secure-ai-modal" });
    const title = el("h3", {}, ["Consent Required"]);
    const body = el("p", { id: "secureAiConsentText" }, [
      "This will record audio and generate an AI-organized report. Everyone must consent before recording starts.",
    ]);
    const small = el("p", { style: "font-size:12px; color: rgba(255,255,255,.6)" }, [
      "You can stop at any time. Reports are saved to your Vault (folder: AI Notes).",
    ]);
    const btnRow = el("div", { class: "row" });
    const decline = el("button", { class: "btn", id: "secureAiConsentDecline", type: "button" }, ["Decline"]);
    const accept = el("button", { class: "btn primary", id: "secureAiConsentAccept", type: "button" }, ["I Consent"]);
    btnRow.appendChild(decline);
    btnRow.appendChild(accept);

    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(small);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    return {
      show: ({ text, onAccept, onDecline }) => {
        if (text) body.textContent = text;
        const clean = () => {
          backdrop.classList.remove("show");
          accept.onclick = null;
          decline.onclick = null;
        };
        accept.onclick = async () => {
          try {
            await onAccept?.();
          } finally {
            clean();
          }
        };
        decline.onclick = async () => {
          try {
            await onDecline?.();
          } finally {
            clean();
          }
        };
        backdrop.classList.add("show");
      },
      hide: () => backdrop.classList.remove("show"),
    };
  }

  function createAiBar(kind) {
    const toggleId = `secureAiToggle_${kind}`;
    const finalizeId = `secureAiFinalize_${kind}`;
    const dlId = `secureAiDownload_${kind}`;
    const delId = `secureAiDelete_${kind}`;
    const statusId = `secureAiStatus_${kind}`;
    const indId = `secureAiIndicator_${kind}`;

    const toggle = el("input", { type: "checkbox", id: toggleId });
    const toggleLabel = el("label", { class: "secure-ai-pill", for: toggleId }, [toggle, " ", "AI Notes"]);
    const indicator = el("span", { class: "secure-ai-indicator", id: indId }, [
      el("span", { class: "secure-ai-dot" }),
      "Recording",
    ]);
    const finalizeBtn = el("button", { class: "btn primary", id: finalizeId, type: "button", disabled: true }, [
      kind === "video" ? "Stop & Generate PDF" : "Generate PDF",
    ]);
    const download = el("a", { class: "btn", id: dlId, href: "#", style: "display:none", download: "" }, ["Download PDF"]);
    const del = el("button", { class: "btn", id: delId, type: "button", style: "display:none" }, ["Delete Artifacts"]);
    const status = el("span", { class: "secure-ai-status", id: statusId }, [""]);

    const bar = el("div", { class: "secure-ai-bar" }, [toggleLabel, indicator, finalizeBtn, download, del, status]);
    return { bar, toggle, finalizeBtn, download, del, status, indicator };
  }

  async function jsonFetch(url, opts = {}) {
    const resp = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const text = await resp.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!resp.ok) {
      const err = (json && json.error) || text || `HTTP ${resp.status}`;
      const e = new Error(err);
      e.status = resp.status;
      e.payload = json || text;
      throw e;
    }
    return json;
  }

  function setupController({ kind, barUI, getRoomId, getChatText, getVideoStreams, onExternalStopBtnId }) {
    const state = {
      kind,
      enabled: false,
      roomId: null,
      sessionId: null,
      jobId: null,
      pollTimer: null,
      jobTimer: null,

      recorder: null,
      recorderSeq: 0,
      recorderMime: "",
      micCtx: null,
      mixDest: null,
      connectedStreamIds: new Set(),
      mixScanTimer: null,
    };

    const setStatus = (msg) => {
      barUI.status.textContent = msg || "";
    };

    const setIndicator = (on, label) => {
      if (on) {
        barUI.indicator.classList.add("on");
        barUI.indicator.lastChild && (barUI.indicator.lastChild.textContent = label || "Recording");
      } else {
        barUI.indicator.classList.remove("on");
      }
    };

    const showDownload = (href) => {
      barUI.download.href = href;
      barUI.download.style.display = "inline-flex";
      barUI.del.style.display = "inline-flex";
    };

    const hideDownload = () => {
      barUI.download.style.display = "none";
      barUI.download.href = "#";
      barUI.del.style.display = "none";
    };

    async function createOrReuseSession() {
      const roomId = getRoomId();
      if (!roomId) throw new Error("Create or join a room first.");
      state.roomId = roomId;

      const resp = await jsonFetch("/api/secure-ai/session", {
        method: "POST",
        body: JSON.stringify({
          sessionType: kind === "video" ? "video" : "chat",
          title: kind === "video" ? "Secure Video" : "Secure Chat",
          roomId,
        }),
      });

      state.sessionId = resp.sessionId;
      return resp;
    }

    async function sendConsent(consent) {
      if (!state.sessionId) throw new Error("No session");
      return jsonFetch(`/api/secure-ai/session/${state.sessionId}/consent`, {
        method: "POST",
        body: JSON.stringify({ consent: !!consent }),
      });
    }

    async function uploadChunk(blob) {
      if (!state.sessionId) return;
      const fd = new FormData();
      fd.append("seq", String(state.recorderSeq));
      fd.append("mimeType", state.recorderMime || blob.type || "audio/webm");
      const bt = blob.type || state.recorderMime || "audio/webm";
      const ext = bt.includes("ogg") ? "ogg" : bt.includes("mp4") ? "mp4" : bt.includes("wav") ? "wav" : "webm";
      fd.append("chunk", new File([blob], `${String(state.recorderSeq).padStart(6, "0")}.${ext}`, { type: bt }));
      state.recorderSeq += 1;

      const resp = await fetch(`/api/secure-ai/session/${state.sessionId}/chunk`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!resp.ok) throw new Error("Chunk upload failed");
    }

    function connectStreamAudio(stream) {
      if (!stream) return;
      try {
        if (!stream.getAudioTracks || stream.getAudioTracks().length === 0) return;
        if (state.connectedStreamIds.has(stream.id)) return;
        state.connectedStreamIds.add(stream.id);

        const source = state.micCtx.createMediaStreamSource(stream);
        source.connect(state.mixDest);
      } catch (e) {
        // ignore
      }
    }

    async function startVideoRecorder() {
      const streams = getVideoStreams ? getVideoStreams() : null;
      const localStream = streams?.local || null;
      const remotes = streams?.remotes || [];

      if (!localStream && (!remotes || !remotes.length)) {
        throw new Error("No audio streams available yet.");
      }

      state.recorderMime = pickMimeType();
      state.micCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.mixDest = state.micCtx.createMediaStreamDestination();
      state.connectedStreamIds = new Set();

      // Some browsers start AudioContext suspended; try to resume (must be from a user gesture)
      try {
        await state.micCtx.resume();
      } catch {}

      if (localStream) connectStreamAudio(localStream);
      for (const s of remotes) connectStreamAudio(s);

      // Periodically scan for new remote streams and connect them.
      if (state.mixScanTimer) clearInterval(state.mixScanTimer);
      state.mixScanTimer = setInterval(() => {
        const streams2 = getVideoStreams ? getVideoStreams() : null;
        const rem2 = streams2?.remotes || [];
        const loc2 = streams2?.local || null;
        if (loc2) connectStreamAudio(loc2);
        for (const s of rem2) connectStreamAudio(s);
      }, 2000);

      state.recorder = new MediaRecorder(state.mixDest.stream, state.recorderMime ? { mimeType: state.recorderMime } : undefined);

      state.recorder.ondataavailable = async (ev) => {
        if (!ev.data || !ev.data.size) return;
        try {
          await uploadChunk(ev.data);
        } catch (e) {
          console.error(e);
          setStatus("Upload error. Stopping…");
          try {
            state.recorder && state.recorder.state !== "inactive" && state.recorder.stop();
          } catch {}
        }
      };

      state.recorder.start(1000);
    }

    async function stopVideoRecorder() {
      if (state.mixScanTimer) {
        clearInterval(state.mixScanTimer);
        state.mixScanTimer = null;
      }

      if (state.recorder && state.recorder.state !== "inactive") {
        await new Promise((resolve) => {
          state.recorder.onstop = () => resolve();
          try {
            state.recorder.stop();
          } catch {
            resolve();
          }
        });
      }
      state.recorder = null;

      try {
        if (state.micCtx) await state.micCtx.close();
      } catch {}
      state.micCtx = null;
      state.mixDest = null;
    }

    async function finalize() {
      if (!state.sessionId) return;

      setStatus("Finalizing…");
      barUI.finalizeBtn.disabled = true;

      const body =
        kind === "chat"
          ? {
              chatText: (getChatText && getChatText()) || "",
            }
          : {};

      const job = await jsonFetch(`/api/secure-ai/session/${state.sessionId}/finalize`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      state.jobId = job.jobId;
      setStatus("Queued…");
      startJobPolling();
    }

    async function pollRoom() {
      if (!state.roomId) return;
      try {
        const r = await jsonFetch(`/api/secure-ai/room/${encodeURIComponent(state.roomId)}`, { method: "GET" });
        if (!r.exists) {
          setStatus("");
          setIndicator(false);
          return;
        }
        state.sessionId = r.sessionId;

        if (r.status === "RECORDING") {
          if (kind === "video") setIndicator(true, "Recording");
          else setIndicator(false);

          barUI.finalizeBtn.disabled = false;

          if (kind === "video" && state.enabled && !state.recorder) {
            try {
              await startVideoRecorder();
              setStatus("Recording…");
            } catch (e) {
              console.error(e);
              setStatus("Waiting for audio streams…");
            }
          } else if (kind === "chat") {
            setStatus("AI Notes enabled.");
          }
        } else if (r.status === "CONSENT_PENDING") {
          setIndicator(false);
          barUI.finalizeBtn.disabled = true;
          if (kind === "video" && state.recorder) {
            await stopVideoRecorder();
          }
          setStatus(r.consent ? `Consent: ${r.consent.accepted}/${r.consent.required}` : "Consent required");

          // If this user hasn't responded yet, prompt once per session.
          if (r.myConsent === null && state._lastConsentPromptSessionId !== r.sessionId) {
            state._lastConsentPromptSessionId = r.sessionId;
            window.__secureAiConsentModal.show({
              text:
                kind === "video"
                  ? "AI Notes will record mixed call audio and generate an AI report. Do you consent?"
                  : "AI Notes will generate an AI-organized report from this conversation. Do you consent?",
              onAccept: async () => {
                await sendConsent(true);
              },
              onDecline: async () => {
                await sendConsent(false).catch(() => {});
              },
            });
          }
        } else if (r.status === "PROCESSING" || r.status === "FINALIZING") {
          setIndicator(false);
          barUI.finalizeBtn.disabled = true;
          setStatus("Processing…");
        } else if (r.status === "READY") {
          setIndicator(false);
          barUI.finalizeBtn.disabled = false;
          setStatus("Ready (saved to Vault).");
          showDownload(`/api/secure-ai/session/${state.sessionId}/report`);
        }
      } catch (e) {
        // ignore transient errors
      }
    }

    function startRoomPolling() {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = setInterval(pollRoom, 1500);
      pollRoom();
    }

    async function pollJob() {
      if (!state.jobId) return;
      try {
        const j = await jsonFetch(`/api/secure-ai/job/${state.jobId}`, { method: "GET" });
        if (j.status === "READY") {
          setStatus("Ready (saved to Vault).");
          showDownload(`/api/secure-ai/session/${state.sessionId}/report`);
          stopJobPolling();
        } else if (j.status === "FAILED") {
          setStatus("Failed: " + (j.error || "unknown"));
          stopJobPolling();
        } else {
          setStatus(j.progress || j.status);
        }
      } catch (e) {
        // ignore transient
      }
    }

    function startJobPolling() {
      if (state.jobTimer) clearInterval(state.jobTimer);
      state.jobTimer = setInterval(pollJob, 1500);
      pollJob();
    }

    function stopJobPolling() {
      if (state.jobTimer) clearInterval(state.jobTimer);
      state.jobTimer = null;
    }

    async function stopAll() {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
      stopJobPolling();

      if (kind === "video") await stopVideoRecorder();

      state.enabled = false;
      setIndicator(false);
      setStatus("");
      barUI.finalizeBtn.disabled = true;
    }

    // UI events
    barUI.toggle.addEventListener("change", async () => {
      hideDownload();
      if (barUI.toggle.checked) {
        state.enabled = true;
        setStatus("Starting…");
        try {
          await createOrReuseSession();
          startRoomPolling();

          window.__secureAiConsentModal.show({
            text: "AI Notes will record audio and generate an AI-organized report. Everyone must consent before recording starts.",
            onAccept: async () => {
              await sendConsent(true);
              setStatus("Consent recorded. Waiting for others…");
            },
            onDecline: async () => {
              await sendConsent(false).catch(() => {});
              barUI.toggle.checked = false;
              await stopAll();
              setStatus("Declined.");
            },
          });
        } catch (e) {
          console.error(e);
          barUI.toggle.checked = false;
          state.enabled = false;
          setStatus(e?.message || "Failed to start");
        }
      } else {
        // stop
        try {
          if (kind === "video") await stopVideoRecorder();
          await finalize();
        } catch (e) {
          console.error(e);
          setStatus(e?.message || "Failed to finalize");
        } finally {
          state.enabled = false;
        }
      }
    });

    barUI.finalizeBtn.addEventListener("click", async () => {
      try {
        if (kind === "video") await stopVideoRecorder();
        await finalize();
      } catch (e) {
        console.error(e);
        setStatus(e?.message || "Failed to finalize");
      }
    });

    barUI.del.addEventListener("click", async () => {
      if (!state.sessionId) return;
      if (!confirm("Delete AI Notes artifacts for this session? This will remove the report/transcript from Vault.")) return;
      try {
        await fetch(`/api/secure-ai/session/${state.sessionId}`, { method: "DELETE", credentials: "include" });
        hideDownload();
        setStatus("Deleted.");
      } catch (e) {
        console.error(e);
        setStatus("Delete failed.");
      }
    });

    // External stop (hangup) button wiring
    if (onExternalStopBtnId) {
      const btn = document.getElementById(onExternalStopBtnId);
      if (btn) {
        btn.addEventListener("click", async () => {
          if (!state.enabled) return;
          try {
            if (kind === "video") await stopVideoRecorder();
            await finalize();
          } catch {}
        });
      }
    }

    // Best-effort leave signal
    window.addEventListener("beforeunload", () => {
      if (!state.sessionId) return;
      try {
        navigator.sendBeacon?.(`/api/secure-ai/session/${state.sessionId}/leave`);
      } catch {}
    });

    // Passive room watcher: if the user joins a room, start polling so they can consent.
    state._lastConsentPromptSessionId = null;
    state._roomWatchTimer = setInterval(() => {
      try {
        const rid = getRoomId && getRoomId();
        if (rid && rid !== state.roomId) {
          state.roomId = rid;
          startRoomPolling();
        }
        if (!rid && state.roomId) {
          state.roomId = null;
          if (state.pollTimer) clearInterval(state.pollTimer);
          state.pollTimer = null;
          setIndicator(false);
          setStatus("");
        }
      } catch {
        // ignore
      }
    }, 1200);

    return state;
  }

  function getVaultChatRoomId() {
    const inviteOut = document.getElementById("chatInviteOut");
    const joinIn = document.getElementById("chatJoinInvite");
    const v = (inviteOut && inviteOut.value) || (joinIn && joinIn.value) || "";
    return parseRoomIdFromLink(v);
  }

  function getVaultVideoRoomId() {
    const sel = document.getElementById("videoRoomsSelect");
    if (sel && sel.value) return String(sel.value);
    const inviteOut = document.getElementById("videoInviteLink");
    return parseRoomIdFromLink(inviteOut && inviteOut.value);
  }

  function getChatText() {
    const msgs = document.getElementById("chatMessages");
    if (!msgs) return "";
    return (msgs.innerText || msgs.textContent || "").trim();
  }

  function getVideoStreams() {
    const localEl = document.getElementById("videoLocal");
    const local = localEl && localEl.srcObject ? localEl.srcObject : null;

    const grid = document.getElementById("videoRemoteGrid");
    const rem = [];
    if (grid) {
      const nodes = grid.querySelectorAll("video,audio");
      nodes.forEach((n) => {
        if (n && n.srcObject) rem.push(n.srcObject);
      });
    }
    return { local, remotes: rem };
  }

  window.addEventListener("DOMContentLoaded", () => {
    injectStyles();
    window.__secureAiConsentModal = createConsentModal();

    // Chat bar
    const chatRoot = document.getElementById("vaultSecureChat");
    if (chatRoot) {
      const header = chatRoot.querySelector(".secure-header");
      const ui = createAiBar("chat");
      (header ? header.after(ui.bar) : chatRoot.prepend(ui.bar));
      setupController({
        kind: "chat",
        barUI: ui,
        getRoomId: getVaultChatRoomId,
        getChatText,
      });
    }

    // Video bar
    const vidRoot = document.getElementById("vaultSecureVideo");
    if (vidRoot) {
      const header = vidRoot.querySelector(".secure-header");
      const ui = createAiBar("video");
      (header ? header.after(ui.bar) : vidRoot.prepend(ui.bar));
      setupController({
        kind: "video",
        barUI: ui,
        getRoomId: getVaultVideoRoomId,
        getVideoStreams,
        onExternalStopBtnId: "videoHangupBtn",
      });
    }
  });
})();
