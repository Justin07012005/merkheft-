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
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ path: req.url, headers: { key: req.headers['x-api-key'], version: req.headers['anthropic-version'], beta: req.headers['anthropic-beta'], xi: req.headers['xi-api-key'], g: req.headers['x-goog-api-key'] }, body: p }) + '\n');
    if (req.url.startsWith('/v2/voices') || req.url.startsWith('/v1/text-to-speech/')) return eleven(req, res, p);
    if (req.url.startsWith('/v1/voices') || req.url.startsWith('/v1/text:synthesize')) return google(req, res, p);
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
    if (isJson) text = JSON.stringify(sample(p.output_config.format.schema));
    else if (last.includes('LANG')) text = 'Teil '.repeat(400);
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
