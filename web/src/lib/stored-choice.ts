import { useState } from "react";

/**
 * One of a few choices, remembered in this browser (`localStorage[key]`): the stored value when
 * it is one of `choices`, else `fallback`. Where storage is refused (a private window, blocked
 * site data) the choice lasts this visit only. For a view or mode the Owner picks (the Rules
 * tab's Table or Flow, the Requests feed's paging).
 */
export function useStoredChoice<T extends string>(key: string, choices: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return choices.find((c) => c === v) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const choose = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Storage refused: the choice lasts this visit only.
    }
  };
  return [value, choose] as const;
}
