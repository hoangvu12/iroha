export type JsonObject = Record<string, unknown>;

export const asObject = (v: unknown): JsonObject | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : undefined);
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string => (typeof v === "string" ? v : "");
export const stringOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
export const optionalString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const numberOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
