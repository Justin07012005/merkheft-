#!/bin/zsh
# Video mit gesprochenem Feedback auswerten (zum Beispiel eine Bildschirmaufnahme vom iPhone mit Mikrofon):
# Standbilder alle paar Sekunden und eine Mitschrift mit Zeitangaben. Läuft nur auf dem Mac, nichts wird hochgeladen.
#
#   tools/video-feedback.sh <video> [sekunden zwischen bildern, standard 3]
#
# Ergebnis in ~/merkheft-videos/<name>/: bilder/b_0001.jpg … (Bild k zeigt Sekunde (k-1)·N), mitschrift.srt und mitschrift.txt
# Braucht ffmpeg und whisper-cpp (brew install ffmpeg whisper-cpp) und ein Sprachmodell in ~/whisper-models.
set -euo pipefail

video="${1:?Bitte ein Video angeben}"
every="${2:-3}"
model="${WHISPER_MODEL:-$HOME/whisper-models/ggml-large-v3-turbo-q5_0.bin}"
name="$(basename "${video%.*}")"
out="$HOME/merkheft-videos/$name"

[[ -f "$video" ]] || { echo "Video nicht gefunden: $video" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out/bilder"

# Standbilder, höchstens 1000 Pixel breit (reicht zum Lesen, spart Platz)
ffmpeg -hide_banner -loglevel error -y -i "$video" -vf "fps=1/$every,scale='min(1000,iw)':-2" -q:v 4 "$out/bilder/b_%04d.jpg"

secs="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video" | cut -d. -f1)"
bilder="$(ls "$out/bilder" | wc -l | tr -d ' ')"

# Ton nur, wenn das Video eine Tonspur hat (Bildschirmaufnahme ohne Mikrofon hat keine)
if [[ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$video")" ]]; then
  ffmpeg -hide_banner -loglevel error -y -i "$video" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$out/ton.wav"
  whisper-cli -m "$model" -l de -f "$out/ton.wav" -osrt -otxt -of "$out/mitschrift" > "$out/whisper.log" 2>&1
  rm -f "$out/ton.wav"
  echo "Fertig: ${secs:-?} s Video, $bilder Bilder (alle $every s), Mitschrift in $out/mitschrift.srt"
else
  echo "Fertig: ${secs:-?} s Video, $bilder Bilder (alle $every s). Keine Tonspur, also keine Mitschrift."
fi
echo "$out"
