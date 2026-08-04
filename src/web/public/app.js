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

// Schedule builder (partials/schedule-field.ejs): turns plain-language presets into
// the cron expression the server stores, so scheduling a backup doesn't require
// knowing cron syntax. Each <option> carries its own cron and description template
// (src/web/schedulePresets.js owns the list); all this does is substitute the
// {placeholders} from the time/weekday controls. The cron text input is the only
// field that submits, so an expression the presets can't express — chosen via
// "Custom" — round-trips untouched.
document.querySelectorAll("[data-schedule-builder]").forEach((root) => {
  const preset = root.querySelector("[data-schedule-preset]");
  const cron = root.querySelector("[data-schedule-cron]");
  if (!preset || !cron) return;

  const timePart = root.querySelector("[data-schedule-when]");
  const time = root.querySelector("[data-schedule-time]");
  const dayPart = root.querySelector("[data-schedule-weekday]");
  const day = root.querySelector("[data-schedule-weekday-select]");
  const customPart = root.querySelector("[data-schedule-custom]");
  const tzNote = root.querySelector("[data-schedule-tz]");
  const summary = root.querySelector("[data-schedule-summary]");
  const expr = root.querySelector("[data-schedule-expr]");

  const fill = (template) => {
    const at = time.value || "02:00";
    const [hour, minute] = at.split(":").map(Number);
    const values = {
      minute,
      hour,
      time: at,
      weekday: day.value,
      weekdayName: day.selectedOptions[0].textContent,
    };
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
  };

  const sync = () => {
    const option = preset.selectedOptions[0];
    const showTime = option.dataset.needsTime === "true";

    timePart.hidden = !showTime;
    dayPart.hidden = option.dataset.needsWeekday !== "true";
    customPart.hidden = option.dataset.hasCron === "true";
    tzNote.hidden = !showTime;

    const generated = option.dataset.hasCron === "true";
    if (generated) cron.value = fill(option.dataset.cron);

    // The only empty-handed state is "Custom" with nothing typed yet.
    summary.textContent =
      generated || cron.value.trim()
        ? fill(option.dataset.description)
        : "Enter a cron expression, or pick a preset above.";
    expr.textContent = cron.value.trim();
  };

  preset.addEventListener("change", sync);
  time.addEventListener("change", sync);
  day.addEventListener("change", sync);
  cron.addEventListener("input", sync);
  sync();
});

// Bottom-right VM clock (partials/foot.ejs). Seeded from the server's own
// Date.now() at render time — not the browser's clock — since the point is
// showing the time schedules actually fire in (node-cron runs in server-local
// time; see the schedule builder's "server time" note). Ticks forward
// client-side afterward using a monotonic clock (performance.now()) rather than
// counting setInterval firings, so it doesn't drift if the tab is backgrounded.
(function () {
  const clock = document.getElementById("server-clock");
  const valueEl = document.getElementById("server-clock-value");
  if (!clock || !valueEl) return;

  const epoch0 = Number(clock.dataset.epoch);
  const perfStart = performance.now();
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const tick = () => {
    valueEl.textContent = formatter.format(new Date(epoch0 + (performance.now() - perfStart)));
  };
  tick();
  setInterval(tick, 1000);
})();

// Database page: toggle the Schedule stat between its plain-English reading
// (default) and the raw cron expression it compiles to.
document.querySelectorAll("[data-toggle-schedule-display]").forEach((button) => {
  const stat = button.closest("[data-schedule-stat]");
  const words = stat.querySelector("[data-schedule-words]");
  const cronEl = stat.querySelector("[data-schedule-cron]");
  button.addEventListener("click", () => {
    const showCron = cronEl.hidden;
    words.hidden = showCron;
    cronEl.hidden = !showCron;
    button.textContent = showCron ? "Show words" : "Show cron";
  });
});

// Retention form (database-detail.ejs): lets the user check the impact of
// whatever hourly/daily/weekly values are currently typed — before saving —
// by asking the server to run the same keep-set math as a dry run.
document.querySelectorAll("[data-retention-preview-btn]").forEach((button) => {
  const form = button.closest("[data-retention-form]");
  const resultEl = form && form.querySelector("[data-retention-preview-result]");
  if (!form || !resultEl) return;

  button.addEventListener("click", () => {
    resultEl.textContent = "Checking…";
    fetch(form.dataset.previewUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          resultEl.textContent = data.error || "Could not compute preview.";
          return;
        }
        resultEl.textContent =
          data.prunedBases === 0 && data.prunedSlices === 0
            ? "This policy would not remove anything right now."
            : `Would remove ${data.prunedBases} of ${data.totalBases} backup(s) and ${data.prunedSlices} change slice(s), keeping ${data.keptBases}.`;
      })
      .catch(() => {
        resultEl.textContent = "Could not compute preview.";
      });
  });
});

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
      const infoIcon = (text) => `<span class="info-icon" title="${text}" tabindex="0" aria-label="${text}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><line x1="8" y1="7.5" x2="8" y2="11.5"></line><line x1="8" y1="4.5" x2="8.01" y2="4.5"></line></svg></span>`;
      resultEl.innerHTML = `
        <h3>Verification${infoIcon("Document/row counts in the restored target, compared against what capture and the base backup expected to find there.")}</h3>
        <p>${v.ok ? "Counts match expected." : "Counts diverged from expected — inspect before trusting this restore."}</p>
        <pre class="mono">${JSON.stringify(v, null, 2)}</pre>
        ${job.replayStats ? `<h3>Replay${infoIcon("Stats from replaying captured change events on top of the base backup to reach the requested point in time.")}</h3><pre class="mono">${JSON.stringify(job.replayStats, null, 2)}</pre>` : ""}
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
