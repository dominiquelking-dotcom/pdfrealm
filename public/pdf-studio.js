// public/pdf-studio.js

// Set up PDF.js worker (required)
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.js";
}

const PDFStudio = (() => {
  let pdfDoc = null;
  let currentPage = 1;
  let scale = 1.1;

  const els = {};

  function cacheEls() {
    els.uploadInput = document.getElementById("pdfStudioUploadInput");
    els.templateBtn = document.getElementById("pdfStudioTemplateBtn");
    els.filename = document.getElementById("pdfStudioFilename");
    els.pageInfo = document.getElementById("pdfStudioPageInfo");
    els.zoomIn = document.getElementById("pdfStudioZoomInBtn");
    els.zoomOut = document.getElementById("pdfStudioZoomOutBtn");
    els.downloadBtn = document.getElementById("pdfStudioDownloadBtn");
    els.thumbs = document.getElementById("pdfStudioThumbs");
    els.canvasContainer = document.getElementById("pdfStudioCanvasContainer");
    els.tools = document.getElementById("pdfStudioTools");
  }

  function bindEvents() {
    if (!els.uploadInput) return;

    els.uploadInput.addEventListener("change", handleFileUpload);
    els.zoomIn.addEventListener("click", () => changeZoom(0.1));
    els.zoomOut.addEventListener("click", () => changeZoom(-0.1));
    els.downloadBtn.addEventListener("click", handleDownload);
    els.templateBtn.addEventListener("click", openTemplateDrawerPlaceholder);

    // Tool buttons – just visual mode toggle for now
    if (els.tools) {
      els.tools.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-tool-mode]");
        if (!btn) return;
        setActiveTool(btn.dataset.toolMode);
      });
    }
  }

  function setActiveTool(mode) {
    const buttons = els.tools.querySelectorAll("[data-tool-mode]");
    buttons.forEach((b) => b.classList.remove("tool-active"));

    const active = els.tools.querySelector(`[data-tool-mode="${mode}"]`);
    if (active) active.classList.add("tool-active");

    // TODO: hook this up to annotation logic
    console.log("PDF Studio tool mode:", mode);
  }

  function openTemplateDrawerPlaceholder() {
    alert(
      "Template library coming soon.\n\n" +
      "Plan: integrate US legal forms and freight-specific templates here."
    );
  }

  function handleFileUpload() {
    const file = els.uploadInput.files[0];
    if (!file) return;

    els.filename.textContent = file.name;
    els.pageInfo.textContent = "Loading…";

    const reader = new FileReader();
    reader.onload = function (e) {
      const typedArray = new Uint8Array(e.target.result);
      loadPdfFromArrayBuffer(typedArray);
    };
    reader.readAsArrayBuffer(file);
  }

  async function loadPdfFromArrayBuffer(buffer) {
    try {
      pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      currentPage = 1;
      els.pageInfo.textContent = `Page 1 of ${pdfDoc.numPages}`;
      renderAllThumbnails();
      renderPage(currentPage);
    } catch (err) {
      console.error("Failed to load PDF:", err);
      els.pageInfo.textContent = "Error loading PDF";
    }
  }

  async function renderPage(pageNum) {
    if (!pdfDoc) return;

    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // Clear current content
    els.canvasContainer.innerHTML = "";

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = "pdfstudio-page-canvas";

    els.canvasContainer.appendChild(canvas);

    const renderContext = {
      canvasContext: context,
      viewport: viewport,
    };

    await page.render(renderContext).promise;

    // TODO: add overlay layer for annotations
  }

  async function renderAllThumbnails() {
    els.thumbs.innerHTML = "";

    if (!pdfDoc) {
      const empty = document.createElement("div");
      empty.className = "pdfstudio-sidebar-empty";
      empty.innerHTML = "<p>No pages yet.</p>";
      els.thumbs.appendChild(empty);
      return;
    }

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 0.2 });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = "pdfstudio-thumb-canvas";
      canvas.dataset.pageNum = i;

      const thumbWrapper = document.createElement("div");
      thumbWrapper.className = "pdfstudio-thumb";
      thumbWrapper.appendChild(canvas);

      thumbWrapper.addEventListener("click", () => {
        currentPage = i;
        els.pageInfo.textContent = `Page ${currentPage} of ${pdfDoc.numPages}`;
        renderPage(currentPage);
      });

      els.thumbs.appendChild(thumbWrapper);

      const renderContext = {
        canvasContext: context,
        viewport,
      };
      page.render(renderContext);
    }
  }

  function changeZoom(delta) {
    if (!pdfDoc) return;
    scale = Math.max(0.3, Math.min(3, scale + delta));
    renderPage(currentPage);
  }

  function handleDownload() {
    if (!pdfDoc) {
      alert("No PDF loaded yet.");
      return;
    }

    // v1: just tell them to use the original for now
    // Later: we’ll export edited PDF using pdf-lib.
    alert(
      "Export of edited PDFs is coming in the next step.\n\n" +
      "For now, PDF Studio is a fast viewer + page navigator."
    );
  }

  function init() {
    cacheEls();
    if (!els.uploadInput) {
      // Pdf Studio view might not be on this page
      return;
    }
    bindEvents();
    console.log("PDF Studio initialized");
  }

  return { init };
})();

// Auto-init when DOM is ready
(function () {
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }
  onReady(() => PDFStudio.init());
})();
