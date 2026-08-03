// Display helpers shared by the EJS templates (exposed as locals via viewContext).

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-US");
}

// Renders a duration given in seconds as the coarsest one or two units that make
// it readable — "3d 4h" rather than "277200s" — for ages and lags on the metrics
// page. Negative/invalid input (a metric that hasn't been set yet) is "—".
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds)) || seconds < 0) return "—";
  const s = Math.floor(Number(seconds));
  if (s < 60) return `${s}s`;

  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  const parts = [];
  let remaining = s;
  for (const [label, size] of units) {
    if (remaining >= size) {
      parts.push(`${Math.floor(remaining / size)}${label}`);
      remaining %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}
