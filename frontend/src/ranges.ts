export type Range = "1h" | "6h" | "24h" | "7d" | "30d";

export const RANGES: { value: Range; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export const isLong = (r: Range) => r === "7d" || r === "30d";

export type HistoryRow = Record<string, number | null>;
