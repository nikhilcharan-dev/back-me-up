import { requireAuth } from "../auth.js";
import { baseViewContext } from "../viewContext.js";
import { findRestoreJobById } from "../../repositories/restoresRepo.js";
import { setFlash } from "../flash.js";

export default async function restoreStatusRoutes(app) {
  app.get("/restores/:id", { preHandler: requireAuth }, async (request, reply) => {
    const job = await findRestoreJobById(request.params.id);
    if (!job) {
      setFlash(request, "error", "Restore job not found.");
      return reply.redirect("/");
    }
    return reply.view("restore-status.ejs", {
      ...(await baseViewContext(request, reply)),
      title: "Restore status",
      job,
    });
  });
}
