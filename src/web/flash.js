// Session-based flash message for the POST-redirect-GET pattern used by every
// form in this app: set before redirecting, read-and-clear on the next render.
export function setFlash(request, type, message) {
  request.session.set("flash", { type, message });
}

export function popFlash(request) {
  const flash = request.session.get("flash");
  if (flash) request.session.set("flash", null);
  return flash ?? null;
}
