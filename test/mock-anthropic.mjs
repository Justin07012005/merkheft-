// Ersatz für api.anthropic.com beim lokalen Testen (keine echten Kosten).
// Antwortet im SSE-Format der Messages API und baut JSON passend zum Schema.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 8788);
const LOG = process.env.MOCK_LOG || 'mock-requests.jsonl';

function sample(schema, key = '', depth = 0) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties || {})) o[k] = sample(v, k, depth + 1);
    return o;
  }
  if (t === 'array') {
    const n = key === 'antworten' ? 4 : key === 'aufgaben' ? 2 : depth === 1 ? 5 : 3;
    return Array.from({ length: n }, (_, i) => {
      const v = sample(schema.items, key, depth + 1);
      if (typeof v === 'string') return `${v} ${i + 1}`;
      if (v && typeof v === 'object') {
        for (const kk of Object.keys(v)) {
          if (kk === 'tabelle' || kk === 'diagramm') { if (i > 0) v[kk] = ''; continue; } // nur das erste Thema hat Tabelle und Diagramm
          if (kk === 'datum') v[kk] = new Date(Date.now() + i * 864e5).toISOString().slice(0, 10); // Lernplan: ein Tag nach dem anderen
          else if (typeof v[kk] === 'string') v[kk] = `${v[kk]} ${i + 1}`;
        }
      }
      return v;
    });
  }
  if (t === 'integer' || t === 'number') {
    if (key === 'richtig') return 1;
    if (key === 'punkte') return 4;
    return 1;
  }
  if (t === 'boolean') return true;
  if (key === 'datum') return new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  if (key === 'tabelle') return '| Phase | Was passiert |\n|---|---|\n| Prophase | Chromosomen verdichten sich |\n| Metaphase | Chromosomen ordnen sich in der Mitte |';
  if (key === 'diagramm') return 'flowchart LR\n  A["Prophase"] --> B["Metaphase"] --> C["Anaphase"] --> D["Telophase"]';
  return `Test ${key || 'text'} r${reqNo}`;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let reqNo = 0; // Jede Anfrage bekommt eigene Texte, damit nichts doppelt aussieht

// ---------- Ersatz für ElevenLabs (echte Stimme) ----------
// Stilles MP3 (MPEG-1 Layer III, 64 kbit/s, 44,1 kHz, mono), Länge nach Textlänge
function silentMp3(seconds) {
  const size = Math.floor(144 * 64000 / 44100), f = Buffer.alloc(size);
  f[0] = 0xff; f[1] = 0xfb; f[2] = 0x50; f[3] = 0xc4;
  return Buffer.concat(Array.from({ length: Math.max(4, Math.ceil(seconds / (1152 / 44100))) }, () => f));
}
const VOICES = [
  { voice_id: 'enVoiceSarah000000001', name: 'Sarah', category: 'premade', labels: { gender: 'female', accent: 'american' }, verified_languages: [{ language: 'en', model_id: 'eleven_flash_v2_5' }] },
  { voice_id: 'deVoiceMila0000000001', name: 'Mila', category: 'professional', labels: { gender: 'female', accent: 'german' }, verified_languages: [{ language: 'de', model_id: 'eleven_flash_v2_5' }] },
  { voice_id: 'deVoiceJonas000000001', name: 'Jonas', category: 'professional', labels: { gender: 'male' }, verified_languages: [{ language: 'de', model_id: 'eleven_multilingual_v2' }] },
];
let busyOnce = true;
async function eleven(req, res, p) {
  const err = (status, detail) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail })); };
  if (req.headers['xi-api-key'] !== 'test-el-key') return err(401, { status: 'invalid_api_key', message: 'Invalid API key' });
  if (req.method === 'GET' && req.url.startsWith('/v2/voices')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voices: VOICES, has_more: false })); }
  if (req.method !== 'POST') return err(405, { status: 'method_not_allowed' });
  const text = String(p.text || '');
  if (text.includes('TTSFEHLER')) return err(500, { status: 'internal_error', message: 'boom' });
  if (text.includes('TTSQUOTA')) return err(401, { status: 'quota_exceeded', message: 'This request exceeds your quota.' });
  if (text.includes('TTSBUSY') && busyOnce) { busyOnce = false; return err(429, { status: 'too_many_concurrent_requests', message: 'busy' }); }
  if (text.includes('TTSLANGSAM')) await new Promise((r) => setTimeout(r, 20000));
  // Modell-Fallback testen: V4OHNE lehnt bei v4 Sprache und Satz davor ab, V4WEG kennt v4 gar nicht
  const v4 = String(p.model_id || '').startsWith('eleven_v4');
  if (text.includes('V4OHNE') && v4 && (p.language_code || p.previous_text)) return err(400, { status: 'invalid_parameters', message: 'previous_text is not supported for this model' });
  if (text.includes('V4WEG') && v4) return err(400, { status: 'model_not_found', message: 'Model not found' });
  if (text.includes('TTSKAPUTT')) { const junk = Buffer.from('kein mp3 '.repeat(200)); res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': junk.length }); return res.end(junk); }
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_TTS_DELAY || 80)));
  const mp3 = silentMp3(Math.min(3, Math.max(0.3, text.length * 0.02)));
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3.length });
  res.end(mp3);
}
// ---------- Ersatz für Google Text-to-Speech ----------
const GVOICES = [
  { languageCodes: ['de-DE'], name: 'de-DE-Chirp3-HD-Charon', ssmlGender: 'MALE', naturalSampleRateHertz: 24000 },
  { languageCodes: ['de-DE'], name: 'de-DE-Chirp3-HD-Aoede', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
  { languageCodes: ['de-DE'], name: 'de-DE-Chirp3-HD-Leda', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
  { languageCodes: ['de-DE'], name: 'de-DE-Neural2-A', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
  { languageCodes: ['en-US'], name: 'en-US-Chirp3-HD-Kore', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
];
async function google(req, res, p) {
  const err = (code, status, message, reason) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message, status, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } })); };
  if (req.headers['x-goog-api-key'] !== 'test-g-key') return err(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID');
  if (req.method === 'GET' && req.url.startsWith('/v1/voices')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voices: GVOICES })); }
  const text = String((p.input && p.input.text) || '');
  if (text.includes('GBILLING')) return err(403, 'PERMISSION_DENIED', 'This API method requires billing to be enabled. Please enable billing on project #123.', 'BILLING_DISABLED');
  if (text.includes('GFEHLER')) return err(500, 'INTERNAL', 'Internal error encountered.');
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_TTS_DELAY || 80)));
  const mp3 = silentMp3(Math.min(3, Math.max(0.3, text.length * 0.02)));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ audioContent: mp3.toString('base64') }));
}
// Ersatz für den Push-Dienst der Geräte (Apple, Google): merkt sich jede Erinnerung, "gone" ist ein abgemeldetes Gerät
const PUSHES = [];
function push(req, res, buf) {
  if (req.url === '/push-log') {
    if (req.method === 'DELETE') PUSHES.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(PUSHES));
  }
  const id = req.url.slice('/push/'.length);
  const h = req.headers;
  PUSHES.push({ id, at: Date.now(), headers: { authorization: h.authorization, encoding: h['content-encoding'], ttl: h.ttl, urgency: h.urgency, type: h['content-type'] }, body: buf.toString('base64') });
  res.writeHead(id === 'gone' ? 410 : 201);
  res.end();
}

// ---------- Sammelaufträge (Message Batches) ----------
// Ein Auftrag ist nach MOCK_BATCH_MS fertig. Mit BATCHLANGSAM im Text erst, wenn ein Test POST /batch-ctl/end schickt.
// BATCHFEHLER irgendwo im Auftrag: die Anfrage p1 geht schief.
const BATCHES = new Map();
let batchNo = 0;
function batchObj(b, base) {
  const ended = b.cancel || b.end || Date.now() - b.created >= b.wait;
  const n = b.requests.length;
  return {
    id: b.id, type: 'message_batch', processing_status: ended ? 'ended' : 'in_progress',
    request_counts: { processing: ended ? 0 : n, succeeded: ended && !b.cancel ? n : 0, errored: 0, canceled: b.cancel ? n : 0, expired: 0 },
    created_at: new Date(b.created).toISOString(), expires_at: new Date(b.created + 864e5).toISOString(), ended_at: ended ? new Date().toISOString() : null,
    cancel_initiated_at: b.cancel ? new Date().toISOString() : null, archived_at: null, results_url: ended ? `${base}/v1/messages/batches/${b.id}/results` : null,
  };
}
function batches(req, res, p, path) {
  const base = `http://${req.headers.host}`;
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (path.startsWith('/batch-ctl')) {
    if (req.method === 'POST' && path === '/batch-ctl/end') for (const b of BATCHES.values()) b.end = true;
    return send(200, [...BATCHES.values()].map(b => ({ id: b.id, n: b.requests.length, cancel: !!b.cancel, polls: b.polls, results: b.results })));
  }
  if (req.headers['x-api-key'] !== 'test-key') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  if (req.method === 'POST' && path === '/v1/messages/batches') {
    const all = JSON.stringify(p.requests || []);
    const b = { id: 'msgbatch_test' + (++batchNo) + Date.now().toString(36), created: Date.now(), wait: all.includes('BATCHLANGSAM') ? 1e12 : Number(process.env.MOCK_BATCH_MS || 2500), requests: p.requests || [], fail: all.includes('BATCHFEHLER'), polls: 0, results: 0 };
    BATCHES.set(b.id, b);
    return send(200, batchObj(b, base));
  }
  const m = path.match(/^\/v1\/messages\/batches\/([\w-]+)(\/results|\/cancel)?$/);
  const b = m && BATCHES.get(m[1]);
  if (!b) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'batch not found' } });
  if (m[2] === '/cancel') { b.cancel = true; return send(200, batchObj(b, base)); }
  if (!m[2]) { b.polls++; return send(200, batchObj(b, base)); }
  b.results++;
  res.writeHead(200, { 'content-type': 'application/binary' });
  for (const r of b.requests) {
    let result;
    if (b.cancel) result = { type: 'canceled' };
    else if (b.fail && r.custom_id === 'p1') result = { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'test' } } };
    else {
      reqNo++;
      const schema = r.params.output_config && r.params.output_config.format && r.params.output_config.format.schema;
      const text = schema ? JSON.stringify(sample(schema)) : 'Test';
      result = { type: 'succeeded', message: { id: 'msg_b' + reqNo, type: 'message', role: 'assistant', model: r.params.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100000, output_tokens: 20000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
    }
    res.write(JSON.stringify({ custom_id: r.custom_id, result }) + '\n');
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks), body = buf.toString();
    if (req.url === '/push-log' || req.url.startsWith('/push/')) return push(req, res, buf);
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ path: req.url, headers: { key: req.headers['x-api-key'], version: req.headers['anthropic-version'], beta: req.headers['anthropic-beta'], xi: req.headers['xi-api-key'], g: req.headers['x-goog-api-key'] }, body: p }) + '\n');
    if (req.url.startsWith('/v2/voices') || req.url.startsWith('/v1/text-to-speech/')) return eleven(req, res, p);
    if (req.url.startsWith('/v1/voices') || req.url.startsWith('/v1/text:synthesize')) return google(req, res, p);
    const path = req.url.split('?')[0];
    if (path.startsWith('/v1/messages/batches') || path.startsWith('/batch-ctl')) return batches(req, res, p, path);
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end(); }
    const last = JSON.stringify((p.messages || []).slice(-1));
    if (req.headers['x-api-key'] !== 'test-key' || last.includes('FEHLER401')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    if (p.fallbacks && !(req.headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks needs beta header' } }));
    }
    reqNo++;
    const isJson = p.output_config && p.output_config.format;
    let text;
    const schema = isJson && p.output_config.format.schema;
    // Bildseiten abschreiben: eine Seite pro Seitenzahl aus der Frage
    const pageNos = schema && schema.properties && schema.properties.seiten ? (last.match(/Auf (?:den Bildern sind die Seiten ([\d, ]+)|dem Bild ist Seite (\d+)) aus/) || []).slice(1).filter(Boolean).join(',').split(/[, ]+/).filter(Boolean).map(Number) : null;
    if (pageNos && last.includes('SEITENFEHLER') && pageNos.includes(5)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test: Seite 5 kaputt' } }));
    }
    if (pageNos) text = JSON.stringify({ seiten: pageNos.map(n => ({ seite: n, text: `Abgeschrieben Seite ${n}: Abbildung der Zellteilung r${reqNo}` })) });
    else if (isJson) text = JSON.stringify(sample(schema));
    else if (last.includes('LANG')) text = 'Teil '.repeat(400);
    else if (last.includes('TABELLE')) text = 'Hier der Vergleich:\n\n| Phase | Was passiert |\n|---|---|\n| Prophase | Chromosomen verdichten sich |\n| Metaphase | Chromosomen in der Mitte |\n\n```mermaid\nflowchart LR\n  A["Prophase"] --> B["Metaphase"]\n```\n\nSo läuft die Mitose ab.';
    else if (last.includes('VORLESEN')) text = Array.from({ length: 12 }, (_, i) => `Satz ${i + 1}: Die Zelle teilt sich in der Mitose in **zwei** gleiche Tochterzellen.`).join(' ') + '\n- Punkt eins\n- Punkt zwei';
    else text = `Hallo! Das ist eine **Testantwort** von Merki.\n- Punkt eins\n- Punkt zwei\nNOTIZ: Testbegriff :: Das ist eine Test-Notiz aus dem Chat.`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; fs.appendFileSync(LOG, JSON.stringify({ aborted: true, at: Date.now() }) + '\n'); } });
    const model = p.model;
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, cache_creation_input_tokens: 800, cache_read_input_tokens: 400, output_tokens: 1 } } });
    sse(res, 'ping', { type: 'ping' });
    let idx = 0;
    if (last.includes('PAUSE')) await new Promise((r) => setTimeout(r, 11500)); // langes Nachdenken ohne Ereignisse
    if (last.includes('FALLBACK')) {
      // Echtes Verhalten: Der angefangene Text bleibt, ein anderes Modell schreibt ihn weiter
      const cut = Math.floor(text.length / 3);
      sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: text.slice(0, cut) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
      sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'fallback', from: { model }, to: { model: 'claude-opus-5' } } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
      text = text.slice(cut);
    }
    sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    const delay = Number(process.env.MOCK_DELAY || 15);
    for (let i = 0; i < text.length && !gone; i += 12) {
      if (last.includes('ABBRUCH') && i > 60) { res.socket.destroy(); return; }
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: text.slice(i, i + 12) } });
      await new Promise((r) => setTimeout(r, delay));
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    const stop = last.includes('REFUSE') ? 'refusal' : 'end_turn';
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 350 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('mock anthropic on', PORT));
