// Confirm before destructive form submissions (data-confirm="...")
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
    e.preventDefault();
  }
});

// Restore form: toggle between point-in-time and specific-snapshot mode, and
// convert the datetime-local value (browser-local time, no timezone info) to a
// proper ISO instant before submit — submitting the raw value would have Node
// parse it as *server*-local time, silently shifting the restore point if the
// browser and server are in different timezones.
window.toggleRestoreMode = function () {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const pitr = document.getElementById("pitr-fields");
  const base = document.getElementById("base-fields");
  if (pitr) pitr.style.display = mode === "pitr" ? "" : "none";
  if (base) base.style.display = mode === "base" ? "" : "none";
};

const restoreForm = document.getElementById("restore-form");
if (restoreForm) {
  restoreForm.addEventListener("submit", (e) => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    if (mode === "pitr") {
      const localVal = document.getElementById("targetTimestampLocal").value;
      if (!localVal) {
        e.preventDefault();
        window.alert("Pick a restore timestamp.");
        return;
      }
      document.getElementById("targetTimestampIso").value = new Date(localVal).toISOString();
    }
  });
}

// Backup browser: copy a rendered document's JSON (data-copy-from="<element id>").
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-copy-from]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copyFrom);
  if (!source || !navigator.clipboard) return;
  navigator.clipboard.writeText(source.textContent).then(() => {
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  });
});

// Client-side row filter for long tables (data-filter-rows="<table selector>").
document.addEventListener("input", (e) => {
  const input = e.target.closest("[data-filter-rows]");
  if (!input) return;
  const table = document.querySelector(input.dataset.filterRows);
  if (!table) return;
  const needle = input.value.trim().toLowerCase();
  table.querySelectorAll("tbody tr").forEach((row) => {
    row.style.display = !needle || row.textContent.toLowerCase().includes(needle) ? "" : "none";
  });
});

// Restore status polling (restore-status.ejs sets window.__restoreId + __restoreDone)
if (window.__restoreId && !window.__restoreDone) {
  const statusEl = document.getElementById("restore-status");
  const resultEl = document.getElementById("restore-result");

  const renderJob = (job) => {
    if (statusEl) statusEl.innerHTML = `<span class="badge ${job.status}">${job.status}</span>`;
    if (resultEl && (job.status === "completed" || job.status === "failed")) {
      const v = job.verification || {};
      resultEl.innerHTML = `
        <h3>Verification</h3>
        <p>${v.ok ? "Counts match expected." : "Counts diverged from expected — inspect before trusting this restore."}</p>
        <pre class="mono">${JSON.stringify(v, null, 2)}</pre>
        ${job.replayStats ? `<h3>Replay</h3><pre class="mono">${JSON.stringify(job.replayStats, null, 2)}</pre>` : ""}
      `;
    }
    return job.status === "completed" || job.status === "failed";
  };

  const poll = () => {
    fetch(`/api/restores/${window.__restoreId}`)
      .then((res) => res.json())
      .then((job) => {
        if (!renderJob(job)) setTimeout(poll, 2000);
      })
      .catch(() => setTimeout(poll, 4000));
  };

  poll();
}
