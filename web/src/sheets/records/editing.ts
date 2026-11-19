import { useEffect, useState } from "react";
import { recordKey, type SheetRecord } from "../records";

// A row menu's "Edit…" opens a record's sheet on its fields (UI ticket 27).
// The wish is not part of the URL (a shared link opens the sheet to read);
// the sheet takes it when it first shows the record.

const wished = new Set<string>();

/** The next sheet to show `record` starts on its fields. */
export function startEditing(record: SheetRecord) {
  wished.add(recordKey(record));
}

/** `[editing, setEditing]` for a sheet showing `record`, starting on its fields when `startEditing` asked for it. */
export function useEditing(record: SheetRecord) {
  const key = recordKey(record);
  const state = useState(() => wished.has(key));
  // Answered once (here, not in the initializer, which strict mode runs twice).
  useEffect(() => {
    wished.delete(key);
  }, [key]);
  return state;
}
