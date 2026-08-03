// The backup-schedule field is a cron expression, which is the one thing on the
// registration form that assumes prior knowledge. These presets cover what almost
// every registration actually wants; "custom" is the escape hatch back to raw cron.
// The stored value is always a cron expression — the presets only build it.
//
// This list is the single source of truth: partials/schedule-field.ejs renders each
// preset's `cron` and `description` templates into data attributes, and app.js only
// substitutes {placeholders} from the form's controls. Adding a preset means adding
// a row here and nothing else.
export const SCHEDULE_PRESETS = [
  {
    value: "none",
    label: "Manual only — no automatic backups",
    cron: "",
    description: "No automatic backups — you run them yourself from the database page.",
    shortLabel: "Manual only",
  },
  {
    value: "hourly",
    label: "Every hour",
    cron: "0 * * * *",
    description: "Runs at the top of every hour.",
    shortLabel: "Every hour",
  },
  {
    value: "every6",
    label: "Every 6 hours",
    cron: "0 */6 * * *",
    description: "Runs every 6 hours — 00:00, 06:00, 12:00 and 18:00.",
    shortLabel: "Every 6 hours",
  },
  {
    value: "every12",
    label: "Every 12 hours",
    cron: "0 */12 * * *",
    description: "Runs every 12 hours — 00:00 and 12:00.",
    shortLabel: "Every 12 hours",
  },
  {
    value: "daily",
    label: "Every day",
    cron: "{minute} {hour} * * *",
    description: "Runs every day at {time}.",
    shortLabel: "Every day at {time}",
    needsTime: true,
  },
  {
    value: "weekly",
    label: "Every week",
    cron: "{minute} {hour} * * {weekday}",
    description: "Runs every {weekdayName} at {time}.",
    shortLabel: "Every {weekdayName} at {time}",
    needsTime: true,
    needsWeekday: true,
  },
  {
    // cron: null means "leave whatever is typed alone".
    value: "custom",
    label: "Custom cron expression",
    cron: null,
    description: "Runs on this cron expression:",
    shortLabel: null,
  },
];

export const WEEKDAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

const DEFAULT_TIME = "02:00";
const DEFAULT_WEEKDAY = "0";

const pad = (n) => String(n).padStart(2, "0");

export function findPreset(value) {
  return SCHEDULE_PRESETS.find((p) => p.value === value) ?? null;
}

// Fills a preset's cron template — the same substitution app.js does in the browser,
// exposed here so the round-trip with parseSchedule() below is testable server-side.
export function buildCron(presetValue, { time = DEFAULT_TIME, weekday = DEFAULT_WEEKDAY } = {}) {
  const preset = findPreset(presetValue);
  if (!preset || preset.cron === null) return null;
  const [hour, minute] = time.split(":").map(Number);
  return preset.cron
    .replace("{minute}", String(minute))
    .replace("{hour}", String(hour))
    .replace("{weekday}", String(weekday));
}

// Maps a stored cron expression back onto the preset controls, so opening the form
// shows what's actually configured instead of defaulting to "custom" every time.
// Anything the presets can't express round-trips as custom, untouched.
export function parseSchedule(cronExpr) {
  const expr = (cronExpr ?? "").toString().trim();
  const base = { preset: "custom", time: DEFAULT_TIME, weekday: DEFAULT_WEEKDAY, cron: expr };

  if (!expr) return { ...base, preset: "none" };
  if (expr === "0 * * * *") return { ...base, preset: "hourly" };
  if (expr === "0 */6 * * *") return { ...base, preset: "every6" };
  if (expr === "0 */12 * * *") return { ...base, preset: "every12" };

  const atTime = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|\d)$/);
  if (atTime) {
    const [, minute, hour, day] = atTime;
    if (Number(minute) > 59 || Number(hour) > 23) return base;
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    return day === "*"
      ? { ...base, preset: "daily", time }
      : { ...base, preset: "weekly", time, weekday: day };
  }

  return base;
}

// Plain-English reading of a stored cron expression for display (the database page
// shows this by default, with a toggle back to the raw expression). Recognized
// presets get their short label filled in; anything else — a hand-written
// expression the presets can't express — reads as "Custom schedule" rather than
// guessing at a description for arbitrary cron syntax.
export function describeCron(cronExpr) {
  const parsed = parseSchedule(cronExpr);
  if (parsed.preset === "custom") return "Custom schedule";

  const preset = findPreset(parsed.preset);
  const weekdayName = WEEKDAYS.find((d) => d.value === parsed.weekday)?.label ?? "";
  return preset.shortLabel.replace("{time}", parsed.time).replace("{weekdayName}", weekdayName);
}

// node-cron fires in the process's local timezone, so a preset time means server
// time — worth saying out loud, since the restore form works in browser time.
export function serverTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "the server's local time";
  } catch {
    return "the server's local time";
  }
}
