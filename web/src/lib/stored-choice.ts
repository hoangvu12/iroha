import { useState } from "react";

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
    } catch {}
  };
  return [value, choose] as const;
}
