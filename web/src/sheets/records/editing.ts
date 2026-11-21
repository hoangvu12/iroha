import { useEffect, useState } from "react";
import { recordKey, type SheetRecord } from "../records";
import { useMaybeSheets } from "../stack";

export function useEditing(record: SheetRecord) {
  const wishes = useMaybeSheets()?.editingWishes;
  const key = recordKey(record);
  const state = useState(() => wishes?.has(key) ?? false);
  // Not in the initializer, which strict mode runs twice.
  useEffect(() => {
    wishes?.drop(key);
  }, [wishes, key]);
  return state;
}
