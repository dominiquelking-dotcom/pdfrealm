function triggerDownloadFromResponse(res, suggestedName) {
  return res.blob().then((blob) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName || "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  });
}

async function jsonToPdf(url, payload, filename) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Server error ${res.status}`);
  }
  await triggerDownloadFromResponse(res, filename);
}

document.addEventListener("DOMContentLoaded", () => {
  // ---------------- Invoice ----------------
  const invoiceBtn = document.getElementById("invoiceExportBtn");
  if (invoiceBtn) {
    invoiceBtn.addEventListener("click", async () => {
      const from = document.getElementById("invFrom")?.value || "";
      const to = document.getElementById("invTo")?.value || "";
      const number = document.getElementById("invNumber")?.value || "";
      const amountRaw = document.getElementById("invAmount")?.value || "";
      const notes = document.getElementById("invNotes")?.value || "";
      const amount = amountRaw ? parseFloat(amountRaw) : 0;

      try {
        invoiceBtn.disabled = true;
        invoiceBtn.textContent = "Generating invoice...";
        await jsonToPdf(
          "/api/invoice/generate",
          { from, to, number, amount, notes },
          (number || "invoice") + ".pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating invoice PDF.");
      } finally {
        invoiceBtn.disabled = false;
        invoiceBtn.textContent = "Export invoice PDF – $1.49";
      }
    });
  }

  // ---------------- Receipt ----------------
  const receiptBtn = document.getElementById("receiptExportBtn");
  if (receiptBtn) {
    receiptBtn.addEventListener("click", async () => {
      const from = document.getElementById("recFrom")?.value || "";
      const to = document.getElementById("recTo")?.value || "";
      const amountRaw = document.getElementById("recAmount")?.value || "";
      const reason = document.getElementById("recReason")?.value || "";
      const method = document.getElementById("recMethod")?.value || "";
      const amount = amountRaw ? parseFloat(amountRaw) : 0;

      try {
        receiptBtn.disabled = true;
        receiptBtn.textContent = "Generating receipt...";
        await jsonToPdf(
          "/api/receipt/generate",
          { from, to, amount, reason, method },
          "receipt.pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating receipt PDF.");
      } finally {
        receiptBtn.disabled = false;
        receiptBtn.textContent = "Export receipt PDF – $1.49";
      }
    });
  }

  // ---------------- Paystub ----------------
  const paystubBtn = document.getElementById("paystubExportBtn");
  if (paystubBtn) {
    paystubBtn.addEventListener("click", async () => {
      const employee = document.getElementById("psEmployee")?.value || "";
      const employer = document.getElementById("psEmployer")?.value || "";
      const grossRaw = document.getElementById("psGross")?.value || "";
      const dedRaw = document.getElementById("psDeductions")?.value || "";
      const period = document.getElementById("psPeriod")?.value || "";
      const gross = grossRaw ? parseFloat(grossRaw) : 0;
      const deductions = dedRaw ? parseFloat(dedRaw) : 0;

      try {
        paystubBtn.disabled = true;
        paystubBtn.textContent = "Generating paystub...";
        await jsonToPdf(
          "/api/paystub/generate",
          { employee, employer, gross, deductions, period },
          "paystub.pdf"
        );
      } catch (err) {
        console.error(err);
        alert("Error generating paystub PDF.");
      } finally {
        paystubBtn.disabled = false;
        paystubBtn.textContent = "Export paystub PDF – $1.49";
      }
    });
  }

  // ---------------- Word -> PDF ----------------
  const wordBtn = document.getElementById("wordToPdfBtn");
  if (wordBtn) {
    wordBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("w2pFile");
      const titleInput = document.getElementById("w2pTitle");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a Word file first.");
        return;
      }

      const title = titleInput?.value || "";
      const formData = new FormData();
      formData.append("file", file);
      if (title) formData.append("title", title);

      try {
        wordBtn.disabled = true;
        wordBtn.textContent = "Converting...";
        const res = await fetch("/api/convert/word-to-pdf", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const nameBase =
          (title || file.name.replace(/\.(docx?|rtf)$/i, "")) || "converted";
        await triggerDownloadFromResponse(res, nameBase + ".pdf");
      } catch (err) {
        console.error(err);
        alert("Error converting Word to PDF.");
      } finally {
        wordBtn.disabled = false;
        wordBtn.textContent = "Convert to PDF – $1.49";
      }
    });
  }

  // ---------------- PDF -> Word ----------------
  const pdfToWordBtn = document.getElementById("pdfToWordBtn");
  if (pdfToWordBtn) {
    pdfToWordBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("p2wFile");
      const titleInput = document.getElementById("p2wTitle");
      const file = fileInput?.files?.[0];

      if (!file) {
        alert("Select a PDF first.");
        return;
      }

      const formData = new FormData();
      formData.append("file", file);

      try {
        pdfToWordBtn.disabled = true;
        pdfToWordBtn.textContent = "Converting...";
        const res = await fetch("/api/convert/pdf-to-word", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const base =
          (titleInput?.value ||
            file.name.replace(/\.pdf$/i, "") ||
            "converted") + ".docx";
        await triggerDownloadFromResponse(res, base);
      } catch (err) {
        console.error(err);
        alert("Error converting PDF to Word.");
      } finally {
        pdfToWordBtn.disabled = false;
        pdfToWordBtn.textContent = "Convert to Word – $1.49";
      }
    });
  }

  // ---------------- Merge PDFs ----------------
  const mergeBtn = document.getElementById("mergePdfBtn");
  if (mergeBtn) {
    mergeBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("mergeFiles");
      const files = fileInput?.files;

      if (!files || !files.length) {
        alert("Select at least one PDF.");
        return;
      }

      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append("files", file);
      });

      try {
        mergeBtn.disabled = true;
        mergeBtn.textContent = "Merging PDFs...";
        const res = await fetch("/api/pdf/merge", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        await triggerDownloadFromResponse(res, "merged.pdf");
      } catch (err) {
        console.error(err);
        alert("Error merging PDFs.");
      } finally {
        mergeBtn.disabled = false;
        mergeBtn.textContent = "Merge & export – $1.49";
      }
    });
  }
});

