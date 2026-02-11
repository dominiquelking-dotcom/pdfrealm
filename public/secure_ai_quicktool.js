
(() => {
  function $(id) {
    return document.getElementById(id);
  }

  function pickMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ];
    for (const t of candidates) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
      } catch {}
    }
    return "";
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  async function blobToFile(blob, filename) {
    return new File([blob], filename, { type: blob.type || "application/octet-stream" });
  }

  window.addEventListener("DOMContentLoaded", () => {
    const recordBtn = $("qtAiNotesRecordBtn");
    const stopBtn = $("qtAiNotesStopBtn");
    const generateBtn = $("qtAiNotesGenerateBtn");
    const downloadBtn = $("qtAiNotesDownloadBtn");
    const fileInput = $("qtAiNotesAudioFile");
    const statusEl = $("qtAiNotesStatus");
    const timerEl = $("qtAiNotesTimer");
    const langEl = $("qtAiNotesLanguage");
    const includeTranscriptEl = $("qtAiNotesIncludeTranscript");
    const debugEl = $("qtAiNotesDebug");

    if (!recordBtn || !stopBtn || !generateBtn) return;

    let mediaStream = null;
    let recorder = null;
    let chunks = [];
    let recordedBlob = null;
    let recordedMime = "";
    let timerStart = 0;
    let timerHandle = null;
    let selectedFile = null;
    let downloadUrl = null;

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg || "";
    }

    function setDebug(obj) {
      if (!debugEl) return;
      if (!obj) {
        debugEl.textContent = "";
        return;
      }
      try {
        debugEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      } catch {
        debugEl.textContent = String(obj);
      }
    }

    function setTimerRunning(running) {
      if (!timerEl) return;
      if (!running) {
        timerEl.textContent = "00:00";
        if (timerHandle) clearInterval(timerHandle);
        timerHandle = null;
        return;
      }
      timerStart = Date.now();
      timerEl.textContent = "00:00";
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = setInterval(() => {
        timerEl.textContent = fmtTime(Date.now() - timerStart);
      }, 250);
    }

    function resetDownload() {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
      if (downloadBtn) {
        downloadBtn.style.display = "none";
        downloadBtn.href = "#";
        downloadBtn.removeAttribute("download");
      }
    }

    function updateGenerateEnabled() {
      const hasAudio = !!selectedFile || !!recordedBlob;
      generateBtn.disabled = !hasAudio;
    }

    recordBtn.addEventListener("click", async () => {
      resetDownload();
      setDebug(null);
      setStatus("");

      try {
        selectedFile = null;
        if (fileInput) fileInput.value = "";

        recordedBlob = null;
        chunks = [];

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setStatus("Microphone recording is not supported in this browser.");
          return;
        }

        const mime = pickMimeType();
        recordedMime = mime || "";
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

        recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size) chunks.push(ev.data);
        };

        recorder.onstop = async () => {
          try {
            recordedBlob = new Blob(chunks, { type: recordedMime || chunks?.[0]?.type || "audio/webm" });
            setStatus(`Recorded ${Math.round(recordedBlob.size / 1024)} KB.`);
            updateGenerateEnabled();
          } catch (e) {
            console.error(e);
            setStatus("Failed to finalize recording.");
          }
        };

        recorder.start(1000); // 1s chunks (client-side; server will get a single file on generate)
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        setTimerRunning(true);
        setStatus("Recording…");
        updateGenerateEnabled();
      } catch (e) {
        console.error(e);
        setStatus("Could not start recording. Check mic permissions.");
        try {
          if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
        } catch {}
        mediaStream = null;
        recorder = null;
        recordBtn.disabled = false;
        stopBtn.disabled = true;
        setTimerRunning(false);
      }
    });

    stopBtn.addEventListener("click", async () => {
      try {
        stopBtn.disabled = true;
        recordBtn.disabled = false;
        setTimerRunning(false);

        if (recorder && recorder.state !== "inactive") recorder.stop();
        if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
        recorder = null;

        setStatus("Recording stopped.");
        updateGenerateEnabled();
      } catch (e) {
        console.error(e);
        setStatus("Failed to stop recording.");
      }
    });

    if (fileInput) {
      fileInput.addEventListener("change", () => {
        resetDownload();
        setDebug(null);
        const f = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        selectedFile = f;
        if (f) {
          recordedBlob = null;
          setStatus(`Selected: ${f.name} (${Math.round(f.size / 1024)} KB)`);
        } else {
          setStatus("");
        }
        updateGenerateEnabled();
      });
    }

    generateBtn.addEventListener("click", async () => {
      resetDownload();
      setDebug(null);

      try {
        generateBtn.disabled = true;
        setStatus("Uploading…");

        const language = langEl && langEl.value ? String(langEl.value).trim() : "";
        const includeTranscript = includeTranscriptEl && includeTranscriptEl.checked;

        let audioFile = selectedFile;
        if (!audioFile && recordedBlob) {
          const t = (recordedBlob.type || "");
          const ext = t.includes("ogg") ? "ogg" : t.includes("mp4") ? "mp4" : "webm";
          audioFile = await blobToFile(recordedBlob, `recording.${ext}`);
        }

        if (!audioFile) {
          setStatus("Please record or upload audio first.");
          generateBtn.disabled = false;
          return;
        }

        const form = new FormData();
        form.append("audio", audioFile, audioFile.name || "audio");
        if (language) form.append("language", language);
        form.append("includeTranscript", includeTranscript ? "true" : "false");

        const resp = await fetch("/api/secure-ai/quick/report", {
          method: "POST",
          body: form,
          credentials: "include",
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          setStatus(`Failed: ${resp.status}`);
          setDebug(txt || null);
          generateBtn.disabled = false;
          return;
        }

        const blob = await resp.blob();
        downloadUrl = URL.createObjectURL(blob);

        const cd = resp.headers.get("content-disposition") || "";
        const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
        const filename = m && m[1] ? m[1] : `conversation_report_${Date.now()}.pdf`;

        if (downloadBtn) {
          downloadBtn.href = downloadUrl;
          downloadBtn.download = filename;
          downloadBtn.style.display = "inline-flex";
        }

        setStatus("Ready. Click Download PDF.");
      } catch (e) {
        console.error(e);
        setStatus("Error generating report.");
        setDebug(String(e));
      } finally {
        updateGenerateEnabled();
        generateBtn.disabled = false; // allow regenerating
      }
    });

    // Initialize state
    updateGenerateEnabled();
    setStatus("");
  });
})();
