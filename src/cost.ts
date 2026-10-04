/**
 * KI-Kosten: Preise pro Modell und das Datum, an dem das Tageslimit neu beginnt.
 * Gebraucht vom Worker (Antworten im Stream) und vom Speicher (Sammelaufträge).
 */

/** Preise in US-Dollar pro 1 Million Tokens: Eingabe, Ausgabe, Cache schreiben (5 Minuten), Cache lesen. 1 Stunde schreiben kostet das Doppelte der Eingabe. */
export const PRICES: [RegExp, number, number, number, number][] = [
  [/opus-5-5/, 4, 20, 5, 0.2],
  [/opus/, 5, 25, 6.25, 0.5],
  [/sonnet/, 2, 10, 2.5, 0.2],
  [/haiku/, 1, 5, 1.25, 0.1],
  [/fable|mythos/, 10, 50, 12.5, 1],
];

export interface UsageSum {
  input: number;
  output: number;
  /** In den Zwischenspeicher geschrieben, alles zusammen (5 Minuten und 1 Stunde) */
  cacheWrite: number;
  /** Davon für 1 Stunde geschrieben */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

export function emptyUsage(): UsageSum {
  return { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/** Verbrauch aus einer Antwort übernehmen (bei Stream-Ereignissen zählt jeweils der höchste Stand). */
export function takeUsage(sum: UsageSum, u: RawUsage | null | undefined): void {
  if (!u) return;
  sum.input = Math.max(sum.input, u.input_tokens || 0);
  sum.output = Math.max(sum.output, u.output_tokens || 0);
  sum.cacheWrite = Math.max(sum.cacheWrite, u.cache_creation_input_tokens || 0);
  sum.cacheWrite1h = Math.max(sum.cacheWrite1h, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  sum.cacheRead = Math.max(sum.cacheRead, u.cache_read_input_tokens || 0);
}

/** Kosten in US-Dollar. factor 0.5 für Sammelaufträge (halber Preis). */
export function costUsd(model: string, u: UsageSum, factor = 1): number {
  const p = PRICES.find(([re]) => re.test(model)) ?? PRICES[1];
  const w1h = Math.min(u.cacheWrite1h, u.cacheWrite);
  return ((u.input * p[1] + u.output * p[2] + (u.cacheWrite - w1h) * p[3] + w1h * p[1] * 2 + u.cacheRead * p[4]) / 1_000_000) * factor;
}

/** Heutiges Datum in Deutschland, z. B. 2026-10-01 (dann beginnt das Tageslimit neu). */
export function berlinDay(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}
