# Merkheft

Lern-App mit KI für Handy und Tablet. Die KI heißt Merki: Sie schreibt das Wichtigste aus Chats, Sprachnotizen und Dateien in die Notizen und macht daraus Karteikarten, Quiz, Memory und einen Lernplan bis zur Prüfung. Man kann mit Merki auch reden wie am Telefon und Notizen auf einem Blatt tippen oder mit dem Apple Pencil schreiben. Farbe und Hell/Dunkel lassen sich in den Einstellungen wählen und gelten auf allen Geräten.

Die App läuft als Cloudflare Worker. Die KI läuft über deinen Claude-API-Schlüssel. Der Schlüssel liegt nur als Secret in Cloudflare und kommt nie in die App oder ins Repo.

## Einrichten (einmalig)

1. Im Cloudflare-Dashboard: **Workers & Pages** → **Create** → **Import a repository** → dieses Repo auswählen. Als Namen `merkheft` eintragen (wie in `wrangler.toml`), auch wenn das Repo anders heißt. Dann **Deploy**.
2. Im neuen Worker: **Settings** → **Variables and Secrets** → **Add**, zweimal mit Typ **Secret**:
   - `ANTHROPIC_API_KEY`: dein Claude-API-Schlüssel
   - `APP_CODE`: ein Zugangscode, mindestens 8 Zeichen

   Wichtig: Typ **Secret**, nicht Text. Sonst sind die Werte beim nächsten Deploy weg.

   Prüfen: `https://merkheft.<deine-subdomain>.workers.dev/api/health` muss `"key":true` und `"code":true` zeigen. Steht dort noch `false`, hat die laufende Version die Secrets noch nicht. Dann unter **Deployments** die neueste Version deployen oder mit einem Push auf `main` neu bauen lassen.
3. Der Link zum Weitergeben: `https://merkheft.<deine-subdomain>.workers.dev/#code=<APP_CODE>`

   Das Gerät merkt sich den Code beim ersten Öffnen.
4. Als App auf dem iPad oder iPhone: den Link in Safari öffnen, dann **Teilen** → **Zum Home-Bildschirm**. Das App-Symbol bekommt den Code mit, die App startet danach ohne Code-Eingabe und öffnet sich auch ohne Internet.

Jeder Push auf `main` wird danach automatisch veröffentlicht.

## Echte Stimme für Merki (freiwillig)

Ohne weiteren Schlüssel spricht Merki mit der Stimme des Geräts. Mit einem Sprachdienst klingt Merki wie ein Mensch.

### Google (kostenlos)

Google schenkt jeden Monat 1 Million Zeichen mit den natürlichen Chirp-3-HD-Stimmen. Merki hört bei 900.000 Zeichen im Monat auf (`TTS_MONATS_ZEICHEN`), so kostet es nichts.

1. Auf [console.cloud.google.com](https://console.cloud.google.com) mit einem Google-Konto anmelden und ein Projekt anlegen, zum Beispiel „merkheft“.
2. **Abrechnung** für das Projekt einschalten. Google will dafür eine Karte, auch für die kostenlose Menge. Wer sicher gehen will, legt unter **Budgets und Benachrichtigungen** ein Budget von 1 € mit E-Mail-Warnung an.
3. Unter **APIs und Dienste** → **Bibliothek** die **Cloud Text-to-Speech API** suchen und aktivieren.
4. Unter **APIs und Dienste** → **Anmeldedaten** → **Anmeldedaten erstellen** → **API-Schlüssel**. Den Schlüssel bearbeiten und unter **API-Einschränkungen** nur die Cloud Text-to-Speech API erlauben.
5. Im Worker: **Settings** → **Variables and Secrets** → **Add**, Typ **Secret**: `GOOGLE_TTS_KEY`.

Merki nimmt die Stimme Aoede. In den Einstellungen der App lassen sich die anderen deutschen Chirp-3-HD-Stimmen wählen.

### ElevenLabs (mit Abo)

1. Bei [elevenlabs.io](https://elevenlabs.io) ein Konto anlegen und das kleinste Abo (**Starter**) wählen. Das kostenlose Konto sperrt ElevenLabs meist, sobald ein Server wie Cloudflare fragt. In der **Voice Library** eine deutsche Stimme suchen und zu den eigenen Stimmen hinzufügen.
2. Im ElevenLabs-Konto unter **API Keys** einen Schlüssel erstellen. Wenn nach Rechten gefragt wird, reichen Text to Speech und Voices (lesen).
3. Im Worker als Secret `ELEVENLABS_API_KEY` eintragen. Sind beide Schlüssel da, spricht Google, außer `TTS_ANBIETER` ist `elevenlabs`.

Merki nutzt bei ElevenLabs das Modell v4 Turbo. Lehnt ElevenLabs eine Anfrage damit ab, springt Flash v2.5 ein.

Klappt die echte Stimme einmal nicht, liest die Gerätestimme den Satz. Den Grund (zum Beispiel fehlende Abrechnung bei Google) zeigen die Einstellungen der App.

## Kosten

- `TAGES_BUDGET_USD` in `wrangler.toml` (Standard 3 Dollar): Mehr gibt Merki pro Tag nicht aus, danach ist Pause bis zum nächsten Tag.
- `MODEL` in `wrangler.toml`: welches Claude-Modell Merki nutzt. Voreingestellt ist ein günstiges Modell, ein Opus-Modell ist noch stärker, kostet aber etwa das Doppelte.
- `TTS_TAGES_ZEICHEN` in `wrangler.toml` (Standard 5000, etwa 5 Minuten): So viel spricht Merki pro Tag mit der echten Stimme, danach bis zum nächsten Tag mit der Gerätestimme.
- `TTS_MONATS_ZEICHEN` in `wrangler.toml` (Standard 900.000): So viel spricht Merki pro Monat mit der echten Stimme. Das bleibt unter Googles kostenloser Menge.
- Den Verbrauch von heute zeigt die App unter **Einstellungen**.

## Aufbau

- `public/index.html`: die ganze App (läuft auch als Claude-Artifact)
- `public/sw.js`, `public/manifest.webmanifest`: damit sie sich wie eine App installieren und offline öffnen lässt
- `src/index.ts`: Server mit Zugangscode, KI, echter Stimme, Tageslimits und dem App-Symbol für den Home-Bildschirm
- `src/store.ts`: Speicher (Durable Object mit SQLite), Handy und Tablet gleichen sich darüber ab

## Lokal testen

```sh
npm install
cp .dev.vars.example .dev.vars   # Werte eintragen
npm run dev                      # http://localhost:8787
npm run check                    # TypeScript prüfen
```

Ohne echte Kosten testen: `node test/mock-anthropic.mjs` starten und in `.dev.vars` die Zeile mit `ANTHROPIC_BASE_URL` einschalten. Der Ersatz kann auch Google und ElevenLabs spielen: `GOOGLE_TTS_KEY=test-g-key` und `GOOGLE_TTS_BASE_URL=http://127.0.0.1:8788`, oder `ELEVENLABS_API_KEY=test-el-key` und `ELEVENLABS_BASE_URL=http://127.0.0.1:8788`.
