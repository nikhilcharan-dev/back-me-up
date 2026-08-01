import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";

// Used by retention pruning to remove a base dump directory or a change slice
// file once no retained backup can still need it.
export async function deleteStorageKey(storageKey) {
  const target = path.join(config.storageRoot, storageKey);
  await fs.rm(target, { recursive: true, force: true });
}
