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
 */
import { DurableObject } from 'cloudflare:workers';

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

export class Store extends DurableObject<object> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: object) {
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
      CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour));
      CREATE TABLE IF NOT EXISTS tts (day TEXT PRIMARY KEY, chars INTEGER NOT NULL, calls INTEGER NOT NULL);
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

  addSpend(day: string, usd: number): void {
    this.sql.exec(
      `INSERT INTO spend (day, usd, calls) VALUES (?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      day,
      usd,
    );
    // Nur die letzten 60 Tage behalten
    this.sql.exec(`DELETE FROM spend WHERE day < date(?, '-60 days')`, day);
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
}
