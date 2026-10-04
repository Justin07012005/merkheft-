/**
 * Vorlesungen: Aufnahmen (Sprachmemos vom iPhone, m4a) in Stücke teilen und mitschreiben lassen.
 *
 * Die Spracherkennung (Whisper bei Cloudflare Workers AI, im kostenlosen Tarif enthalten) liest Stücke von
 * etwa 1 MB. Eine m4a-Datei kann man aber nicht einfach zerschneiden: Wo welcher Ton steht, steht in einem
 * Inhaltsverzeichnis (moov). Darum werden die Tonstücke (AAC) einzeln herausgeholt und mit einem kleinen
 * Kopf (ADTS) versehen. So ist jedes Stück für sich lesbar. MP3 und AAC-Dateien werden an Rahmengrenzen geteilt.
 */

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
/** Ein Stück für die Spracherkennung (Cloudflares Beispiel nimmt 1 MB) */
export const PIECE_BYTES = 1_000_000;
/** Höchstens so lang ist ein Stück (dann stimmen auch die Zeitangaben gut) */
export const PIECE_SECS = 180;

export class AudioError extends Error {}

/** Liest Bytes aus der gespeicherten Aufnahme (liegt in Stücken im Speicher). */
export interface Source {
  size: number;
  read(off: number, len: number): Uint8Array;
}

export interface Piece {
  /** Beginn in Sekunden ab Anfang der Aufnahme */
  start: number;
  secs: number;
  data: Uint8Array;
}

export type AudioKind = 'mp4' | 'mp3' | 'adts' | '';

export function detect(head: Uint8Array): AudioKind {
  const s = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
  if (head.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(s(4, 8))) return 'mp4';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'adts';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ((head[1] >> 1) & 3) !== 0) return 'mp3';
  return '';
}

/** Teilt die Aufnahme. Ruft add für jedes fertige Stück auf und gibt die Gesamtlänge in Sekunden zurück. */
export function split(src: Source, add: (p: Piece) => void): number {
  const kind = detect(src.read(0, Math.min(16, src.size)));
  if (kind === 'mp4') return splitMp4(src, add);
  if (kind === 'mp3') return splitMp3(src, add);
  if (kind === 'adts') return splitAdts(src, add);
  throw new AudioError('Dieses Format kann Merki nicht lesen. Nimm am besten mit der App Sprachmemos auf (m4a), MP3 geht auch.');
}

/** Sammelt Rahmen zu Stücken von höchstens PIECE_BYTES und PIECE_SECS. */
function pieces(add: (p: Piece) => void) {
  let frames: Uint8Array[] = [], bytes = 0, start = 0, secs = 0;
  const flush = () => {
    if (!frames.length) return;
    const data = new Uint8Array(bytes);
    let o = 0;
    for (const f of frames) {
      data.set(f, o);
      o += f.length;
    }
    add({ start, secs, data });
    start += secs;
    frames = [];
    bytes = 0;
    secs = 0;
  };
  return {
    push(frame: Uint8Array, dur: number) {
      if (frames.length && (bytes + frame.length > PIECE_BYTES || secs + dur > PIECE_SECS)) flush();
      frames.push(frame);
      bytes += frame.length;
      secs += dur;
    },
    end(): number {
      flush();
      return start;
    },
  };
}

// ---------- m4a / mp4 ----------

const FREQS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface Box {
  type: string;
  start: number;
  end: number;
}

function* boxes(v: DataView, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
    let hdr = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(o + 8));
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, start: o + hdr, end: o + size };
    o += size;
  }
}

const child = (v: DataView, b: Box, type: string, skip = 0): Box | undefined => {
  for (const c of boxes(v, b.start + skip, b.end)) if (c.type === type) return c;
  return undefined;
};

/** Das Inhaltsverzeichnis (moov) finden und ganz lesen. Es steht bei Sprachmemos meist am Ende. */
function readMoov(src: Source): DataView {
  let o = 0;
  while (o + 8 <= src.size) {
    const h = src.read(o, Math.min(16, src.size - o));
    const v = new DataView(h.buffer, h.byteOffset, h.length);
    let size = v.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1 && h.length >= 16) size = Number(v.getBigUint64(8));
    else if (size === 0) size = src.size - o;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 32 * 1024 * 1024) break;
      const m = src.read(o, Math.min(size, src.size - o));
      return new DataView(m.buffer, m.byteOffset, m.length);
    }
    o += size;
  }
  throw new AudioError('Die Aufnahme ist unvollständig (kein Inhaltsverzeichnis). Teile sie bitte nochmal aus Sprachmemos.');
}

function adtsHeader(profile: number, freqIdx: number, chan: number, len: number): Uint8Array {
  const n = len + 7;
  return Uint8Array.of(0xff, 0xf1, ((profile & 3) << 6) | ((freqIdx & 15) << 2) | ((chan >> 2) & 1), ((chan & 3) << 6) | ((n >> 11) & 3), (n >> 3) & 0xff, ((n & 7) << 5) | 0x1f, 0xfc);
}

/** Aus dem Audio-Eintrag (mp4a → esds) die AAC-Einstellungen für den ADTS-Kopf lesen. */
function aacConfig(v: DataView, stsd: Box): { profile: number; freqIdx: number; chan: number } {
  const entry = [...boxes(v, stsd.start + 8, stsd.end)][0];
  if (!entry) throw new AudioError('In der Aufnahme ist kein Ton.');
  if (entry.type !== 'mp4a') {
    throw new AudioError(
      entry.type === 'alac'
        ? 'Die Aufnahme ist im Format „Verlustfrei“. Stell in den iPhone-Einstellungen bei Sprachmemos die Audioqualität auf „Komprimiert“ und nimm neu auf.'
        : 'Dieses Tonformat kann Merki nicht lesen. Nimm am besten mit der App Sprachmemos auf.',
    );
  }
  const version = v.getUint16(entry.start + 8);
  const kids = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  let esds: Box | undefined;
  for (const c of boxes(v, kids, entry.end)) if (c.type === 'esds') esds = c;
  if (!esds) throw new AudioError('Dieses Tonformat kann Merki nicht lesen.');
  // Beschreibungen: Tag, Länge (bis 4 Bytes), Inhalt
  let o = esds.start + 4;
  const desc = (): { tag: number; start: number; end: number } => {
    const tag = v.getUint8(o++);
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = v.getUint8(o++);
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, start: o, end: o + len };
  };
  let d = desc();
  if (d.tag === 0x03) {
    o = d.start + 2;
    const flags = v.getUint8(o++);
    if (flags & 0x80) o += 2;
    if (flags & 0x40) o += 1 + v.getUint8(o);
    if (flags & 0x20) o += 2;
    d = desc();
  }
  if (d.tag !== 0x04) throw new AudioError('Dieses Tonformat kann Merki nicht lesen.');
  o = d.start + 13;
  d = desc();
  if (d.tag !== 0x05 || d.end - d.start < 2) throw new AudioError('Dieses Tonformat kann Merki nicht lesen.');
  // AudioSpecificConfig: Art (5 Bit), Abtastrate (4 Bit, 15 = steht ausgeschrieben da), Kanäle (4 Bit)
  let bits = 0, nbits = 0;
  o = d.start;
  const take = (n: number) => {
    while (nbits < n) {
      bits = (bits << 8) | (o < d.end ? v.getUint8(o++) : 0);
      nbits += 8;
    }
    nbits -= n;
    return (bits >> nbits) & ((1 << n) - 1);
  };
  let type = take(5);
  if (type === 31) type = 32 + take(6);
  let freqIdx = take(4);
  if (freqIdx === 15) {
    const hz = take(24);
    freqIdx = FREQS.reduce((best, f, i) => (Math.abs(f - hz) < Math.abs(FREQS[best] - hz) ? i : best), 0);
  }
  const chan = take(4) || 1;
  // HE-AAC (5, 29): Der ADTS-Kopf beschreibt den Kern (AAC-LC), den Rest erkennt der Decoder selbst
  const profile = type >= 1 && type <= 4 ? type - 1 : 1;
  return { profile, freqIdx, chan };
}

function splitMp4(src: Source, add: (p: Piece) => void): number {
  const v = readMoov(src);
  const moov: Box = { type: 'moov', start: 8, end: v.byteLength };
  let stbl: Box | undefined, timescale = 0;
  for (const trak of boxes(v, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(v, trak, 'mdia');
    const hdlr = mdia && child(v, mdia, 'hdlr');
    if (!mdia || !hdlr || String.fromCharCode(v.getUint8(hdlr.start + 8), v.getUint8(hdlr.start + 9), v.getUint8(hdlr.start + 10), v.getUint8(hdlr.start + 11)) !== 'soun') continue;
    const mdhd = child(v, mdia, 'mdhd');
    const minf = child(v, mdia, 'minf');
    stbl = minf && child(v, minf, 'stbl');
    if (mdhd) timescale = v.getUint32(mdhd.start + (v.getUint8(mdhd.start) === 1 ? 20 : 12));
    if (stbl) break;
  }
  if (!stbl || !timescale) throw new AudioError('In der Aufnahme ist kein Ton.');
  const get = (t: string) => child(v, stbl!, t);
  const stsd = get('stsd'), stts = get('stts'), stsc = get('stsc'), stsz = get('stsz'), stco = get('stco'), co64 = get('co64');
  if (!stsd || !stts || !stsc || !stsz || !(stco || co64)) throw new AudioError('Die Aufnahme ist beschädigt.');
  const { profile, freqIdx, chan } = aacConfig(v, stsd);

  const fixed = v.getUint32(stsz.start + 4), count = v.getUint32(stsz.start + 8);
  const sizeOf = (k: number) => (fixed ? fixed : v.getUint32(stsz.start + 12 + k * 4));
  const offs = stco || co64!;
  const nChunks = v.getUint32(offs.start + 4);
  const chunkOff = (c: number) => (stco ? v.getUint32(offs.start + 8 + c * 4) : Number(v.getBigUint64(offs.start + 8 + c * 8)));
  const scEntries = v.getUint32(stsc.start + 4);
  const sc = (i: number) => ({ first: v.getUint32(stsc.start + 8 + i * 12), n: v.getUint32(stsc.start + 12 + i * 12) });
  // Dauer jedes Rahmens (bei AAC immer 1024 Abtastwerte, aber so steht es da)
  const ttEntries = v.getUint32(stts.start + 4);
  let tt = 0, ttLeft = ttEntries ? v.getUint32(stts.start + 8) : 0, ttDelta = ttEntries ? v.getUint32(stts.start + 12) : 1024;
  const nextDur = () => {
    while (ttLeft === 0 && tt + 1 < ttEntries) {
      tt++;
      ttLeft = v.getUint32(stts.start + 8 + tt * 8);
      ttDelta = v.getUint32(stts.start + 12 + tt * 8);
    }
    if (ttLeft > 0) ttLeft--;
    return ttDelta / timescale;
  };

  const out = pieces(add);
  let k = 0, e = 0;
  for (let c = 0; c < nChunks && k < count; c++) {
    while (e + 1 < scEntries && sc(e + 1).first <= c + 1) e++;
    let off = chunkOff(c);
    for (let s = 0; s < sc(e).n && k < count; s++, k++) {
      const size = sizeOf(k);
      if (off + size > src.size) return out.end(); // Aufnahme abgeschnitten: was da ist, nehmen
      const frame = new Uint8Array(size + 7);
      frame.set(adtsHeader(profile, freqIdx, chan, size));
      frame.set(src.read(off, size), 7);
      out.push(frame, nextDur());
      off += size;
    }
  }
  if (!k) throw new AudioError('In der Aufnahme ist kein Ton.');
  return out.end();
}

// ---------- MP3 und AAC (ADTS) ----------

const MP3_RATES: Record<string, number[]> = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '2-x': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Frame(h: Uint8Array): { len: number; dur: number } | null {
  if (h.length < 4 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return null;
  const ver = (h[1] >> 3) & 3, layer = (h[1] >> 1) & 3, bi = h[2] >> 4, si = (h[2] >> 2) & 3, pad = (h[2] >> 1) & 1;
  if (ver === 1 || (layer !== 1 && layer !== 2) || bi === 0 || bi === 15 || si === 3) return null;
  const kbps = (ver === 3 ? MP3_RATES[layer === 1 ? '1-3' : '1-2'] : MP3_RATES['2-x'])[bi];
  const sr = MP3_SR[ver][si];
  const samples = layer === 1 && ver !== 3 ? 576 : 1152;
  return { len: Math.floor(((samples / 8) * kbps * 1000) / sr) + pad, dur: samples / sr };
}

function adtsFrame(h: Uint8Array): { len: number; dur: number } | null {
  if (h.length < 7 || h[0] !== 0xff || (h[1] & 0xf6) !== 0xf0) return null;
  const freq = FREQS[(h[2] >> 2) & 15];
  const len = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5);
  if (!freq || len < 7) return null;
  return { len, dur: (((h[6] & 3) + 1) * 1024) / freq };
}

function splitFrames(src: Source, add: (p: Piece) => void, start: number, parse: (h: Uint8Array) => { len: number; dur: number } | null): number {
  const out = pieces(add);
  let o = start, n = 0, lost = 0;
  while (o + 4 <= src.size) {
    const f = parse(src.read(o, Math.min(8, src.size - o)));
    if (!f || o + f.len > src.size) {
      // Kein gültiger Rahmen: Byte für Byte weitersuchen (zum Beispiel nach Bildern im Dateikopf)
      o++;
      if (++lost > 4 * 1024 * 1024) break;
      continue;
    }
    out.push(src.read(o, f.len), f.dur);
    o += f.len;
    n++;
  }
  if (!n) throw new AudioError('In der Aufnahme ist kein Ton.');
  return out.end();
}

function splitMp3(src: Source, add: (p: Piece) => void): number {
  let start = 0;
  const h = src.read(0, Math.min(10, src.size));
  if (String.fromCharCode(h[0], h[1], h[2]) === 'ID3' && h.length >= 10) {
    start = 10 + ((h[6] & 0x7f) << 21) + ((h[7] & 0x7f) << 14) + ((h[8] & 0x7f) << 7) + (h[9] & 0x7f) + (h[5] & 0x10 ? 10 : 0);
  }
  return splitFrames(src, add, start, mp3Frame);
}

function splitAdts(src: Source, add: (p: Piece) => void): number {
  return splitFrames(src, add, 0, adtsFrame);
}

// ---------- Mitschreiben ----------

export interface WhisperEnv {
  AI?: Ai;
  /** Nur für lokale Tests: diese Adresse schreibt statt Workers AI mit (nie in wrangler.toml) */
  WHISPER_TEST_URL?: string;
}

export interface Heard {
  text: string;
  segments: { start: number; text: string }[];
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Kostenlose Tagesmenge von Workers AI aufgebraucht (geht nach Mitternacht UTC von selbst weiter) */
export const QUOTA_RE = /4006|daily free allocation|neurons/i;
/** Was Whisper bei Stille oder Rauschen gern erfindet (gelernt aus Untertiteln deutscher Sender) */
const INVENTED = /untertitel(?:ung)?\s+(?:im auftrag\s+)?(?:des|der|von)\b|amara\.org|vielen dank f(?:ür|uer)s?\s+(?:das\s+)?zu(?:schauen|sehen|hören)|copyright\s+wdr/i;

/** Ein Stück mitschreiben. prompt: Fachbegriffe und das Ende des vorigen Stücks (hilft bei Namen und Satzanfängen). */
export async function transcribe(env: WhisperEnv, data: Uint8Array, prompt: string): Promise<Heard> {
  const input = { audio: base64(data), language: 'de', vad_filter: true, ...(prompt ? { initial_prompt: prompt } : {}) };
  let out: { text?: string; segments?: { start?: number; text?: string }[] };
  if (env.WHISPER_TEST_URL) {
    const r = await fetch(env.WHISPER_TEST_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error((await r.text()) || 'whisper ' + r.status);
    out = await r.json();
  } else if (env.AI) {
    try {
      out = await env.AI.run(WHISPER_MODEL, input);
    } catch (e) {
      if (QUOTA_RE.test(e instanceof Error ? e.message : String(e))) throw e;
      // Zweiter Weg laut Schema des Modells: der Ton als Datenstrom mit Angabe des Formats
      const contentType = data[0] === 0xff && (data[1] & 0xf6) === 0xf0 ? 'audio/aac' : 'audio/mpeg';
      try {
        out = await env.AI.run(WHISPER_MODEL, { ...input, audio: { body: new Blob([data]).stream(), contentType } } as unknown as typeof input);
      } catch {
        throw e;
      }
    }
  } else throw new AudioError('Auf dem Server fehlt die Spracherkennung.');
  const segments = (out.segments || [])
    .filter((s) => s && typeof s.text === 'string' && !INVENTED.test(s.text))
    .map((s) => ({ start: Number(s.start) || 0, text: String(s.text).trim() }));
  const text = String(out.text || '').trim().split(/(?<=[.!?])\s+/).filter((x) => !INVENTED.test(x)).join(' ');
  return { text, segments };
}

/** Zeitangabe wie in Sprachmemos: 12:30 oder 1:05:10 */
export function stamp(secs: number): string {
  const s = Math.max(0, Math.floor(secs)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

/** Mitschrift eines Stücks mit Zeitangaben, etwa jede Minute eine. */
export function withStamps(h: Heard, start: number): string {
  if (!h.segments.length) return h.text ? `[${stamp(start)}] ${h.text}` : '';
  let out = '', last = -Infinity;
  for (const s of h.segments) {
    if (!s.text) continue;
    const t = start + s.start;
    if (t - last >= 60 || !out) {
      out += (out ? '\n' : '') + `[${stamp(t)}] `;
      last = t;
    } else out += ' ';
    out += s.text;
  }
  return out;
}
