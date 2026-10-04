/**
 * Merkheft-Server (Cloudflare Worker)
 *
 * - liefert die App aus (Ordner public/)
 * - /api/data  speichert Notizen, Chats usw. im Durable Object (Handy und Tablet gleich)
 * - /api/ai    fragt Claude mit dem API-Schlüssel aus dem Cloudflare-Secret
 *              und reicht die Antwort als Stream an die App durch
 * - /api/sem/missing|add|search  Suche nach Bedeutung in langen Dateien (Workers AI, kostenlos)
 * - /api/batch Zusammenfassungen großer Dateien als Sammelauftrag (halber Preis, kommt später)
 * - /api/rec   nimmt Vorlesungs-Aufnahmen an (App oder Kurzbefehl aus Sprachmemos) und schreibt sie
 *              mit Workers AI mit (kostenlose Tagesmenge). /api/rec/list|take|free|done|delete für die App.
 * - /api/tts   macht aus einem Satz echte Sprache (Google oder ElevenLabs), wenn dafür
 *              ein Schlüssel hinterlegt ist. Sonst spricht Merki mit der Gerätestimme.
 *
 * Alles unter /api braucht den Zugangscode (Secret APP_CODE) im Header
 * x-merkheft-code. Der API-Schlüssel verlässt den Server nie.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Store, DocOp } from './store';
import { MAX_SEM_TEXT, SEM_ADD_MAX, SEM_HASH_RE, SEM_SEARCH_MAX, semOn } from './sem';
import { berlinDay, budgetPlan, costUsd, emptyUsage, takeUsage, type BudgetPlan, type RawUsage, type UsageSum } from './cost';

export { Store } from './store';

export interface Env {
  ASSETS: Fetcher;
  STORE: DurableObjectNamespace<Store>;
  /** Secret: Anthropic-API-Schlüssel */
  ANTHROPIC_API_KEY?: string;
  /** Secret: Zugangscode für die App (mindestens 8 Zeichen) */
  APP_CODE?: string;
  /** Welches Claude-Modell (sonst DEFAULT_MODEL) */
  MODEL?: string;
  /** Höchstens so viele US-Dollar KI-Kosten pro Tag */
  TAGES_BUDGET_USD?: string;
  /** Höchstens so viele US-Dollar KI-Kosten pro Monat, fair auf die Tage verteilt (leer = kein Monatslimit) */
  MONATS_BUDGET_USD?: string;
  /** Nur für lokale Tests: andere Adresse statt api.anthropic.com */
  ANTHROPIC_BASE_URL?: string;
  /** Secret (freiwillig): Google-API-Schlüssel für Merkis echte Stimme (kostenlose Menge pro Monat) */
  GOOGLE_TTS_KEY?: string;
  /** Secret (freiwillig): ElevenLabs-API-Schlüssel für Merkis echte Stimme (braucht ein Abo) */
  ELEVENLABS_API_KEY?: string;
  /** Freiwillig: google oder elevenlabs, falls beide Schlüssel da sind (sonst Google) */
  TTS_ANBIETER?: string;
  /** Freiwillig: feste Stimme (Google z. B. de-DE-Chirp3-HD-Leda, ElevenLabs die voice_id) */
  TTS_STIMME?: string;
  /** Freiwillig: ElevenLabs-Modell (sonst DEFAULT_TTS_MODEL) */
  TTS_MODELL?: string;
  /** Höchstens so viele Zeichen echte Stimme pro Tag, danach spricht die Gerätestimme */
  TTS_TAGES_ZEICHEN?: string;
  /** Höchstens so viele Zeichen echte Stimme pro Monat (bleibt unter Googles Gratis-Menge) */
  TTS_MONATS_ZEICHEN?: string;
  /** Nur für lokale Tests: andere Adresse statt api.elevenlabs.io */
  ELEVENLABS_BASE_URL?: string;
  /** Nur für lokale Tests: andere Adresse statt texttospeech.googleapis.com */
  GOOGLE_TTS_BASE_URL?: string;
  /** Nur für lokale Tests: diese Adresse darf als Push-Dienst dienen (nie in wrangler.toml) */
  PUSH_TEST_ORIGIN?: string;
  /** Workers AI für die Suche nach Bedeutung (in wrangler.toml unter [ai], kostenlos) */
  AI?: Ai;
  /** Nur für lokale Tests: diese Adresse liefert die Vektoren statt Workers AI (nie in wrangler.toml) */
  EMBED_TEST_URL?: string;
  /** Nur für lokale Tests: diese Adresse schreibt Aufnahmen mit statt Workers AI (nie in wrangler.toml) */
  WHISPER_TEST_URL?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_BUDGET_USD = 3;
const MIN_CODE_LENGTH = 8;
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_DOC_CHARS = 500_000;
const ID_RE = /^(?:[a-z]{1,3}-[A-Za-z0-9_-]{1,80}|stats)$/;
// Ausdrucksstärkstes Echtzeit-Modell von ElevenLabs. Lehnt es eine Anfrage ab, springt das bewährte Flash-Modell ein.
const DEFAULT_TTS_MODEL = 'eleven_v4_turbo';
const SAFE_TTS_MODEL = 'eleven_flash_v2_5';
const DEFAULT_TTS_CHARS = 5000;
// Google schenkt 1 Million Zeichen im Monat für die Chirp-3-HD-Stimmen. Mit Abstand darunter bleiben.
const DEFAULT_TTS_MONTH_CHARS = 900_000;
const GOOGLE_VOICE = 'de-DE-Chirp3-HD-Aoede';
const GOOGLE_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]{2,60}$/;
/** Merki schickt Satz für Satz, ein Satz ist nie so lang */
const MAX_TTS_CHARS = 800;
const VOICE_RE = /^[A-Za-z0-9]{8,40}$/;

// ---------- Hilfen ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(status: number, code: string, msg: string): Response {
  return json({ error: { code, msg } }, status);
}

function store(env: Env) {
  return env.STORE.get(env.STORE.idFromName('main'));
}

function budgetUsd(env: Env): number {
  const n = Number(env.TAGES_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

function monthBudgetUsd(env: Env): number {
  const n = Number(env.MONATS_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface Budget extends BudgetPlan {
  today: { usd: number; calls: number };
  monthLimit: number;
}

/** Tageslimit und, falls gesetzt, fairer Tagesanteil am Monatsbudget. */
async function budget(s: DurableObjectStub<Store>, env: Env, day = berlinDay()): Promise<Budget> {
  const [today, before] = await Promise.all([s.spentOn(day), s.spentMonthBefore(day)]);
  const monthLimit = monthBudgetUsd(env);
  return { ...budgetPlan(day, today.usd, before, budgetUsd(env), monthLimit), today, monthLimit };
}

function budgetFail(b: Budget): Response | null {
  if (b.full === 'monat') return fail(429, 'budget', 'Merki macht Pause, das Monatsbudget für die KI ist aufgebraucht. Am 1. geht es weiter.');
  if (b.full === 'tag') return fail(429, 'budget', 'Merki macht für heute Pause, das Budget für heute ist aufgebraucht. Morgen geht es weiter.');
  return null;
}

async function sameCode(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Prüft den Zugangscode. Gibt eine Fehlerantwort zurück oder null, wenn alles passt. */
async function checkAccess(request: Request, env: Env): Promise<Response | null> {
  if (!env.APP_CODE || env.APP_CODE.length < MIN_CODE_LENGTH) {
    return fail(503, 'no_code', `Auf dem Server fehlt der Zugangscode (Secret APP_CODE, mindestens ${MIN_CODE_LENGTH} Zeichen).`);
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unbekannt';
  const hour = Math.floor(Date.now() / 3_600_000);
  const s = store(env);
  if (await s.isBlocked(ip, hour)) {
    return fail(429, 'blocked', 'Zu viele falsche Codes. Bitte in einer Stunde nochmal versuchen.');
  }
  let given = '';
  try {
    given = decodeURIComponent(request.headers.get('x-merkheft-code') || '');
  } catch {
    given = '';
  }
  if (given && (await sameCode(given, env.APP_CODE))) return null;
  await s.addFail(ip, hour);
  return fail(401, 'bad_code', 'Der Zugangscode stimmt nicht.');
}

async function readJson<T>(request: Request): Promise<T | null> {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// ---------- Daten ----------

async function getData(url: URL, env: Env): Promise<Response> {
  const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
  const page = await store(env).list(since);
  // Die Dokumente liegen schon als JSON-Text vor, darum ohne neues Umwandeln zusammensetzen.
  const docs = page.docs.map((d) => `{"id":${JSON.stringify(d.id)},"rev":${d.rev},"doc":${d.body ?? 'null'}}`);
  const body = `{"rev":${page.rev},"more":${page.more},"docs":[${docs.join(',')}]}`;
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

interface DataOpIn {
  id?: unknown;
  doc?: unknown;
  del?: unknown;
}

async function postData(request: Request, env: Env): Promise<Response> {
  const input = await readJson<{ ops?: DataOpIn[] }>(request);
  if (!input || !Array.isArray(input.ops) || input.ops.length > 500) return fail(400, 'bad_request', 'Ungültige Daten.');
  const ops: DocOp[] = [];
  for (const op of input.ops) {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return fail(400, 'bad_request', 'Ungültige Dokument-ID.');
    if (op.del === true) {
      ops.push({ id: op.id, body: null });
      continue;
    }
    if (!op.doc || typeof op.doc !== 'object' || Array.isArray(op.doc)) return fail(400, 'bad_request', 'Ungültiges Dokument.');
    const body = JSON.stringify(op.doc);
    if (body.length > MAX_DOC_CHARS) return fail(413, 'too_large', 'Ein Eintrag ist zu groß.');
    ops.push({ id: op.id, body });
  }
  return json(await store(env).apply(ops));
}

// ---------- KI ----------

type ClientBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string };

interface AiRequest {
  kind?: 'chat' | 'json';
  /** cache: Merkpunkt für den Zwischenspeicher, '1h' hält eine Stunde statt fünf Minuten */
  system?: { text: string; cache?: boolean | '1h' }[];
  messages?: { role: 'user' | 'assistant'; content: string | ClientBlock[] }[];
  schema?: Record<string, unknown>;
  tier?: 'quick' | 'default';
  maxTokens?: number;
  /** Wofür die Anfrage ist (nur für die Kostenübersicht) */
  purpose?: string;
  /** Wie lange der Verlauf im Zwischenspeicher bleibt: '1h' statt fünf Minuten */
  ttl?: '1h' | '5m';
  /** false: die neueste Nachricht nicht zwischenspeichern (sie trägt Textstellen nur für diese eine Anfrage) */
  tail?: boolean;
}

const PURPOSES = new Set(['chat', 'ask', 'voice', 'file', 'order', 'learn', 'ink', 'vnote', 'note', 'lecture']);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function toAnthropicContent(content: string | ClientBlock[]): string | Anthropic.Beta.BetaContentBlockParam[] | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length > 40) return null;
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b && b.type === 'image' && IMAGE_TYPES.has(b.media_type) && typeof b.data === 'string') {
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: b.media_type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: b.data },
      });
    } else return null;
  }
  return out;
}

/** Deutsche Meldung und Code für Fehler der Claude API. */
function apiFailure(e: unknown): { status: number; code: string; msg: string } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { status: 502, code: 'bad_key', msg: 'Der API-Schlüssel auf dem Server stimmt nicht.' };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { status: 429, code: 'rate_limited', msg: 'Gerade zu viele Anfragen. Bitte kurz warten.' };
  }
  if (e instanceof Anthropic.BadRequestError) {
    return { status: 400, code: 'bad_request', msg: 'Die Anfrage war zu groß oder ungültig.' };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { status: 502, code: 'network', msg: 'Claude ist gerade nicht erreichbar.' };
  }
  if (e instanceof Anthropic.APIError) {
    return { status: 502, code: 'overloaded', msg: 'Claude ist gerade überlastet. Bitte gleich nochmal.' };
  }
  return { status: 500, code: 'server', msg: 'Unerwarteter Fehler auf dem Server.' };
}

/**
 * Liest im durchgereichten Stream nur die Zeilen mit dem Verbrauch mit (für das Tageslimit).
 * Alles andere wird nicht ausgewertet, das spart Rechenzeit.
 */
class UsageMeter {
  private dec = new TextDecoder();
  private carry = '';
  private tail = '';
  private models = new Set<string>();
  private usage: UsageSum = emptyUsage();
  private deltas = 0;
  private finished = false;

  constructor(model: string) {
    this.models.add(model);
  }

  /** true, wenn der bisherige Stream genau zwischen zwei Ereignissen endet. */
  get atBoundary(): boolean {
    return this.tail === '' || this.tail === '\n\n';
  }

  add(chunk: Uint8Array): void {
    const text = this.dec.decode(chunk, { stream: true });
    this.tail = (this.tail + text).slice(-2);
    const s = this.carry + text;
    const cut = s.lastIndexOf('\n');
    if (cut < 0) {
      this.carry = s;
      return;
    }
    this.carry = s.slice(cut + 1);
    const done = s.slice(0, cut);
    for (let i = done.indexOf('content_block_delta'); i >= 0; i = done.indexOf('content_block_delta', i + 19)) this.deltas++;
    if (!done.includes('"usage"') && !done.includes('"fallback"')) return;
    for (const line of done.split('\n')) {
      if (!line.startsWith('data:') || !(line.includes('"usage"') || line.includes('"fallback"'))) continue;
      let ev: { type?: string; message?: { model?: string; usage?: RawUsage }; usage?: RawUsage; content_block?: { type?: string; to?: { model?: string } } };
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.type === 'message_start' && ev.message) {
        if (ev.message.model) this.models.add(ev.message.model);
        this.take(ev.message.usage);
      } else if (ev.type === 'message_delta') {
        this.take(ev.usage);
        this.finished = true;
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'fallback' && ev.content_block.to?.model) {
        this.models.add(ev.content_block.to.model);
      }
    }
  }

  private take(u: RawUsage | undefined): void {
    takeUsage(this.usage, u);
  }

  /** Kosten in US-Dollar. Bei abgebrochenen Antworten wird die Ausgabe geschätzt. Bei mehreren Modellen zählt das teuerste. */
  costUsd(): number {
    const u = { ...this.usage };
    if (!this.finished) u.output = Math.max(u.output, this.deltas * 3 + 300);
    return Math.max(...[...this.models].map((m) => costUsd(m, u)));
  }
}

const enc = new TextEncoder();
/** Hält die Verbindung am Handy offen, wenn Claude länger nachdenkt (SSE-Kommentar, wird ignoriert). */
const PING = enc.encode(': ping\n\n');
/** Wenn die Verbindung zu Claude mitten in der Antwort abreißt. */
const STREAM_BROKEN = enc.encode('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"stream broken"}}\n\n');

type BuiltParams = { params: Anthropic.Beta.MessageCreateParamsNonStreaming; model: string; purpose: string };

/**
 * Baut aus der Anfrage der App die Anfrage an Claude (Prüfung, Merkpunkte für den Zwischenspeicher, Modell, Aufwand).
 * forBatch: für Sammelaufträge ohne Modell-Ersatz (fallbacks), den es dort nicht gibt.
 */
function buildParams(input: AiRequest | null, env: Env, forBatch = false): BuiltParams | Response {
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100) {
    return fail(400, 'bad_request', 'Ungültige Anfrage.');
  }
  const kind = input.kind === 'json' ? 'json' : 'chat';
  if (kind === 'json' && (!input.schema || typeof input.schema !== 'object')) return fail(400, 'bad_request', 'Schema fehlt.');

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of input.messages) {
    const content = m && (m.role === 'user' || m.role === 'assistant') ? toAnthropicContent(m.content) : null;
    if (content === null) return fail(400, 'bad_request', 'Ungültige Nachricht.');
    messages.push({ role: m.role, content });
  }
  if (messages[0].role !== 'user') return fail(400, 'bad_request', 'Die erste Nachricht muss vom Nutzer sein.');

  // Merkpunkte für den Zwischenspeicher, in der Reihenfolge der Anfrage. Claude erlaubt höchstens 4 pro Anfrage:
  // 2 im System (Dateien, Textstellen im Gespräch), 1 am Verlauf, 1 automatisch am Ende
  type Markable = { cache_control?: Anthropic.Beta.BetaCacheControlEphemeral | null };
  const marks: Markable[] = [];
  const hours: boolean[] = [];
  const mark = (b: Markable, oneHour: boolean) => { marks.push(b); hours.push(oneHour); };
  const system: Anthropic.Beta.BetaTextBlockParam[] = [];
  let sysMarks = 0;
  for (const b of Array.isArray(input.system) ? input.system.slice(0, 12) : []) {
    if (!b || typeof b.text !== 'string' || !b.text) continue;
    const block: Anthropic.Beta.BetaTextBlockParam = { type: 'text', text: b.text };
    if (b.cache && sysMarks < 2) { sysMarks++; mark(block, b.cache === '1h'); }
    system.push(block);
  }
  const ttl1h = input.ttl === '1h';

  // Die neue Nachricht bringt im Chat oft wechselnde Textstellen aus den Dateien mit. Der Verlauf davor bleibt aber gleich:
  // Merkpunkt an der letzten Antwort, damit er beim nächsten Mal aus dem Zwischenspeicher kommt (kostet ein Zehntel)
  if (kind === 'chat' && messages.length >= 3) {
    const prev = messages[messages.length - 2];
    const blocks = typeof prev.content === 'string' ? (prev.content ? [{ type: 'text' as const, text: prev.content }] : []) : prev.content;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text' && last.text) {
      mark(last, ttl1h);
      prev.content = blocks;
    }
  }
  // Im Chat wiederholt sich der Anfang jeder Anfrage: den Rest automatisch zwischenspeichern,
  // außer die neueste Nachricht trägt Textstellen nur für diese eine Anfrage (dann wäre das Speichern umsonst)
  const tail: Markable = {};
  if (kind === 'chat' && input.tail !== false) mark(tail, ttl1h);
  // Ein Merkpunkt für 1 Stunde darf nicht hinter einem für 5 Minuten stehen: davor liegende werden auch 1 Stunde
  for (let i = marks.length - 1, later = false; i >= 0; i--) {
    later = later || hours[i];
    marks[i].cache_control = later ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  }

  const model = env.MODEL || DEFAULT_MODEL;
  const purpose = typeof input.purpose === 'string' && PURPOSES.has(input.purpose) ? input.purpose : 'other';
  const smart = !/haiku/.test(model); // Die kleinen Modelle kennen weder effort noch fallbacks
  const effort = kind === 'chat' || input.tier === 'quick' ? 'low' : 'medium';
  // Ausführliche Zusammenfassungen langer Dateien brauchen viel Platz, darum bis 32.000
  const maxTokens = Math.min(Math.max(Number(input.maxTokens) || (kind === 'chat' ? 6000 : 8000), 300), 32000);

  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system.length ? { system } : {}),
    ...(tail.cache_control ? { cache_control: tail.cache_control } : {}),
    ...(smart || kind === 'json'
      ? {
          output_config: {
            ...(smart ? { effort: effort as 'low' | 'medium' } : {}),
            ...(kind === 'json' ? { format: { type: 'json_schema' as const, schema: input.schema! } } : {}),
          },
        }
      : {}),
    // Lehnt das Modell eine harmlose Frage fälschlich ab, macht automatisch ein anderes Claude-Modell weiter
    ...(smart && !forBatch ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
  return { params, model, purpose };
}

async function postAi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return fail(503, 'no_key', 'Auf dem Server fehlt der API-Schlüssel (Secret ANTHROPIC_API_KEY).');
  const built = buildParams(await readJson<AiRequest>(request), env);
  if (built instanceof Response) return built;
  const { model, purpose } = built;
  const params: Anthropic.Beta.MessageCreateParamsStreaming = { ...built.params, stream: true };

  const day = berlinDay();
  const s = store(env);
  const over = budgetFail(await budget(s, env, day));
  if (over) return over;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2 });
  const aborter = new AbortController();
  let upstream: Response;
  try {
    // Die rohe Antwort (Server-Sent Events) wird nur durchgereicht, die App liest sie selbst.
    // Das spart Rechenzeit: Im kostenlosen Cloudflare-Tarif gibt es nur 10 ms pro Anfrage.
    upstream = await client.beta.messages.create(params, { signal: aborter.signal }).asResponse();
  } catch (e) {
    const f = apiFailure(e);
    console.error('claude error', f.code, e instanceof Anthropic.APIError ? e.status : '', e instanceof Error ? e.message : e);
    return fail(f.status, f.code, f.msg);
  }
  if (!upstream.body) return fail(502, 'network', 'Claude ist gerade nicht erreichbar.');

  const reader = upstream.body.getReader();
  const meter = new UsageMeter(model);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let open = true;
  // Die App hat die Verbindung beendet (z. B. Stopp gedrückt): Claude auch stoppen
  const hangUp = () => {
    open = false;
    aborter.abort();
  };
  request.signal?.addEventListener('abort', hangUp);
  const write = (chunk: Uint8Array) => {
    if (open) writer.write(chunk).catch(hangUp);
  };
  let lastWrite = Date.now();
  const beat = setInterval(() => {
    if (meter.atBoundary && Date.now() - lastWrite > 9_000) {
      write(PING);
      lastWrite = Date.now();
    }
  }, 10_000);

  const pump = async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !open) break;
        meter.add(value);
        write(value);
        lastWrite = Date.now();
      }
    } catch (e) {
      if (open) {
        console.error('stream error', e instanceof Error ? e.message : e);
        if (meter.atBoundary) write(STREAM_BROKEN);
      }
    } finally {
      clearInterval(beat);
      if (!open) reader.cancel().catch(() => {});
      const usd = meter.costUsd();
      if (usd > 0) await s.addSpend(day, usd, purpose);
      if (open) {
        open = false;
        try {
          await writer.close();
        } catch {
          /* schon zu */
        }
      }
    }
  };
  ctx.waitUntil(pump());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ---------- Sammelaufträge (halber Preis, Antwort kommt später) ----------
// Zusammenfassungen großer Dateien schickt die App als Sammelauftrag. Der Speicher fragt regelmäßig nach,
// holt die Ergebnisse ab, bucht die Kosten und meldet sich mit einer Mitteilung. Die App verarbeitet die Ergebnisse.

interface BatchIn {
  fileId?: string;
  name?: string;
  requests?: (AiRequest & { id?: string })[];
}
const BATCH_REQ_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATCH_REQUESTS = 10;

async function postBatch(request: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return fail(503, 'no_key', 'Auf dem Server fehlt der API-Schlüssel (Secret ANTHROPIC_API_KEY).');
  const input = await readJson<BatchIn>(request);
  if (!input || typeof input.fileId !== 'string' || !ID_RE.test(input.fileId) || !Array.isArray(input.requests) || !input.requests.length || input.requests.length > MAX_BATCH_REQUESTS) {
    return fail(400, 'bad_request', 'Ungültige Anfrage.');
  }
  const requests: Anthropic.Beta.Messages.BatchCreateParams.Request[] = [];
  const ids = new Set<string>();
  let purpose = 'file';
  for (const r of input.requests) {
    if (!r || typeof r.id !== 'string' || !BATCH_REQ_RE.test(r.id) || ids.has(r.id)) return fail(400, 'bad_request', 'Ungültige Anfrage.');
    ids.add(r.id);
    const built = buildParams({ ...r, kind: 'json' }, env, true);
    if (built instanceof Response) return built;
    purpose = built.purpose;
    requests.push({ custom_id: r.id, params: built.params as Anthropic.Beta.Messages.BatchCreateParams.Request['params'] });
  }
  const s = store(env);
  const over = budgetFail(await budget(s, env));
  if (over) return over;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2 });
  let id: string;
  try {
    id = (await client.beta.messages.batches.create({ requests })).id;
  } catch (e) {
    const f = apiFailure(e);
    console.error('batch error', f.code, e instanceof Anthropic.APIError ? e.status : '', e instanceof Error ? e.message : e);
    return fail(f.status, f.code, f.msg);
  }
  await s.batchAdd({ id, fileId: input.fileId, name: String(input.name || '').slice(0, 120), n: requests.length, purpose });
  return json({ batch: id });
}

async function postBatchAction(action: string, request: Request, env: Env): Promise<Response> {
  const input = await readJson<{ ids?: unknown; id?: unknown }>(request);
  const s = store(env);
  if (action === 'check') {
    const ids = Array.isArray(input?.ids) ? input!.ids.filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(0, 50) : [];
    return json({ items: await s.batchCheck(ids) });
  }
  const id = typeof input?.id === 'string' && input.id.length <= 100 ? input.id : '';
  if (!id) return fail(400, 'bad_request', 'Ungültige Anfrage.');
  if (action === 'done') await s.batchDone(id);
  else await s.batchCancel(id);
  return json({ ok: true });
}

// ---------- Vorlesungen ----------

const MAX_REC_BYTES = 100 * 1024 * 1024;
const REC_ID_RE = /^r-[a-f0-9]{16}$/;

function recOn(env: Env): boolean {
  return !!env.AI || !!env.WHISPER_TEST_URL;
}

/** Aufnahme als Datenstrom an das Durable Object weiterreichen (der Worker selbst hat zu wenig Rechenzeit dafür). */
async function postRec(request: Request, url: URL, env: Env): Promise<Response> {
  if (!recOn(env)) return fail(503, 'rec_off', 'Das Mitschreiben von Aufnahmen geht gerade nicht.');
  if (Number(request.headers.get('content-length') || 0) > MAX_REC_BYTES) {
    return fail(413, 'rec_big', 'Die Aufnahme ist zu groß (höchstens 100 MB, das sind über 3 Stunden).');
  }
  if (!request.body) return fail(400, 'rec_empty', 'Es kam keine Aufnahme an.');
  if (/^multipart\//i.test(request.headers.get('content-type') || '')) {
    return fail(400, 'rec_form', 'Bitte im Kurzbefehl bei „Anfragetext“ die Option „Datei“ wählen (nicht „Formular“).');
  }
  const q = new URLSearchParams();
  const pid = url.searchParams.get('pid');
  if (pid) q.set('pid', pid.slice(0, 100));
  // Name der Aufnahme: von der App, sonst aus dem Dateinamen, falls der Kurzbefehl ihn mitschickt
  let name = url.searchParams.get('name') || '';
  const disp = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(request.headers.get('content-disposition') || '');
  if (!name && disp) {
    try {
      name = decodeURIComponent(disp[1]);
    } catch {
      name = disp[1];
    }
  }
  if (name) q.set('name', name.slice(0, 200));
  return await store(env).fetch(
    new Request('https://store/rec?' + q.toString(), {
      method: 'POST',
      body: request.body,
      headers: { 'content-type': request.headers.get('content-type') || 'application/octet-stream' },
    }),
  );
}

async function postRecAction(action: string, request: Request, env: Env): Promise<Response> {
  const s = store(env);
  if (action === 'list') return json({ items: await s.recList() });
  const input = await readJson<{ id?: unknown }>(request);
  const id = typeof input?.id === 'string' && REC_ID_RE.test(input.id) ? input.id : '';
  if (!id) return fail(400, 'bad_request', 'Ungültige Anfrage.');
  if (action === 'take') return json(await s.recTake(id));
  if (action === 'free') await s.recFree(id);
  else await s.recDrop(id);
  return json({ ok: true });
}

/** Der Kurzbefehl zeigt die Antwort als Mitteilung: darum nur der Satz, kein JSON. */
async function asPlainText(res: Response): Promise<Response> {
  let msg = '';
  try {
    const data = (await res.json()) as { msg?: string; error?: { msg?: string } };
    msg = data.error?.msg || data.msg || '';
  } catch {
    msg = '';
  }
  if (!msg) msg = res.ok ? 'Merki hat die Aufnahme.' : 'Das hat nicht geklappt. Bitte nochmal versuchen.';
  return new Response(msg, { status: res.status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---------- Suche nach Bedeutung ----------

const SEM_OFF = 'Die Suche nach Bedeutung geht gerade nicht.';

async function postSem(action: string, request: Request, env: Env): Promise<Response> {
  if (!semOn(env)) return fail(503, 'sem_off', SEM_OFF);
  const input = await readJson<{ hashes?: unknown; items?: unknown; q?: unknown; k?: unknown }>(request);
  const hashes = (x: unknown) => (Array.isArray(x) ? x.filter((h): h is string => typeof h === 'string' && SEM_HASH_RE.test(h)).slice(0, SEM_SEARCH_MAX) : []);
  const s = store(env);
  if (action === 'missing') return json({ missing: await s.semMissing(hashes(input?.hashes)) });
  if (action === 'add') {
    const raw = Array.isArray(input?.items) ? input!.items : [];
    const items = raw
      .filter((it): it is { h: string; text: string } => !!it && typeof it.h === 'string' && SEM_HASH_RE.test(it.h) && typeof it.text === 'string' && !!it.text.trim())
      .map((it) => ({ h: it.h, text: it.text.slice(0, MAX_SEM_TEXT) }));
    if (!items.length || raw.length > SEM_ADD_MAX) return fail(400, 'bad_request', 'Ungültige Anfrage.');
    const n = await s.semAdd(items);
    return n === 'off' ? fail(503, 'sem_off', SEM_OFF) : json({ added: n });
  }
  const q = typeof input?.q === 'string' ? input.q.trim().slice(0, 2000) : '';
  if (!q) return fail(400, 'bad_request', 'Ungültige Anfrage.');
  const k = Math.min(40, Math.max(1, Math.round(Number(input?.k) || 20)));
  const hits = await s.semSearch(q, hashes(input?.hashes), k);
  return hits === 'off' ? fail(503, 'sem_off', SEM_OFF) : json({ hits });
}

async function getStatus(env: Env): Promise<Response> {
  const day = berlinDay();
  const s = store(env);
  const b = await budget(s, env, day);
  const spent = b.today;
  const byKind = await s.spentByKind(day);
  const p = ttsProvider(env);
  const tts = p
    ? { provider: p, chars: (await s.ttsOn(day)).chars, limit: ttsLimit(env), month: await s.ttsMonth(day), monthLimit: ttsMonthLimit(env) }
    : null;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return json({
    model: env.MODEL || DEFAULT_MODEL,
    budgetUsd: r3(b.limit),
    dayCapUsd: budgetUsd(env),
    spentUsd: r3(spent.usd),
    calls: spent.calls,
    monthUsd: r3(b.month),
    monthBudgetUsd: b.monthLimit,
    byKind,
    tts,
  });
}

// ---------- Echte Stimme (Google oder ElevenLabs) ----------

type TtsProvider = 'google' | 'elevenlabs';

/** Welcher Sprachdienst spricht: TTS_ANBIETER, sonst der mit Schlüssel (Google zuerst, weil kostenlos). */
function ttsProvider(env: Env): TtsProvider | null {
  const want = (env.TTS_ANBIETER || '').trim().toLowerCase();
  if (want === 'elevenlabs' && env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (want === 'google' && env.GOOGLE_TTS_KEY) return 'google';
  if (env.GOOGLE_TTS_KEY) return 'google';
  if (env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return null;
}

function ttsLimit(env: Env): number {
  const n = Number(env.TTS_TAGES_ZEICHEN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTS_CHARS;
}

function ttsMonthLimit(env: Env): number {
  const n = Number(env.TTS_MONATS_ZEICHEN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTS_MONTH_CHARS;
}

function elevenBase(env: Env): string {
  return (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
}

function googleBase(env: Env): string {
  return (env.GOOGLE_TTS_BASE_URL || 'https://texttospeech.googleapis.com').replace(/\/+$/, '');
}

const validVoice = (p: TtsProvider, id: unknown): id is string => typeof id === 'string' && (p === 'google' ? GOOGLE_VOICE_RE : VOICE_RE).test(id);

interface VoiceInfo {
  id: string;
  name: string;
  /** spricht geprüft Deutsch */
  de: boolean;
  gender: string;
}

interface ElevenVoice {
  voice_id?: string;
  name?: string;
  category?: string;
  labels?: Record<string, string>;
  verified_languages?: { language?: string }[];
}

interface GoogleVoice {
  name?: string;
  languageCodes?: string[];
  ssmlGender?: string;
}

// Die Stimmenliste ändert sich selten: 10 Minuten merken
let voiceCache: { at: number; provider: TtsProvider; list: VoiceInfo[] } | null = null;

async function voices(env: Env, p: TtsProvider): Promise<VoiceInfo[]> {
  if (voiceCache && voiceCache.provider === p && Date.now() - voiceCache.at < 600_000) return voiceCache.list;
  const list = p === 'google' ? await googleVoices(env) : await elevenVoices(env);
  voiceCache = { at: Date.now(), provider: p, list };
  return list;
}

async function elevenVoices(env: Env): Promise<VoiceInfo[]> {
  const res = await fetch(elevenBase(env) + '/v2/voices?page_size=100', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY! } });
  if (!res.ok) throw new TtsError(res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { voices?: ElevenVoice[] };
  const list: VoiceInfo[] = [];
  for (const v of data.voices || []) {
    if (!v.voice_id || !VOICE_RE.test(v.voice_id)) continue;
    const labels = v.labels || {};
    const de =
      (v.verified_languages || []).some((l) => (l.language || '').toLowerCase() === 'de') ||
      (labels.language || '').toLowerCase() === 'de' ||
      /german|deutsch/i.test(labels.accent || '');
    list.push({ id: v.voice_id, name: String(v.name || 'Stimme').slice(0, 60), de, gender: labels.gender || '' });
  }
  // Deutsche Stimmen zuerst
  list.sort((a, b) => Number(b.de) - Number(a.de));
  return list;
}

async function googleVoices(env: Env): Promise<VoiceInfo[]> {
  const res = await fetch(googleBase(env) + '/v1/voices?languageCode=de-DE', { headers: { 'x-goog-api-key': env.GOOGLE_TTS_KEY! } });
  if (!res.ok) throw new TtsError(res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { voices?: GoogleVoice[] };
  const german = (data.voices || []).filter((v) => validVoice('google', v.name) && (v.languageCodes || []).some((c) => c.toLowerCase() === 'de-de'));
  // Die Chirp-3-HD-Stimmen klingen am natürlichsten, die anderen nur, falls es keine gibt
  const hd = german.filter((v) => /-Chirp3-HD-/.test(v.name!));
  const list: VoiceInfo[] = (hd.length ? hd : german).map((v) => {
    const gender = v.ssmlGender === 'FEMALE' ? 'weiblich' : v.ssmlGender === 'MALE' ? 'männlich' : '';
    return { id: v.name!, name: v.name!.split('-').pop()! + (gender ? ` (${gender})` : ''), de: true, gender };
  });
  list.sort((a, b) => Number(b.id === GOOGLE_VOICE) - Number(a.id === GOOGLE_VOICE) || a.name.localeCompare(b.name, 'de'));
  return list;
}

async function defaultVoice(env: Env, p: TtsProvider): Promise<string> {
  if (validVoice(p, env.TTS_STIMME)) return env.TTS_STIMME;
  if (p === 'google') return GOOGLE_VOICE;
  const list = await voices(env, p);
  return list[0]?.id || '';
}

class TtsError extends Error {
  constructor(public status: number, public detail: string) {
    super('tts ' + status);
  }
}

/** Deutsche Meldung und Code für Fehler des Sprachdienstes. */
function ttsFailure(e: unknown, p: TtsProvider): { status: number; code: string; msg: string } {
  if (e instanceof TtsError) {
    const d = e.detail;
    if (/unusual_activity/.test(d)) {
      return { status: 502, code: 'tts_blocked', msg: 'ElevenLabs lässt das kostenlose Konto nicht über den Server sprechen. Mit dem kleinsten Abo geht es.' };
    }
    if (/quota_exceeded/.test(d)) return { status: 429, code: 'tts_quota', msg: 'Das ElevenLabs-Guthaben für diesen Monat ist aufgebraucht.' };
    if (/BILLING_DISABLED|requires billing/i.test(d)) {
      return { status: 502, code: 'tts_key', msg: 'Bei Google ist für das Projekt noch keine Abrechnung eingeschaltet. Ohne sie gibt Google auch die kostenlosen Stimmen nicht frei.' };
    }
    if (/SERVICE_DISABLED|has not been used in project|it is disabled/.test(d)) {
      return { status: 502, code: 'tts_key', msg: 'Bei Google ist die Text-to-Speech-API für das Projekt noch nicht eingeschaltet.' };
    }
    if (/API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED/.test(d) || e.status === 401 || e.status === 403) {
      return { status: 502, code: 'tts_key', msg: `Der ${p === 'google' ? 'Google' : 'ElevenLabs'}-Schlüssel auf dem Server stimmt nicht.` };
    }
    if (e.status === 429) return { status: 429, code: 'tts_busy', msg: 'Die echte Stimme ist gerade ausgelastet.' };
  }
  return { status: 502, code: 'tts_failed', msg: 'Die echte Stimme ist gerade nicht erreichbar.' };
}

async function getVoices(env: Env): Promise<Response> {
  const p = ttsProvider(env);
  if (!p) return fail(503, 'no_tts', 'Auf dem Server ist keine echte Stimme eingerichtet.');
  try {
    return json({ provider: p, voices: await voices(env, p), default: await defaultVoice(env, p) });
  } catch (e) {
    const f = ttsFailure(e, p);
    console.error('tts voices', p, f.code, e instanceof TtsError ? e.status : '', e instanceof TtsError ? e.detail.slice(0, 200) : e);
    return fail(f.status, f.code, f.msg);
  }
}

/** Ein Versuch bei ElevenLabs: welches Modell, und ob Sprache (de) und der Satz davor mitgehen */
interface TtsTry {
  model: string;
  extras: boolean;
}

const tryKey = (t: TtsTry) => t.model + (t.extras ? '+' : '-');

// Musste ein einfacherer Versuch einspringen, fängt der Worker eine halbe Stunde lang gleich damit an
let ttsWorks = { key: '', at: 0 };

/** Erst das gewählte Modell mit allem, dann ohne Sprache und Satz davor, zuletzt das Flash-Modell. */
function ttsTries(env: Env): TtsTry[] {
  const want = env.TTS_MODELL || DEFAULT_TTS_MODEL;
  const all: TtsTry[] = [
    { model: want, extras: true },
    { model: want, extras: false },
    { model: SAFE_TTS_MODEL, extras: true },
  ];
  const list = all.filter((t, i) => all.findIndex((u) => tryKey(u) === tryKey(t)) === i);
  const at = Date.now() - ttsWorks.at < 1_800_000 ? list.findIndex((t) => tryKey(t) === ttsWorks.key) : -1;
  return at > 0 ? list.slice(at) : list;
}

const audioHeaders = { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' };

async function elevenSpeak(env: Env, voice: string, text: string, prev: string, speed: number): Promise<Response> {
  let failed: TtsError | null = null;
  for (const t of ttsTries(env)) {
    const body = {
      text,
      model_id: t.model,
      // Feste Sprache, damit auch kurze Sätze deutsch klingen, und der Satz davor für eine natürliche Betonung
      ...(t.extras ? { language_code: 'de', ...(prev ? { previous_text: prev } : {}) } : {}),
      ...(speed !== 1 ? { voice_settings: { speed } } : {}),
    };
    const res = await fetch(`${elevenBase(env)}/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (res.ok && res.body) {
      if (ttsWorks.key !== tryKey(t)) ttsWorks = { key: tryKey(t), at: Date.now() };
      return new Response(res.body, { headers: audioHeaders });
    }
    failed = new TtsError(res.status, await res.text().catch(() => ''));
    // Nur wenn ElevenLabs die Anfrage selbst ablehnt, hilft ein einfacherer Versuch
    if (![400, 404, 422].includes(res.status) || /quota_exceeded|unusual_activity|voice_not_found/.test(failed.detail)) break;
    console.warn('tts retry', tryKey(t), res.status, failed.detail.slice(0, 200));
  }
  throw failed ?? new TtsError(500, 'no try');
}

async function googleSpeak(env: Env, voice: string, text: string, speed: number): Promise<Response> {
  const res = await fetch(googleBase(env) + '/v1/text:synthesize', {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GOOGLE_TTS_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice },
      audioConfig: { audioEncoding: 'MP3', ...(speed !== 1 ? { speakingRate: speed } : {}) },
    }),
  });
  if (!res.ok) throw new TtsError(res.status, await res.text().catch(() => ''));
  // Google schickt den Ton als Base64 in JSON
  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) throw new TtsError(502, 'no audio');
  const bin = atob(data.audioContent);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: audioHeaders });
}

interface TtsRequest {
  text?: unknown;
  prev?: unknown;
  voice?: unknown;
  speed?: unknown;
}

async function postTts(request: Request, env: Env): Promise<Response> {
  const p = ttsProvider(env);
  if (!p) return fail(503, 'no_tts', 'Auf dem Server ist keine echte Stimme eingerichtet.');
  const input = await readJson<TtsRequest>(request);
  const text = input && typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > MAX_TTS_CHARS) return fail(400, 'bad_request', 'Ungültiger Text.');
  const prev = typeof input!.prev === 'string' ? input!.prev.replace(/\s+/g, ' ').trim().slice(-300) : '';
  const speed = Math.min(1.2, Math.max(0.8, Number(input!.speed) || 1));

  const day = berlinDay();
  const s = store(env);
  const over = await s.takeTts(day, text.length, ttsLimit(env), ttsMonthLimit(env));
  if (over === 'monat') return fail(429, 'tts_limit', 'Die echte Stimme hat ihre Zeichen für diesen Monat verbraucht. Ab dem Monatsersten spricht sie wieder.');
  if (over) return fail(429, 'tts_limit', 'Die echte Stimme hat für heute Pause. Morgen geht es weiter.');
  try {
    const voice = validVoice(p, input!.voice) ? input!.voice : await defaultVoice(env, p);
    if (!voice) throw new TtsError(404, 'no voice');
    return p === 'google' ? await googleSpeak(env, voice, text, speed) : await elevenSpeak(env, voice, text, prev, speed);
  } catch (e) {
    await s.giveBackTts(day, text.length);
    const f = ttsFailure(e, p);
    console.error('tts error', p, f.code, e instanceof TtsError ? e.status : '', e instanceof TtsError ? e.detail.slice(0, 200) : e instanceof Error ? e.message : e);
    return fail(f.status, f.code, f.msg);
  }
}

// ---------- App auf dem Home-Bildschirm ----------

/**
 * Wie manifest.webmanifest, nur startet das App-Symbol mit dem Zugangscode.
 * Auf iPad und iPhone hat die App vom Home-Bildschirm einen eigenen Speicher und
 * müsste sonst noch einmal nach dem Code fragen. Der Code wird hier bewusst nicht
 * geprüft, sonst könnte man über diese Adresse Codes durchprobieren.
 */
async function appManifest(url: URL, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL('/manifest.webmanifest', url)));
  if (!res.ok) return res;
  const manifest = (await res.json()) as Record<string, unknown>;
  const c = (url.searchParams.get('c') || '').slice(0, 200);
  if (c) manifest.start_url = '/#code=' + encodeURIComponent(c);
  return new Response(JSON.stringify(manifest), {
    headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---------- Tägliche Erinnerung ----------

interface PushIn {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  time?: unknown;
  tz?: unknown;
}

async function readEndpoint(request: Request): Promise<{ input: PushIn; endpoint: string } | null> {
  const input = await readJson<PushIn>(request);
  if (!input || typeof input.endpoint !== 'string' || !input.endpoint || input.endpoint.length > 1000) return null;
  return { input, endpoint: input.endpoint };
}

async function postPush(action: string, request: Request, url: URL, env: Env): Promise<Response> {
  const bad = () => fail(400, 'bad_request', 'Die Erinnerung lässt sich auf diesem Gerät nicht einrichten.');
  const got = await readEndpoint(request);
  if (!got) return bad();
  const { input, endpoint } = got;
  const s = store(env);
  if (action === 'subscribe') {
    const keys = input.keys || {};
    if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || typeof input.time !== 'string' || typeof input.tz !== 'string') return bad();
    const ok = await s.pushSubscribe({ endpoint, p256dh: keys.p256dh, auth: keys.auth, time: input.time, tz: input.tz, contact: url.origin });
    return ok ? json(await s.pushStatus(endpoint)) : bad();
  }
  if (action === 'unsubscribe') {
    await s.pushUnsubscribe(endpoint);
    return json({ on: false });
  }
  if (action === 'status') return json(await s.pushStatus(endpoint));
  // test
  const status = await s.pushTest(endpoint);
  if (status === -1) return fail(404, 'push_off', 'Die Erinnerung ist auf diesem Gerät nicht eingeschaltet.');
  if (status === 404 || status === 410) return fail(410, 'push_gone', 'Das Gerät nimmt keine Mitteilungen mehr an. Bitte die Erinnerung neu einschalten.');
  if (status < 200 || status >= 300) return fail(502, 'push_failed', 'Die Mitteilung kam nicht an. Bitte später nochmal versuchen.');
  return json({ ok: true });
}

// ---------- Weiche ----------

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/app.webmanifest') return await appManifest(url, env);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

  if (url.pathname === '/api/health') {
    return json({ ok: true, key: !!env.ANTHROPIC_API_KEY, code: !!env.APP_CODE && env.APP_CODE.length >= MIN_CODE_LENGTH, tts: !!ttsProvider(env), sem: semOn(env), rec: recOn(env) });
  }

  // Kurzbefehl aus Sprachmemos: Antwort als einfacher Satz, auch bei falschem Code
  if (url.pathname === '/api/rec' && url.searchParams.has('kurzbefehl')) {
    url.searchParams.delete('kurzbefehl');
    return await asPlainText(await route(new Request(url.toString(), request), env, ctx));
  }

  // Nur Anfragen von der eigenen Seite (kein Zugriff von fremden Webseiten)
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return fail(403, 'origin', 'Nicht erlaubt.');

  const denied = await checkAccess(request, env);
  if (denied) return denied;

  try {
    if (url.pathname === '/api/login' && request.method === 'POST') return json({ ok: true });
    if (url.pathname === '/api/status' && request.method === 'GET') return await getStatus(env);
    if (url.pathname === '/api/data' && request.method === 'GET') return await getData(url, env);
    if (url.pathname === '/api/data' && request.method === 'POST') return await postData(request, env);
    if (url.pathname === '/api/ai' && request.method === 'POST') return await postAi(request, env, ctx);
    if (url.pathname === '/api/batch' && request.method === 'POST') return await postBatch(request, env);
    const batch = /^\/api\/batch\/(check|done|cancel)$/.exec(url.pathname);
    if (batch && request.method === 'POST') return await postBatchAction(batch[1], request, env);
    const sem = /^\/api\/sem\/(missing|add|search)$/.exec(url.pathname);
    if (sem && request.method === 'POST') return await postSem(sem[1], request, env);
    if (url.pathname === '/api/rec' && request.method === 'POST') return await postRec(request, url, env);
    const rec = /^\/api\/rec\/(list|take|free|done|delete)$/.exec(url.pathname);
    if (rec && request.method === 'POST') return await postRecAction(rec[1], request, env);
    if (url.pathname === '/api/tts' && request.method === 'POST') return await postTts(request, env);
    if (url.pathname === '/api/tts/voices' && request.method === 'GET') return await getVoices(env);
    if (url.pathname === '/api/push/key' && request.method === 'GET') return json({ key: await store(env).pushKey() });
    const push = /^\/api\/push\/(subscribe|unsubscribe|status|test)$/.exec(url.pathname);
    if (push && request.method === 'POST') return await postPush(push[1], request, url, env);
  } catch (e) {
    console.error('server error', e instanceof Error ? e.message : e);
    return fail(500, 'server', 'Unerwarteter Fehler auf dem Server.');
  }
  return fail(404, 'not_found', 'Unbekannte Adresse.');
}

export default {
  fetch: route,
} satisfies ExportedHandler<Env>;
