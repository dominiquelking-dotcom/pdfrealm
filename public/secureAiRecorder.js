// PDFRealm Secure Suite: Secure AI Notes Assistant (Option A)
// WebRTC audio-only mixed recorder helper (browser)
// /PDFREALM_SECURE_AI_RECORDER_V1
(function () {
  function createMixedAudioStream(opts) {
    opts = opts || {};
    const localStream = opts.localStream || null;
    const remoteStreams = Array.isArray(opts.remoteStreams) ? opts.remoteStreams : [];
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();

    const dest = ctx.createMediaStreamDestination();

    function connectStream(stream) {
      try {
        const hasAudio = stream && stream.getAudioTracks && stream.getAudioTracks().length;
        if (!hasAudio) return;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(dest);
      } catch (e) {
        console.warn("[SecureAI] connectStream failed", e);
      }
    }

    connectStream(localStream);
    remoteStreams.forEach(connectStream);

    return { ctx, mixedStream: dest.stream, connectStream };
  }

  function pickSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];
    for (const t of candidates) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
      } catch (_) {}
    }
    return "";
  }

  async function startRecording(opts) {
    opts = opts || {};
    const sessionId = opts.sessionId;
    const localStream = opts.localStream;
    const getRemoteStreams = typeof opts.getRemoteStreams === "function" ? opts.getRemoteStreams : () => [];
    const uploadChunk = typeof opts.uploadChunk === "function" ? opts.uploadChunk : null;
    const onState = typeof opts.onState === "function" ? opts.onState : null;
    const timesliceMs = Number.isFinite(opts.timesliceMs) ? opts.timesliceMs : 3000;

    if (!sessionId) throw new Error("Missing sessionId");
    if (!localStream) throw new Error("Missing localStream");
    if (!uploadChunk) throw new Error("Missing uploadChunk callback");

    const mix = createMixedAudioStream({
      localStream,
      remoteStreams: getRemoteStreams()
    });

    // Some browsers start AudioContext suspended until a user gesture.
    try { await mix.ctx.resume(); } catch (_) {}

    const mimeType = pickSupportedMimeType();
    const recorder = new MediaRecorder(mix.mixedStream, mimeType ? { mimeType } : undefined);

    let stopped = false;
    let seq = 0;

    recorder.ondataavailable = async (ev) => {
      if (stopped) return;
      if (!ev.data || !ev.data.size) return;
      try {
        await uploadChunk(seq++, ev.data, recorder.mimeType || mimeType || "audio/webm");
        onState && onState({ phase: "UPLOADING", seq });
      } catch (e) {
        onState && onState({ phase: "ERROR", error: e });
      }
    };

    recorder.onstart = () => onState && onState({ phase: "RECORDING" });
    recorder.onstop = () => onState && onState({ phase: "STOPPED" });

    recorder.start(timesliceMs);

    function addRemoteStream(stream) {
      mix.connectStream(stream);
    }

    async function stop() {
      try {
        stopped = true;
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch (_) {}
      try { await mix.ctx.close(); } catch (_) {}
    }

    return { recorder, ctx: mix.ctx, addRemoteStream, stop };
  }

  window.SecureAiRecorder = {
    createMixedAudioStream,
    pickSupportedMimeType,
    startRecording
  };
})();
