import { api, seg } from "./client";
import type { RevertResult } from "./types";

/** POST /api/audit-entries/{id}/revert: the Undo behind every toast. */
export function revertEntry(entryId: string) {
  return api.post<RevertResult>(`/api/audit-entries/${seg(entryId)}/revert`);
}
