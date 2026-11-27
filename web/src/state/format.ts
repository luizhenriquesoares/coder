import type { Language } from "../../../src/domain/deliberation/model.js";

const LOCALE: Record<Language, string> = { en: "en-US", pt: "pt-BR" };

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function formatClock(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(LOCALE[language], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function relativeTime(iso: string, language: Language, now: number = Date.now()): string {
  const formatter = new Intl.RelativeTimeFormat(LOCALE[language], { numeric: "auto", style: "short" });
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
