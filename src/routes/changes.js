import { listChangeSlicesForDb } from "../repositories/changeSlicesRepo.js";

export default async function changeRoutes(app) {
  app.get("/api/databases/:id/changes", async (request) => {
    return listChangeSlicesForDb(request.params.id);
  });
}
