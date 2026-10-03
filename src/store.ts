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
 */
import { DurableObject } from 'cloudflare:workers';
import { makeVapidKeys, pushEndpointOk, sendPush, unb64url, type VapidKeys } from './push';

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

export interface StoreEnv {
  /** Nur für lokale Tests: diese Adresse darf als Push-Dienst dienen */
  PUSH_TEST_ORIGIN?: string;
}

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

  /** Der Alarm: alle Geräte, deren Uhrzeit dran ist, bekommen ihre Erinnerung. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const row of this.sql.exec<PushSubRow>(`SELECT * FROM push_subs`).toArray()) {
      const local = localNow(row.tz, now);
      if (!isDue(row, local)) continue;
      await this.deliver(row, local.day, true);
    }
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

  /** Stellt den Alarm auf die nächste fällige Erinnerung (oder löscht ihn, wenn keine an ist). */
  private async schedule(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const row of this.sql.exec<PushSubRow>(`SELECT * FROM push_subs`).toArray()) next = Math.min(next, nextSend(row, now));
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, now + 5000));
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
