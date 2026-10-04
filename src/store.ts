/**
 * Speicher für Merkheft: ein Durable Object mit SQLite.
 *
 * - docs:  alle Daten der App (Projekte, Notizen, Chats, Dateien, Karten ...)
 *          als JSON. Jede Änderung bekommt eine fortlaufende Nummer (rev),
 *          damit Handy und Tablet nur das Neue abholen müssen. Gelöschtes
 *          bleibt als leerer Eintrag (deleted = 1), damit andere Geräte es
 *          mitbekommen.
 * - spend: KI-Kosten pro Tag, für das Tageslimit.
 * - tts:   Zeichen pro Tag, die Merki mit der echten Stimme gesprochen hat (Tages- und Monatslimit).
 * - fails: falsche Code-Eingaben pro IP und Stunde (Schutz vor Durchprobieren).
 * - push_subs: Geräte, die eine tägliche Erinnerung wollen (Uhrzeit und Zeitzone des Geräts).
 *          Ein Alarm des Durable Objects weckt den Speicher zur nächsten Erinnerung.
 * - kv:    sonstige Werte, z. B. der VAPID-Schlüssel für die Erinnerungen.
 * - batches: Sammelaufträge an Claude (halber Preis). Der Alarm fragt nach, bis sie fertig sind,
 *          holt die Ergebnisse ab und bucht die Kosten. Die App holt sie dann hier ab.
 */
import { DurableObject } from 'cloudflare:workers';
import Anthropic from '@anthropic-ai/sdk';
import { makeVapidKeys, pushEndpointOk, sendPush, unb64url, type VapidKeys } from './push';
import { berlinDay, costUsd, emptyUsage, takeUsage } from './cost';
import { embed, pack, similarity, unit, SEM_KEEP_DAYS, type SemEnv } from './sem';
import { AudioError, QUOTA_RE, split, stamp, transcribe, withStamps, type Source, type WhisperEnv } from './audio';

export interface DocRow {
  id: string;
  body: string | null;
  rev: number;
}

export interface DocOp {
  id: string;
  /** JSON-Text des Dokuments, oder null zum Löschen. */
  body: string | null;
}

/** Höchstens so viele Zeichen pro Abruf, der Rest kommt beim nächsten. */
const PAGE_CHARS = 1_000_000;
/** So viele falsche Codes pro IP und Stunde, danach ist für diese IP Pause. */
export const MAX_FAILS_PER_HOUR = 30;

export interface StoreEnv extends SemEnv, WhisperEnv {
  /** Nur für lokale Tests: diese Adresse darf als Push-Dienst dienen */
  PUSH_TEST_ORIGIN?: string;
  /** Für Sammelaufträge: nachfragen und Ergebnisse abholen */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

export interface BatchInput {
  id: string;
  fileId: string;
  name: string;
  n: number;
  purpose: string;
}

/** Ergebnis einer Anfrage im Sammelauftrag: Text der Antwort oder warum es nicht geklappt hat */
export interface BatchResult {
  id: string;
  ok: boolean;
  text: string;
  stop: string;
  err: string;
}

export interface BatchItem {
  id: string;
  /** running: Claude arbeitet noch; ready: Ergebnisse hier; busy: ein anderes Gerät verarbeitet sie gerade;
   *  done: ein Gerät hat sie schon gespeichert; failed/gone: hat nicht geklappt oder ist unbekannt */
  state: 'running' | 'ready' | 'busy' | 'done' | 'failed' | 'gone';
  results?: BatchResult[];
}

type BatchRow = {
  id: string;
  file_id: string;
  name: string;
  n: number;
  purpose: string;
  created: number;
  checked: number;
  state: string;
  lease: number;
  results: string | null;
};

/** Ein Gerät hat so lange Zeit, die Ergebnisse zu verarbeiten, dann darf ein anderes */
const BATCH_LEASE_MS = 10 * 60_000;
/** Claude braucht höchstens 24 Stunden, danach gilt der Auftrag als gescheitert */
const BATCH_MAX_MS = 26 * 3600_000;
/** Nicht abgeholte Ergebnisse so lange aufheben */
const BATCH_KEEP_MS = 7 * 24 * 3600_000;
/** Wie oft nachfragen: anfangs jede Minute, später seltener */
function batchEvery(age: number): number {
  return age < 15 * 60_000 ? 60_000 : age < 2 * 3600_000 ? 3 * 60_000 : 10 * 60_000;
}

// ---------- Vorlesungen ----------

/** Was die App über eine Aufnahme wissen will */
export interface RecItem {
  id: string;
  name: string;
  /** Projekt, aus dem sie hochgeladen wurde ('' beim Teilen aus Sprachmemos: Merki sucht das Fach aus) */
  pid: string;
  /** listen: wird mitgeschrieben; text: Mitschrift fertig, Merki schreibt die Notiz; failed: hat nicht geklappt */
  state: 'listen' | 'text' | 'failed';
  secs: number;
  doneSecs: number;
  created: number;
  err: string;
  /** Pause, weil die kostenlose Tagesmenge der Spracherkennung aufgebraucht ist */
  paused: boolean;
}

type RecRow = {
  id: string;
  name: string;
  pid: string;
  size: number;
  created: number;
  state: string;
  secs: number;
  done_secs: number;
  next: number;
  tries: number;
  lease: number;
  err: string;
  text: string;
};

/** Größte Aufnahme (Cloudflare nimmt höchstens 100 MB pro Anfrage, das sind über 3 Stunden Sprachmemos) */
export const MAX_REC_BYTES = 100 * 1024 * 1024;
/** Die Aufnahme liegt in Zeilen zu 1 MB im Speicher (eine Zeile darf höchstens 2 MB haben) */
const REC_ROW = 1 << 20;
/** So lange arbeitet ein Alarm am Stück, dann geht es mit dem nächsten weiter */
const REC_SLICE_MS = 60_000;
/** Mitschriften, die keine App abholt, und gescheiterte Aufnahmen so lange aufheben */
const REC_KEEP_MS = 30 * 24 * 3600_000;

export interface PushSubInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Uhrzeit auf dem Gerät, z. B. 18:00 */
  time: string;
  /** Zeitzone des Geräts, z. B. Europe/Berlin */
  tz: string;
  /** Adresse der App, steht im VAPID-Schlüssel als Kontakt */
  contact: string;
}

type PushSubRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
  time: string;
  tz: string;
  contact: string;
  last_day: string;
  last_sent: number;
  last_status: number;
};

/** Höchstens so viele Geräte mit Erinnerung (Handy, Tablet ...) */
const MAX_PUSH_SUBS = 10;
/** Kam der Alarm zu spät (Gerät war aus, Server neu gestartet), höchstens so viele Minuten nachholen */
const PUSH_LATE_MINUTES = 180;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class Store extends DurableObject<StoreEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        body TEXT,
        rev INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS docs_rev ON docs(rev);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL, calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spend_kind (day TEXT NOT NULL, kind TEXT NOT NULL, usd REAL NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (day, kind));
      CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour));
      CREATE TABLE IF NOT EXISTS tts (day TEXT PRIMARY KEY, chars INTEGER NOT NULL, calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        time TEXT NOT NULL,
        tz TEXT NOT NULL,
        contact TEXT NOT NULL,
        last_day TEXT NOT NULL DEFAULT '',
        last_sent INTEGER NOT NULL DEFAULT 0,
        last_status INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        n INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        created INTEGER NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'running',
        lease INTEGER NOT NULL DEFAULT 0,
        results TEXT
      );
      CREATE TABLE IF NOT EXISTS sem (h TEXT PRIMARY KEY, v BLOB NOT NULL, scale REAL NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pid TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL,
        created INTEGER NOT NULL,
        state TEXT NOT NULL,
        secs REAL NOT NULL DEFAULT 0,
        done_secs REAL NOT NULL DEFAULT 0,
        next INTEGER NOT NULL DEFAULT 0,
        tries INTEGER NOT NULL DEFAULT 0,
        lease INTEGER NOT NULL DEFAULT 0,
        err TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS rec_bytes (id TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, i));
      CREATE TABLE IF NOT EXISTS rec_pieces (id TEXT NOT NULL, i INTEGER NOT NULL, start REAL NOT NULL, secs REAL NOT NULL, data BLOB, text TEXT, PRIMARY KEY (id, i));
    `);
  }

  private currentRev(): number {
    const row = this.sql.exec<{ v: number }>(`SELECT v FROM meta WHERE k = 'rev'`).toArray()[0];
    return row ? row.v : 0;
  }

  /** Alles, was sich seit `since` geändert hat (seitenweise). */
  list(since: number): { rev: number; more: boolean; docs: DocRow[] } {
    const docs: DocRow[] = [];
    let size = 0;
    let more = false;
    const cursor = this.sql.exec<{ id: string; body: string | null; rev: number; deleted: number }>(
      `SELECT id, body, rev, deleted FROM docs WHERE rev > ? ORDER BY rev`,
      since,
    );
    for (const row of cursor) {
      const body = row.deleted ? null : row.body;
      size += row.id.length + (body ? body.length : 0) + 32;
      if (docs.length && size > PAGE_CHARS) {
        more = true;
        break;
      }
      docs.push({ id: row.id, body, rev: row.rev });
    }
    const rev = more ? docs[docs.length - 1].rev : Math.max(since, this.currentRev());
    return { rev, more, docs };
  }

  /** Speichert oder löscht Dokumente. Gibt die neue Stand-Nummer zurück. */
  apply(ops: DocOp[]): { rev: number } {
    return this.ctx.storage.transactionSync(() => {
      let rev = this.currentRev();
      for (const op of ops) {
        rev++;
        this.sql.exec(
          `INSERT INTO docs (id, body, rev, deleted) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET body = excluded.body, rev = excluded.rev, deleted = excluded.deleted`,
          op.id,
          op.body,
          rev,
          op.body === null ? 1 : 0,
        );
      }
      this.sql.exec(`INSERT INTO meta (k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, rev);
      return { rev };
    });
  }

  /** Wie viel heute schon für die KI ausgegeben wurde. */
  spentOn(day: string): { usd: number; calls: number } {
    const row = this.sql.exec<{ usd: number; calls: number }>(`SELECT usd, calls FROM spend WHERE day = ?`, day).toArray()[0];
    return row ? { usd: row.usd, calls: row.calls } : { usd: 0, calls: 0 };
  }

  /** Wie viel in diesem Monat vor heute schon für die KI ausgegeben wurde. */
  spentMonthBefore(day: string): number {
    const row = this.sql
      .exec<{ usd: number }>(`SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE substr(day, 1, 7) = substr(?, 1, 7) AND day < ?`, day, day)
      .toArray()[0];
    return row ? row.usd : 0;
  }

  addSpend(day: string, usd: number, kind = 'other'): void {
    this.sql.exec(
      `INSERT INTO spend (day, usd, calls) VALUES (?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      day,
      usd,
    );
    // Wofür (Chat, Dateien, Lernen ...), damit die App zeigen kann, was wie viel kostet
    this.sql.exec(
      `INSERT INTO spend_kind (day, kind, usd, calls) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, kind) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      day,
      kind,
      usd,
    );
    // Nur die letzten 60 Tage behalten
    this.sql.exec(`DELETE FROM spend WHERE day < date(?, '-60 days')`, day);
    this.sql.exec(`DELETE FROM spend_kind WHERE day < date(?, '-60 days')`, day);
  }

  /** Heutige Kosten nach Zweck, teuerster zuerst. */
  spentByKind(day: string): { kind: string; usd: number; calls: number }[] {
    return this.sql
      .exec<{ kind: string; usd: number; calls: number }>(`SELECT kind, usd, calls FROM spend_kind WHERE day = ? ORDER BY usd DESC`, day)
      .toArray()
      .map((r) => ({ kind: r.kind, usd: Math.round(r.usd * 1000) / 1000, calls: r.calls }));
  }

  // ---------- Suche nach Bedeutung ----------

  /** Welche Textstellen noch keinen Vektor haben. Die anderen werden gebraucht: Datum auffrischen (höchstens einmal am Tag). */
  semMissing(hashes: string[]): string[] {
    if (!hashes.length) return [];
    const list = JSON.stringify(hashes);
    const have = new Set(this.sql.exec<{ h: string }>(`SELECT h FROM sem WHERE h IN (SELECT value FROM json_each(?))`, list).toArray().map((r) => r.h));
    const now = Date.now();
    this.sql.exec(`UPDATE sem SET at = ? WHERE at < ? AND h IN (SELECT value FROM json_each(?))`, now, now - 86_400_000, list);
    return hashes.filter((h) => !have.has(h));
  }

  /** Vektoren für neue Textstellen holen und speichern. 'off', wenn es gerade nicht geht. */
  async semAdd(items: { h: string; text: string }[]): Promise<number | 'off'> {
    let vecs: number[][] | null;
    try {
      vecs = await embed(this.env, items.map((i) => i.text));
    } catch (e) {
      console.error('embed error', e instanceof Error ? e.message : e);
      return 'off';
    }
    if (!vecs || vecs.length !== items.length) return 'off';
    const now = Date.now();
    items.forEach((it, k) => {
      const { q, scale } = pack(vecs![k]);
      this.sql.exec(
        `INSERT INTO sem (h, v, scale, at) VALUES (?, ?, ?, ?) ON CONFLICT(h) DO UPDATE SET v = excluded.v, scale = excluded.scale, at = excluded.at`,
        it.h,
        q,
        scale,
        now,
      );
    });
    this.sql.exec(`DELETE FROM sem WHERE at < ?`, now - SEM_KEEP_DAYS * 86_400_000);
    return items.length;
  }

  /** Die k Textstellen, deren Bedeutung am besten zur Frage passt (nur unter den genannten). */
  async semSearch(q: string, hashes: string[], k: number): Promise<{ h: string; s: number }[] | 'off'> {
    if (!hashes.length) return [];
    let vecs: number[][] | null;
    try {
      vecs = await embed(this.env, [q]);
    } catch (e) {
      console.error('embed error', e instanceof Error ? e.message : e);
      return 'off';
    }
    if (!vecs || !vecs[0]) return 'off';
    const query = unit(vecs[0]);
    const rows = this.sql.exec<{ h: string; v: ArrayBuffer; scale: number }>(`SELECT h, v, scale FROM sem WHERE h IN (SELECT value FROM json_each(?))`, JSON.stringify(hashes));
    const hits: { h: string; s: number }[] = [];
    for (const r of rows) hits.push({ h: r.h, s: similarity(query, r.v, r.scale) });
    hits.sort((a, b) => b.s - a.s);
    return hits.slice(0, k).map((x) => ({ h: x.h, s: Math.round(x.s * 1000) / 1000 }));
  }

  /** Wie viele Zeichen heute schon mit der echten Stimme gesprochen wurden. */
  ttsOn(day: string): { chars: number; calls: number } {
    const row = this.sql.exec<{ chars: number; calls: number }>(`SELECT chars, calls FROM tts WHERE day = ?`, day).toArray()[0];
    return row ? { chars: row.chars, calls: row.calls } : { chars: 0, calls: 0 };
  }

  /** Wie viele Zeichen in diesem Monat schon mit der echten Stimme gesprochen wurden. */
  ttsMonth(day: string): number {
    const row = this.sql.exec<{ n: number }>(`SELECT COALESCE(SUM(chars), 0) AS n FROM tts WHERE substr(day, 1, 7) = substr(?, 1, 7)`, day).toArray()[0];
    return row ? row.n : 0;
  }

  /** Bucht Zeichen für die echte Stimme. Gibt '' zurück, wenn es passt, sonst welches Limit voll ist. */
  takeTts(day: string, chars: number, limit: number, monthLimit: number): '' | 'tag' | 'monat' {
    if (this.ttsOn(day).chars + chars > limit) return 'tag';
    if (this.ttsMonth(day) + chars > monthLimit) return 'monat';
    this.sql.exec(
      `INSERT INTO tts (day, chars, calls) VALUES (?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET chars = chars + excluded.chars, calls = calls + 1`,
      day,
      chars,
    );
    this.sql.exec(`DELETE FROM tts WHERE day < date(?, '-60 days')`, day);
    return '';
  }

  /** Gibt gebuchte Zeichen zurück, wenn der Sprachdienst nicht geantwortet hat. */
  giveBackTts(day: string, chars: number): void {
    this.sql.exec(`UPDATE tts SET chars = MAX(0, chars - ?), calls = MAX(0, calls - 1) WHERE day = ?`, chars, day);
  }

  /** true, wenn diese IP in dieser Stunde zu oft einen falschen Code geschickt hat. */
  isBlocked(ip: string, hour: number): boolean {
    const row = this.sql.exec<{ n: number }>(`SELECT n FROM fails WHERE ip = ? AND hour = ?`, ip, hour).toArray()[0];
    return !!row && row.n >= MAX_FAILS_PER_HOUR;
  }

  addFail(ip: string, hour: number): number {
    this.sql.exec(`DELETE FROM fails WHERE hour < ?`, hour - 24);
    const row = this.sql
      .exec<{ n: number }>(
        `INSERT INTO fails (ip, hour, n) VALUES (?, ?, 1)
         ON CONFLICT(ip, hour) DO UPDATE SET n = n + 1 RETURNING n`,
        ip,
        hour,
      )
      .toArray()[0];
    return row ? row.n : 1;
  }

  // ---------- Vorlesungen ----------

  /** Nimmt eine Aufnahme an (App oder Kurzbefehl aus Sprachmemos), teilt sie in Stücke und stellt den Alarm zum Mitschreiben. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/rec' || request.method !== 'POST') return Response.json({ error: { code: 'not_found', msg: 'Unbekannte Adresse.' } }, { status: 404 });
    const fail = (status: number, code: string, msg: string) => Response.json({ error: { code, msg } }, { status });
    if (/^multipart\//i.test(request.headers.get('content-type') || '')) {
      return fail(400, 'rec_form', 'Bitte im Kurzbefehl bei „Anfragetext“ die Option „Datei“ wählen (nicht „Formular“).');
    }
    if (!request.body) return fail(400, 'rec_empty', 'Es kam keine Aufnahme an.');
    const id = 'r-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const pidRaw = url.searchParams.get('pid') || '';
    const pid = /^p-[A-Za-z0-9_-]{1,80}$/.test(pidRaw) ? pidRaw : '';
    const when = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const name = (url.searchParams.get('name') || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim().slice(0, 120) || `Aufnahme vom ${when}`;
    // In Zeilen zu 1 MB speichern, während die Aufnahme ankommt
    const reader = request.body.getReader();
    const buf = new Uint8Array(REC_ROW);
    let fill = 0, rows = 0, size = 0;
    const drop = () => this.sql.exec(`DELETE FROM rec_bytes WHERE id = ?`, id);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_REC_BYTES) {
          reader.cancel().catch(() => {});
          drop();
          return fail(413, 'rec_big', 'Die Aufnahme ist zu groß (höchstens 100 MB, das sind über 3 Stunden).');
        }
        for (let o = 0; o < value.length; ) {
          const n = Math.min(REC_ROW - fill, value.length - o);
          buf.set(value.subarray(o, o + n), fill);
          fill += n;
          o += n;
          if (fill === REC_ROW) {
            this.sql.exec(`INSERT INTO rec_bytes (id, i, data) VALUES (?, ?, ?)`, id, rows++, buf.slice().buffer);
            fill = 0;
          }
        }
      }
    } catch (e) {
      console.warn('rec upload broken', e instanceof Error ? e.message : e);
      drop();
      return fail(400, 'rec_broken', 'Die Aufnahme kam nicht ganz an. Versuch es bitte nochmal.');
    }
    if (fill) this.sql.exec(`INSERT INTO rec_bytes (id, i, data) VALUES (?, ?, ?)`, id, rows++, buf.slice(0, fill).buffer);
    if (!size) return fail(400, 'rec_empty', 'Es kam keine Aufnahme an.');

    // In Stücke teilen, die die Spracherkennung einzeln lesen kann. Danach braucht es die ganze Datei nicht mehr.
    let cache: { i: number; b: Uint8Array } | null = null;
    const row = (i: number) => {
      if (!cache || cache.i !== i) {
        const r = this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM rec_bytes WHERE id = ? AND i = ?`, id, i).toArray()[0];
        cache = { i, b: new Uint8Array(r ? r.data : new ArrayBuffer(0)) };
      }
      return cache.b;
    };
    const src: Source = {
      size,
      read(off, len) {
        len = Math.max(0, Math.min(len, size - off));
        const out = new Uint8Array(len);
        for (let o = 0; o < len; ) {
          const b = row(Math.floor((off + o) / REC_ROW)), at = (off + o) % REC_ROW, n = Math.min(len - o, b.length - at);
          if (n <= 0) break;
          out.set(b.subarray(at, at + n), o);
          o += n;
        }
        return out;
      },
    };
    let n = 0, secs = 0;
    try {
      secs = split(src, (p) => this.sql.exec(`INSERT INTO rec_pieces (id, i, start, secs, data) VALUES (?, ?, ?, ?, ?)`, id, n++, p.start, p.secs, p.data.slice().buffer));
    } catch (e) {
      drop();
      this.sql.exec(`DELETE FROM rec_pieces WHERE id = ?`, id);
      if (e instanceof AudioError) return fail(400, 'rec_format', e.message);
      console.error('rec split error', e instanceof Error ? e.message : e);
      return fail(400, 'rec_format', 'Diese Aufnahme kann Merki nicht lesen.');
    }
    drop();
    const now = Date.now();
    this.sql.exec(`INSERT INTO recs (id, name, pid, size, created, state, secs, next) VALUES (?, ?, ?, ?, ?, 'listen', ?, ?)`, id, name, pid, size, now, secs, now);
    await this.schedule();
    const mins = Math.max(1, Math.round(secs / 60));
    return Response.json({ id, name, secs, pieces: n, msg: `Merki hat die Aufnahme (${mins} Min.) und schreibt sie jetzt mit.` });
  }

  /** Aufnahmen, um die sich die App noch kümmern muss. */
  recList(): RecItem[] {
    const now = Date.now();
    return this.sql
      .exec<RecRow>(`SELECT id, name, pid, size, created, state, secs, done_secs, next, tries, lease, err, '' AS text FROM recs WHERE state != 'done' ORDER BY created`)
      .toArray()
      .map((r) => ({
        id: r.id,
        name: r.name,
        pid: r.pid,
        state: r.state as RecItem['state'],
        secs: Math.round(r.secs),
        doneSecs: Math.round(r.done_secs),
        created: r.created,
        err: r.err === 'quota' ? '' : r.err,
        paused: r.state === 'listen' && r.err === 'quota' && r.next > now,
      }));
  }

  /** Mitschrift abholen, um daraus die Notiz zu schreiben. Immer nur ein Gerät auf einmal (es hat dann 10 Minuten Zeit). */
  recTake(id: string): { state: 'ready'; text: string; name: string; pid: string; secs: number; created: number } | { state: 'busy' | 'gone' | 'listen' } {
    const r = this.sql.exec<RecRow>(`SELECT * FROM recs WHERE id = ?`, id).toArray()[0];
    if (!r || r.state === 'done' || r.state === 'failed') return { state: 'gone' };
    if (r.state !== 'text') return { state: 'listen' };
    const now = Date.now();
    if (r.lease > now) return { state: 'busy' };
    this.sql.exec(`UPDATE recs SET lease = ? WHERE id = ?`, now + BATCH_LEASE_MS, id);
    return { state: 'ready', text: r.text, name: r.name, pid: r.pid, secs: Math.round(r.secs), created: r.created };
  }

  /** Das Schreiben der Notiz hat nicht geklappt: gleich wieder freigeben, damit es nochmal versucht werden kann. */
  recFree(id: string): void {
    this.sql.exec(`UPDATE recs SET lease = 0 WHERE id = ?`, id);
  }

  /** Die Notiz ist gespeichert (oder sie will die Aufnahme nicht mehr): alles dazu löschen. */
  async recDrop(id: string): Promise<void> {
    this.sql.exec(`DELETE FROM recs WHERE id = ?`, id);
    this.sql.exec(`DELETE FROM rec_pieces WHERE id = ?`, id);
    this.sql.exec(`DELETE FROM rec_bytes WHERE id = ?`, id);
    await this.schedule();
  }

  /** Fachbegriffe für die Spracherkennung: kurze Titel ihrer Notizen (aus dem Fach, sonst aus allen). */
  private recTerms(pid: string): string {
    const rows = this.sql
      .exec<{ t: string | null }>(
        `SELECT json_extract(body, '$.title') AS t FROM docs WHERE id LIKE 'n-%' AND deleted = 0 AND (? = '' OR json_extract(body, '$.projectId') = ?) ORDER BY rev DESC LIMIT 120`,
        pid,
        pid,
      )
      .toArray();
    const seen = new Set<string>();
    let out = '';
    for (const r of rows) {
      const t = String(r.t || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40 || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      if (out.length + t.length > 300) break;
      out += (out ? ', ' : '') + t;
    }
    return out;
  }

  /** Mitschreiben: Stück für Stück, bis die Zeit für diesen Alarm um ist. */
  private async recWork(until: number): Promise<void> {
    const now = Date.now();
    for (const r of this.sql.exec<RecRow>(`SELECT * FROM recs WHERE state = 'listen' AND next <= ? ORDER BY created`, now).toArray()) {
      const terms = this.recTerms(r.pid);
      while (Date.now() < until) {
        // Inzwischen verworfen (während die Spracherkennung lief): nicht weitermachen, keine Mitteilung
        if (this.sql.exec<{ state: string }>(`SELECT state FROM recs WHERE id = ?`, r.id).toArray()[0]?.state !== 'listen') break;
        const p = this.sql.exec<{ i: number; start: number; secs: number; data: ArrayBuffer | null }>(
          `SELECT i, start, secs, data FROM rec_pieces WHERE id = ? AND text IS NULL ORDER BY i LIMIT 1`,
          r.id,
        ).toArray()[0];
        if (!p) {
          await this.recFinish(r);
          break;
        }
        const prev = this.sql.exec<{ text: string | null }>(`SELECT text FROM rec_pieces WHERE id = ? AND i = ?`, r.id, p.i - 1).toArray()[0];
        const tail = String(prev?.text || '').replace(/\[[\d:]+\]\s*/g, '').slice(-250);
        const prompt = [terms ? `Vorlesung an der Uni. Fachbegriffe: ${terms}.` : 'Vorlesung an der Uni.', tail].filter(Boolean).join(' ');
        try {
          const heard = await transcribe(this.env, new Uint8Array(p.data || new ArrayBuffer(0)), prompt);
          const text = withStamps(heard, p.start) || `[${stamp(p.start)}] (hier ist nichts zu verstehen)`;
          this.sql.exec(`UPDATE rec_pieces SET text = ?, data = NULL WHERE id = ? AND i = ?`, text, r.id, p.i);
          this.sql.exec(`UPDATE recs SET done_secs = MIN(secs, done_secs + ?), tries = 0, err = '' WHERE id = ?`, p.secs, r.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn('whisper error', msg);
          // Kostenlose Tagesmenge von Workers AI aufgebraucht: morgen (nach Mitternacht UTC) von selbst weiter
          if (QUOTA_RE.test(msg)) {
            const tomorrow = Math.ceil((Date.now() + 1) / 86_400_000) * 86_400_000 + 5 * 60_000;
            this.sql.exec(`UPDATE recs SET next = ?, err = 'quota' WHERE id = ?`, tomorrow, r.id);
            return;
          }
          const tries = this.sql.exec<{ tries: number }>(`UPDATE recs SET tries = tries + 1 WHERE id = ? RETURNING tries`, r.id).toArray()[0]?.tries ?? 1;
          if (tries < 4) {
            this.sql.exec(`UPDATE recs SET next = ? WHERE id = ?`, Date.now() + tries * 60_000, r.id);
            break;
          }
          // Viermal nicht geklappt: Ist es das erste Stück, liest die Spracherkennung die Aufnahme gar nicht. Sonst das Stück überspringen.
          if (p.i === 0) {
            this.sql.exec(`UPDATE recs SET state = 'failed', err = ? WHERE id = ?`, 'Die Spracherkennung konnte die Aufnahme nicht lesen.', r.id);
            this.sql.exec(`DELETE FROM rec_pieces WHERE id = ?`, r.id);
            break;
          }
          this.sql.exec(`UPDATE rec_pieces SET text = ?, data = NULL WHERE id = ? AND i = ?`, `[${stamp(p.start)}] (Dieses Stück konnte die Spracherkennung nicht lesen.)`, r.id, p.i);
          this.sql.exec(`UPDATE recs SET done_secs = MIN(secs, done_secs + ?), tries = 0 WHERE id = ?`, p.secs, r.id);
        }
      }
    }
  }

  /** Alle Stücke mitgeschrieben: Mitschrift zusammensetzen und Bescheid geben. */
  private async recFinish(r: RecRow): Promise<void> {
    const text = this.sql
      .exec<{ text: string | null }>(`SELECT text FROM rec_pieces WHERE id = ? ORDER BY i`, r.id)
      .toArray()
      .map((x) => x.text || '')
      .filter(Boolean)
      .join('\n');
    this.sql.exec(`UPDATE recs SET state = 'text', text = ?, done_secs = secs, err = '' WHERE id = ?`, text, r.id);
    this.sql.exec(`DELETE FROM rec_pieces WHERE id = ?`, r.id);
    await this.notifyAll({
      title: 'Mitschrift fertig',
      body: `„${r.name}“ ist mitgeschrieben. Tippe hier, dann schreibt Merki die Notiz.`,
      tag: 'merkheft-rec-' + r.id,
    });
  }

  // ---------- Sammelaufträge ----------

  /** Neuer Sammelauftrag: merken und den Alarm stellen, damit nachgefragt wird. */
  async batchAdd(b: BatchInput): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO batches (id, file_id, name, n, purpose, created, checked, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      b.id,
      b.fileId,
      b.name,
      b.n,
      b.purpose,
      now,
      now,
    );
    await this.schedule();
  }

  /**
   * Was die App wissen will: läuft der Auftrag noch, oder sind die Ergebnisse da?
   * Fertige Ergebnisse bekommt immer nur ein Gerät auf einmal (es hat dann 10 Minuten Zeit).
   * War die letzte Nachfrage bei Claude länger her, wird gleich nachgefragt.
   */
  async batchCheck(ids: string[]): Promise<BatchItem[]> {
    const out: BatchItem[] = [];
    const now = Date.now();
    for (const id of ids) {
      let row = this.sql.exec<BatchRow>(`SELECT * FROM batches WHERE id = ?`, id).toArray()[0];
      if (!row) {
        out.push({ id, state: 'gone' });
        continue;
      }
      if (row.state === 'running' && now - row.checked >= 20_000) {
        await this.batchPoll(row);
        row = this.sql.exec<BatchRow>(`SELECT * FROM batches WHERE id = ?`, id).toArray()[0];
      }
      if (row.state === 'ready') {
        if (row.lease > now) out.push({ id, state: 'busy' });
        else {
          this.sql.exec(`UPDATE batches SET lease = ? WHERE id = ?`, now + BATCH_LEASE_MS, id);
          out.push({ id, state: 'ready', results: JSON.parse(row.results || '[]') as BatchResult[] });
        }
      } else out.push({ id, state: row.state === 'failed' ? 'failed' : row.state === 'done' ? 'done' : 'running' });
    }
    await this.schedule();
    return out;
  }

  /** Die App hat die Ergebnisse gespeichert. Der Eintrag bleibt noch eine Weile, damit andere Geräte wissen, dass es erledigt ist. */
  async batchDone(id: string): Promise<void> {
    this.sql.exec(`UPDATE batches SET state = 'done', results = NULL WHERE id = ?`, id);
    await this.schedule();
  }

  /** Die App will nicht mehr warten (sofort zusammenfassen) oder die Datei ist gelöscht: bei Claude abbrechen. Gilt als erledigt. */
  async batchCancel(id: string): Promise<void> {
    const row = this.sql.exec<BatchRow>(`SELECT * FROM batches WHERE id = ?`, id).toArray()[0];
    this.sql.exec(`UPDATE batches SET state = 'done', results = NULL WHERE id = ?`, id);
    if (row && row.state === 'running' && this.env.ANTHROPIC_API_KEY) {
      try {
        await this.claude().beta.messages.batches.cancel(id);
      } catch (e) {
        console.warn('batch cancel failed', e instanceof Error ? e.message : e);
      }
    }
    await this.schedule();
  }

  private claude(): Anthropic {
    return new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY, baseURL: this.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1 });
  }

  /** Bei Claude nachfragen. Ist der Auftrag fertig: Ergebnisse holen, Kosten buchen (halber Preis), Mitteilung schicken. */
  private async batchPoll(row: BatchRow): Promise<void> {
    const now = Date.now();
    this.sql.exec(`UPDATE batches SET checked = ? WHERE id = ?`, now, row.id);
    if (!this.env.ANTHROPIC_API_KEY) return;
    const client = this.claude();
    try {
      const b = await client.beta.messages.batches.retrieve(row.id);
      if (b.processing_status !== 'ended') {
        if (now - row.created > BATCH_MAX_MS) this.sql.exec(`UPDATE batches SET state = 'failed' WHERE id = ?`, row.id);
        return;
      }
      const results: BatchResult[] = [];
      let usd = 0;
      for await (const r of await client.beta.messages.batches.results(row.id)) {
        if (r.result.type === 'succeeded') {
          const m = r.result.message;
          const u = emptyUsage();
          takeUsage(u, m.usage);
          usd += costUsd(m.model || '', u, 0.5);
          const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
          results.push({ id: r.custom_id, ok: true, text, stop: m.stop_reason || '', err: '' });
        } else {
          results.push({ id: r.custom_id, ok: false, text: '', stop: '', err: r.result.type });
        }
      }
      // Hat inzwischen eine andere Nachfrage (Alarm oder App) die Ergebnisse schon geholt oder wurde abgebrochen: nichts doppelt buchen
      const cur = this.sql.exec<{ state: string }>(`SELECT state FROM batches WHERE id = ?`, row.id).toArray()[0];
      if (!cur || cur.state !== 'running') return;
      if (usd > 0) this.addSpend(berlinDay(), usd, row.purpose);
      this.sql.exec(`UPDATE batches SET state = 'ready', results = ? WHERE id = ?`, JSON.stringify(results), row.id);
      await this.notifyAll({
        title: 'Zusammenfassung fertig',
        body: `„${row.name}“ ist zusammengefasst. Tippe hier, dann holt Merki sie in die App.`,
        tag: 'merkheft-batch-' + row.file_id,
      });
    } catch (e) {
      // Auftrag unbekannt: gescheitert. Sonst (Netz, Überlastung) beim nächsten Mal nochmal
      if (e instanceof Anthropic.NotFoundError) this.sql.exec(`UPDATE batches SET state = 'failed' WHERE id = ?`, row.id);
      console.warn('batch poll failed', e instanceof Error ? e.message : e);
    }
  }

  /** Mitteilung an alle Geräte mit eingeschalteter Erinnerung (abgemeldete fliegen raus). */
  private async notifyAll(msg: { title: string; body: string; tag: string }): Promise<void> {
    const rows = this.sql.exec<PushSubRow>(`SELECT * FROM push_subs`).toArray();
    if (!rows.length) return;
    const keys = await this.vapid();
    for (const row of rows) {
      let status = 0;
      try {
        status = await sendPush(row, { ...msg, url: '/' }, keys);
      } catch (e) {
        console.warn('push failed', e instanceof Error ? e.message : e);
      }
      if (status === 404 || status === 410) this.sql.exec(`DELETE FROM push_subs WHERE endpoint = ?`, row.endpoint);
    }
  }

  // ---------- Tägliche Erinnerung ----------

  /** VAPID-Schlüssel: entsteht beim ersten Mal und bleibt hier. */
  private async vapid(): Promise<VapidKeys> {
    const read = () => this.sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'vapid'`).toArray()[0];
    let row = read();
    if (!row) {
      const keys = await makeVapidKeys();
      this.sql.exec(`INSERT OR IGNORE INTO kv (k, v) VALUES ('vapid', ?)`, JSON.stringify(keys));
      row = read();
    }
    return JSON.parse(row!.v) as VapidKeys;
  }

  /** Öffentlicher Schlüssel für pushManager.subscribe auf dem Gerät */
  async pushKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  /** Erinnerung für ein Gerät einschalten oder die Uhrzeit ändern. Gibt false zurück, wenn etwas nicht stimmt. */
  async pushSubscribe(s: PushSubInput): Promise<boolean> {
    if (!pushEndpointOk(s.endpoint, this.env.PUSH_TEST_ORIGIN) || !TIME_RE.test(s.time) || !validTz(s.tz)) return false;
    try {
      const key = unb64url(s.p256dh);
      if (key.length !== 65 || key[0] !== 4 || unb64url(s.auth).length !== 16) return false;
    } catch {
      return false;
    }
    const now = Date.now();
    const local = localNow(s.tz, now);
    const old = this.sql.exec<{ last_day: string }>(`SELECT last_day FROM push_subs WHERE endpoint = ?`, s.endpoint).toArray()[0];
    // Ist die Uhrzeit heute schon vorbei, kommt die erste Erinnerung erst morgen
    const lastDay = local.mins >= toMins(s.time) ? local.day : old ? old.last_day : '';
    this.sql.exec(
      `INSERT INTO push_subs (endpoint, p256dh, auth, time, tz, contact, last_day, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, time = excluded.time, tz = excluded.tz,
         contact = excluded.contact, last_day = excluded.last_day`,
      s.endpoint,
      s.p256dh,
      s.auth,
      s.time,
      s.tz,
      s.contact,
      lastDay,
      now,
    );
    this.sql.exec(
      `DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY created DESC LIMIT ?)`,
      MAX_PUSH_SUBS,
    );
    await this.schedule();
    return true;
  }

  async pushUnsubscribe(endpoint: string): Promise<void> {
    this.sql.exec(`DELETE FROM push_subs WHERE endpoint = ?`, endpoint);
    await this.schedule();
  }

  /** Ist die Erinnerung für dieses Gerät an, und wann kam die letzte? */
  pushStatus(endpoint: string): { on: boolean; time: string; lastSent: number; lastStatus: number } {
    const row = this.sql.exec<PushSubRow>(`SELECT * FROM push_subs WHERE endpoint = ?`, endpoint).toArray()[0];
    return row ? { on: true, time: row.time, lastSent: row.last_sent, lastStatus: row.last_status } : { on: false, time: '', lastSent: 0, lastStatus: 0 };
  }

  /** Schickt die Erinnerung von heute sofort an dieses Gerät (Knopf „Test schicken“). -1 = Gerät unbekannt, 0 = nicht erreichbar. */
  async pushTest(endpoint: string): Promise<number> {
    const row = this.sql.exec<PushSubRow>(`SELECT * FROM push_subs WHERE endpoint = ?`, endpoint).toArray()[0];
    if (!row) return -1;
    return await this.deliver(row, localNow(row.tz, Date.now()).day, false);
  }

  /** Der Alarm: alle Geräte, deren Uhrzeit dran ist, bekommen ihre Erinnerung. Laufende Sammelaufträge: nachfragen. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const row of this.sql.exec<PushSubRow>(`SELECT * FROM push_subs`).toArray()) {
      const local = localNow(row.tz, now);
      if (!isDue(row, local)) continue;
      await this.deliver(row, local.day, true);
    }
    for (const row of this.sql.exec<BatchRow>(`SELECT * FROM batches WHERE state = 'running'`).toArray()) {
      if (now - row.checked >= batchEvery(now - row.created) - 5000) await this.batchPoll(row);
    }
    this.sql.exec(`DELETE FROM batches WHERE state != 'running' AND created < ?`, now - BATCH_KEEP_MS);
    await this.recWork(now + REC_SLICE_MS);
    for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM recs WHERE state != 'listen' AND created < ?`, now - REC_KEEP_MS).toArray()) await this.recDrop(r.id);
    await this.schedule();
  }

  /** Schickt eine Erinnerung und merkt sich das Ergebnis. Abgemeldete Geräte fliegen raus. */
  private async deliver(row: PushSubRow, day: string, daily: boolean): Promise<number> {
    const msg = this.reminder(day);
    if (daily) {
      // Jeden Tag höchstens einmal, auch wenn das Senden schiefgeht
      this.sql.exec(`UPDATE push_subs SET last_day = ? WHERE endpoint = ?`, day, row.endpoint);
      // Heute schon gelernt: dann keine Erinnerung
      if (msg.learned) return 0;
    }
    let status = 0;
    try {
      status = await sendPush(row, { title: msg.title, body: msg.body, tag: 'merkheft-erinnerung', url: '/' }, await this.vapid());
    } catch (e) {
      console.warn('push failed', e instanceof Error ? e.message : e);
    }
    if (status === 404 || status === 410) this.sql.exec(`DELETE FROM push_subs WHERE endpoint = ?`, row.endpoint);
    else this.sql.exec(`UPDATE push_subs SET last_sent = ?, last_status = ? WHERE endpoint = ?`, Date.now(), status, row.endpoint);
    return status;
  }

  /** Text der Erinnerung aus dem, was gerade ansteht: fällige Karten, Lernplan, Prüfung. */
  private reminder(day: string): { title: string; body: string; learned: boolean } {
    const parse = <T>(body: string | null): T | null => {
      try {
        return body ? (JSON.parse(body) as T) : null;
      } catch {
        return null;
      }
    };
    const stats = parse<{ name?: string; lastDay?: string }>(
      this.sql.exec<{ body: string | null }>(`SELECT body FROM docs WHERE id = 'stats' AND deleted = 0`).toArray()[0]?.body ?? null,
    );
    const name = String(stats?.name || '').trim().slice(0, 40);
    const projects = new Map<string, { name: string; examDate: string }>();
    for (const r of this.sql.exec<{ id: string; body: string | null }>(`SELECT id, body FROM docs WHERE id LIKE 'p-%' AND deleted = 0`)) {
      const p = parse<{ name?: string; examDate?: string }>(r.body);
      if (p) projects.set(r.id, { name: String(p.name || '').slice(0, 60), examDate: String(p.examDate || '') });
    }
    let cards = 0;
    for (const r of this.sql.exec<{ pid: string | null; n: number }>(
      `SELECT json_extract(body, '$.projectId') AS pid, COUNT(*) AS n FROM docs
       WHERE id LIKE 'k-%' AND deleted = 0 AND COALESCE(json_extract(body, '$.due'), '') <= ? GROUP BY pid`,
      day,
    )) {
      if (r.pid && projects.has(r.pid)) cards += r.n;
    }
    // Nächste Prüfung in den kommenden 14 Tagen
    let exam: { name: string; days: number } | null = null;
    for (const p of projects.values()) {
      const n = daysBetween(day, p.examDate);
      if (n !== null && n >= 0 && n <= 14 && (!exam || n < exam.days)) exam = { name: p.name, days: n };
    }
    // Was heute im Lernplan steht (wie in der App: der letzte Tag bis heute mit offenen Aufgaben).
    // Bei mehreren Plänen zählt der mit der nächsten Prüfung.
    const plans: { exam: string; id: string; title: string }[] = [];
    for (const r of this.sql.exec<{ id: string; body: string | null }>(`SELECT id, body FROM docs WHERE id LIKE 'pl-%' AND deleted = 0`)) {
      const pl = parse<{ projectId?: string; examDate?: string; days?: { date?: string; title?: string; tasks?: { done?: boolean }[] }[] }>(r.body);
      const p = pl && pl.projectId ? projects.get(pl.projectId) : undefined;
      if (!pl || !p || pl.examDate !== p.examDate || p.examDate < day || !Array.isArray(pl.days)) continue;
      const d = [...pl.days].reverse().find((x) => x && String(x.date || '') <= day);
      if (d && Array.isArray(d.tasks) && d.tasks.some((t) => t && !t.done)) plans.push({ exam: p.examDate, id: r.id, title: String(d.title || '').slice(0, 120) });
    }
    plans.sort((a, b) => a.exam.localeCompare(b.exam) || a.id.localeCompare(b.id));
    const plan = plans.length ? plans[0].title : '';
    const parts: string[] = [];
    if (exam) {
      parts.push(
        exam.days === 0
          ? `Heute ist deine Prüfung${exam.name ? ` in ${exam.name}` : ''}. Viel Erfolg!`
          : exam.days === 1
            ? `Morgen ist deine Prüfung${exam.name ? ` in ${exam.name}` : ''}.`
            : `Noch ${exam.days} Tage bis zur Prüfung${exam.name ? ` in ${exam.name}` : ''}.`,
      );
    }
    if (plan) parts.push(`Heute im Lernplan: ${plan}.`);
    if (cards) parts.push(`${cards} ${cards === 1 ? 'Karteikarte wartet' : 'Karteikarten warten'} auf dich.`);
    if (!parts.length) parts.push('Zeit für eine kurze Lernrunde mit Merki.');
    return {
      title: name ? `Zeit zum Lernen, ${name}` : 'Zeit zum Lernen',
      body: parts.join(' ').slice(0, 400),
      learned: !!stats && stats.lastDay === day,
    };
  }

  /** Stellt den Alarm auf die nächste fällige Erinnerung oder Nachfrage (oder löscht ihn, wenn nichts ansteht). */
  private async schedule(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const row of this.sql.exec<PushSubRow>(`SELECT * FROM push_subs`).toArray()) next = Math.min(next, nextSend(row, now));
    for (const row of this.sql.exec<BatchRow>(`SELECT * FROM batches WHERE state = 'running'`).toArray()) {
      next = Math.min(next, Math.max(row.checked, row.created) + batchEvery(now - row.created));
    }
    const rec = this.sql.exec<{ n: number | null }>(`SELECT MIN(next) AS n FROM recs WHERE state = 'listen'`).toArray()[0];
    // Mitschreiben geht gleich weiter (eine Sekunde Pause zwischen den Alarmen)
    if (rec && rec.n !== null) next = Math.min(next, Math.max(rec.n, now + 1000));
    // Alte Mitschriften aufräumen
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM recs WHERE state != 'listen'`).toArray()[0]?.n) next = Math.min(next, now + 24 * 3600_000);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, now + (rec && rec.n !== null && rec.n <= now + 1000 ? 1000 : 5000)));
  }
}

// ---------- Zeit auf dem Gerät ----------

function validTz(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toMins(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Datum und Minute des Tages in dieser Zeitzone */
function localParts(tz: string, ts: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value || 0);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
}

function localNow(tz: string, ts: number): { day: string; mins: number } {
  const p = localParts(tz, ts);
  return { day: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, mins: p.h * 60 + p.mi };
}

function addDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const ms = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Zeitpunkt (UTC) von Tag + Uhrzeit in dieser Zeitzone, auch über die Zeitumstellung hinweg */
function zonedTime(day: string, time: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + toMins(time) * 60_000;
  const offset = (ts: number) => {
    const p = localParts(tz, ts);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ts / 60_000) * 60_000;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

function isDue(row: PushSubRow, local: { day: string; mins: number }): boolean {
  const late = local.mins - toMins(row.time);
  return row.last_day !== local.day && late >= 0 && late <= PUSH_LATE_MINUTES;
}

function nextSend(row: PushSubRow, now: number): number {
  const local = localNow(row.tz, now);
  if (isDue(row, local)) return now;
  const day = row.last_day !== local.day && local.mins < toMins(row.time) ? local.day : addDay(local.day);
  return zonedTime(day, row.time, row.tz);
}
