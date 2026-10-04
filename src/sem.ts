/**
 * Suche nach Bedeutung für lange Dateien.
 * Jede Textstelle bekommt von Cloudflares Workers AI einen Zahlenvektor (mehrsprachiges Modell bge-m3,
 * im kostenlosen Tarif enthalten, keine Einrichtung nötig). Stellen mit ähnlicher Bedeutung haben ähnliche
 * Vektoren, auch wenn sie andere Wörter benutzen. Die Vektoren liegen im Speicher (Durable Object),
 * die App schickt nur kurze Kennungen (Hash des Textes) und die Frage.
 */

export const EMBED_MODEL = '@cf/baai/bge-m3' as const;
/** Kennung einer Textstelle: Hash ihres Textes, von der App berechnet */
export const SEM_HASH_RE = /^[a-z0-9]{6,20}$/;
/** Eine Textstelle ist in der App 1800 Zeichen lang */
export const MAX_SEM_TEXT = 2500;
/** So viele Stellen auf einmal einlesen lassen */
export const SEM_ADD_MAX = 16;
/** So viele Stellen höchstens durchsuchen (etwa 50 lange Skripte) */
export const SEM_SEARCH_MAX = 6000;
/** Unbenutzte Vektoren (Datei gelöscht) nach so vielen Tagen löschen */
export const SEM_KEEP_DAYS = 120;

export interface SemEnv {
  /** Workers AI (in wrangler.toml unter [ai]) */
  AI?: Ai;
  /** Nur für lokale Tests: diese Adresse liefert die Vektoren statt Workers AI (nie in wrangler.toml) */
  EMBED_TEST_URL?: string;
}

export function semOn(env: SemEnv): boolean {
  return !!env.AI || !!env.EMBED_TEST_URL;
}

/** Vektoren für mehrere Texte, oder null, wenn es keine Suche nach Bedeutung gibt. */
export async function embed(env: SemEnv, texts: string[]): Promise<number[][] | null> {
  if (env.EMBED_TEST_URL) {
    const r = await fetch(env.EMBED_TEST_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: texts }) });
    if (!r.ok) throw new Error('embed ' + r.status);
    return ((await r.json()) as { data?: number[][] }).data ?? null;
  }
  if (!env.AI) return null;
  const out = (await env.AI.run(EMBED_MODEL, { text: texts, truncate_inputs: true })) as { data?: number[][] };
  return Array.isArray(out?.data) ? out.data : null;
}

/** Auf Länge 1 bringen. */
export function unit(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

/** In 1 Byte pro Zahl packen (ein Viertel des Speichers, die Reihenfolge der Treffer bleibt praktisch gleich). */
export function pack(v: number[]): { q: ArrayBuffer; scale: number } {
  const u = unit(v);
  let max = 0;
  for (const x of u) max = Math.max(max, Math.abs(x));
  max = max || 1;
  const q = Int8Array.from(u, (x) => Math.round((x / max) * 127));
  return { q: q.buffer, scale: max / 127 };
}

/** Ähnlichkeit (Kosinus) zwischen der Frage (Länge 1) und einer gepackten Stelle. */
export function similarity(query: Float32Array, packed: ArrayBuffer, scale: number): number {
  const v = new Int8Array(packed);
  const n = Math.min(v.length, query.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += query[i] * v[i];
  return d * scale;
}
