document.addEventListener("DOMContentLoaded", () => {
  const exportBtn = document.getElementById("invoiceExportBtn");
  if (!exportBtn) return;

  exportBtn.addEventListener("click", async () => {
    // Grab form values
    const from = document.getElementById("invFrom")?.value || "";
    const to = document.getElementById("invTo")?.value || "";
    const number = document.getElementById("invNumber")?.value || "";
    const amountRaw = document.getElementById("invAmount")?.value || "";
    const notes = document.getElementById("invNotes")?.value || "";

    const amount = amountRaw ? parseFloat(amountRaw) : 0;

    try {
      exportBtn.disabled = true;
      const originalText = exportBtn.textContent;
      exportBtn.textContent = "Generating PDF...";

      const res = await fetch("/api/invoice/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to, number, amount, notes }),
      });

      if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = (number || "invoice") + ".pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert("Error generating invoice PDF. Check console for details.");
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "Export invoice PDF – $1.49";
    }
  });
});
