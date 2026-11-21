import { api, seg } from "./client";
import type { RevertResult } from "./types";

export function revertEntry(entryId: string) {
  return api.post<RevertResult>(`/api/audit-entries/${seg(entryId)}/revert`);
}
