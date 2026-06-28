#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$AGENT_ROOT/.models"
STT_CATALOG="$AGENT_ROOT/scripts/sherpa-stt-catalog.json"
TTS_CATALOG="$AGENT_ROOT/scripts/sherpa-tts-catalog.json"
AGENT_LIVE_TEST_ENV="$AGENT_ROOT/.env.live-test"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd tar
require_cmd curl

if [[ ! -f "$STT_CATALOG" || ! -f "$TTS_CATALOG" ]]; then
  echo "Sherpa model catalogs not found in agent/scripts." >&2
  exit 1
fi

read_catalog_rows() {
  local catalog_file="$1"
  local mode="$2"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const mode = process.argv[2];
const json = JSON.parse(fs.readFileSync(file, "utf8"));
const releaseBase = String(json.releaseBase ?? "").trim();
if (!releaseBase) {
  throw new Error(`Catalog ${file} is missing releaseBase`);
}
const rows = (json.models || []).filter((m) =>
  mode === "stt" ? Boolean(m.bundle && m.kind === "transducer") : Boolean(m.bundle)
);
for (const row of rows) {
  const cols = [
    row.id ?? "",
    row.label ?? "",
    row.kind ?? "",
    row.bundle ?? "",
    row.language ?? "",
    row.speakerId ?? "",
    row.approxMb ?? "",
    releaseBase,
  ];
  process.stdout.write(cols.map((v) => String(v).replaceAll("|", "/")).join("|") + "\n");
}
' "$catalog_file" "$mode"
}

choose_row() {
  local title="$1"
  local prompt="$2"
  local mode="$3"
  shift 3
  local -a rows=("$@")
  local -a labels=()

  for row in "${rows[@]}"; do
    IFS='|' read -r id label kind bundle lang speaker approx _release_base <<<"$row"
    local details="$id — $label"
    if [[ -n "$kind" ]]; then
      details="$details (type: $kind"
      if [[ -n "$lang" ]]; then
        details="$details, lang: $lang"
      fi
      if [[ -n "$speaker" ]]; then
        details="$details, speaker: $speaker"
      fi
      details="$details)"
    elif [[ -n "$lang" ]]; then
      details="$details (lang: $lang"
      if [[ -n "$speaker" ]]; then
        details="$details, speaker: $speaker"
      fi
      details="$details)"
    fi
    if [[ "$mode" == "stt" && "$bundle" == *"ar_en_id_ja_ru_th_vi_zh"* ]]; then
      details="$details [multilingual: ar,en,id,ja,ru,th,vi,zh]"
    fi
    if [[ -n "$approx" ]]; then
      details="$details [$approx MB]"
    fi
    labels+=("$details")
  done

  echo >&2
  echo "$title" >&2
  echo "----------------------------------------" >&2
  local selection
  PS3="$prompt"
  select selection in "${labels[@]}"; do
    if [[ -n "${selection:-}" ]]; then
      local idx=$((REPLY - 1))
      echo "${rows[$idx]}"
      return 0
    fi
    echo "Invalid choice." >&2
  done
}

verify_stt_bundle() {
  local dir="$1"
  if [[ ! -f "$dir/tokens.txt" ]]; then
    echo "Invalid STT model directory (tokens.txt missing): $dir" >&2
    return 1
  fi
  if ! compgen -G "$dir/*encoder*.onnx" >/dev/null; then
    echo "Invalid STT model directory (encoder onnx missing): $dir" >&2
    return 1
  fi
  if ! compgen -G "$dir/*decoder*.onnx" >/dev/null; then
    echo "Invalid STT model directory (decoder onnx missing): $dir" >&2
    return 1
  fi
  if ! compgen -G "$dir/*joiner*.onnx" >/dev/null; then
    echo "Invalid STT model directory (joiner onnx missing): $dir" >&2
    return 1
  fi
}

verify_tts_bundle() {
  local dir="$1"
  if [[ ! -f "$dir/tokens.txt" ]]; then
    echo "Invalid TTS model directory (tokens.txt missing): $dir" >&2
    return 1
  fi
  if ! compgen -G "$dir/*.onnx" >/dev/null; then
    echo "Invalid TTS model directory (onnx model missing): $dir" >&2
    return 1
  fi
  if [[ ! -d "$dir/espeak-ng-data" ]]; then
    echo "Invalid TTS model directory (espeak-ng-data missing): $dir" >&2
    return 1
  fi
}

download_bundle_if_missing() {
  local mode="$1"
  local label="$2"
  local bundle="$3"
  local approx="$4"
  local release_base="$5"
  local target_dir="$MODELS_DIR/$bundle"
  local archive_path="$MODELS_DIR/$bundle.tar.bz2"
  local url="${release_base}/${bundle}.tar.bz2"

  mkdir -p "$MODELS_DIR"

  if [[ -d "$target_dir" ]]; then
    if [[ "$mode" == "stt" ]]; then
      verify_stt_bundle "$target_dir"
    else
      verify_tts_bundle "$target_dir"
    fi
    echo "$label already present: $target_dir"
    return 0
  fi

  if [[ ! -f "$archive_path" ]]; then
    if [[ -n "$approx" ]]; then
      echo "Downloading $label [$approx MB]..."
    else
      echo "Downloading $label..."
    fi
    curl -fsSL --retry 3 --retry-delay 2 -o "$archive_path" "$url"
  fi

  echo "Extracting $archive_path..."
  tar -xjf "$archive_path" -C "$MODELS_DIR"

  if [[ ! -d "$target_dir" ]]; then
    echo "Model directory missing after extraction: $target_dir" >&2
    exit 1
  fi

  if [[ "$mode" == "stt" ]]; then
    verify_stt_bundle "$target_dir"
  else
    verify_tts_bundle "$target_dir"
  fi
}

STT_ROWS=()
while IFS= read -r row; do
  [[ -n "$row" ]] && STT_ROWS+=("$row")
done < <(read_catalog_rows "$STT_CATALOG" "stt")

TTS_ROWS=()
while IFS= read -r row; do
  [[ -n "$row" ]] && TTS_ROWS+=("$row")
done < <(read_catalog_rows "$TTS_CATALOG" "tts")

if [[ "${#STT_ROWS[@]}" -eq 0 || "${#TTS_ROWS[@]}" -eq 0 ]]; then
  echo "No downloadable Sherpa STT/TTS models found in agent catalogs." >&2
  exit 1
fi

echo
echo "Some STT options are aliases for the same multilingual bundle."
STT_ROW="$(choose_row "Select your STT model (speech-to-text)" "Select STT model number: " "stt" "${STT_ROWS[@]}")"
TTS_ROW="$(choose_row "Select your TTS model (text-to-speech)" "Select TTS model number: " "tts" "${TTS_ROWS[@]}")"

IFS='|' read -r STT_ID STT_LABEL _STT_KIND STT_BUNDLE STT_LANGUAGE _STT_SPEAKER STT_MB STT_RELEASE_BASE <<<"$STT_ROW"
IFS='|' read -r TTS_ID TTS_LABEL _TTS_KIND TTS_BUNDLE _TTS_LANGUAGE TTS_SPEAKER TTS_MB TTS_RELEASE_BASE <<<"$TTS_ROW"

if [[ -z "${STT_BUNDLE:-}" || -z "${TTS_BUNDLE:-}" ]]; then
  echo "Model selection failed: empty bundle id returned from menu." >&2
  exit 1
fi

echo
echo "Ensuring selected models are available locally in $MODELS_DIR ..."
download_bundle_if_missing "stt" "$STT_LABEL ($STT_ID)" "$STT_BUNDLE" "$STT_MB" "$STT_RELEASE_BASE"
download_bundle_if_missing "tts" "$TTS_LABEL ($TTS_ID)" "$TTS_BUNDLE" "$TTS_MB" "$TTS_RELEASE_BASE"

STT_PATH="$MODELS_DIR/$STT_BUNDLE"
TTS_PATH="$MODELS_DIR/$TTS_BUNDLE"
ABS_STT_PATH="$(cd "$STT_PATH" && pwd)"
ABS_TTS_PATH="$(cd "$TTS_PATH" && pwd)"

echo
echo "Selected Sherpa models:"
echo "  STT model: $STT_LABEL ($STT_ID)${STT_MB:+ [$STT_MB MB]}"
echo "  TTS model: $TTS_LABEL ($TTS_ID)${TTS_MB:+ [$TTS_MB MB]}"
echo
echo "Export lines:"
echo "export VOICE_STT_PROVIDER=\"local-sherpa\""
echo "export VOICE_TTS_PROVIDER=\"local-sherpa\""
echo "export SHERPA_STT_MODEL_PATH=\"$ABS_STT_PATH\""
echo "export SHERPA_TTS_MODEL_PATH=\"$ABS_TTS_PATH\""
echo "export SHERPA_STT_LANGUAGE=\"${STT_LANGUAGE:-en}\""
if [[ -n "${TTS_SPEAKER:-}" ]]; then
  echo "export SHERPA_TTS_SPEAKER=\"$TTS_SPEAKER\""
fi

touch "$AGENT_LIVE_TEST_ENV"
TMP_FILE="$(mktemp)"
awk '
  BEGIN { skip=0 }
  /# BEGIN COPILOT SHERPA MODELS/ { skip=1; next }
  /# END COPILOT SHERPA MODELS/   { skip=0; next }
  skip == 0 { print }
' "$AGENT_LIVE_TEST_ENV" >"$TMP_FILE"
mv "$TMP_FILE" "$AGENT_LIVE_TEST_ENV"

{
  echo
  echo "# BEGIN COPILOT SHERPA MODELS"
  echo "VOICE_STT_PROVIDER=local-sherpa"
  echo "VOICE_TTS_PROVIDER=local-sherpa"
  echo "SHERPA_STT_MODEL_PATH=$ABS_STT_PATH"
  echo "SHERPA_TTS_MODEL_PATH=$ABS_TTS_PATH"
  echo "SHERPA_STT_LANGUAGE=${STT_LANGUAGE:-en}"
  if [[ -n "${TTS_SPEAKER:-}" ]]; then
    echo "SHERPA_TTS_SPEAKER=$TTS_SPEAKER"
  fi
  echo "# END COPILOT SHERPA MODELS"
} >>"$AGENT_LIVE_TEST_ENV"

echo
echo "Updated $AGENT_LIVE_TEST_ENV"
echo
echo "Done. You can now run:"
echo "  cd \"$AGENT_ROOT\" && npm run live-test:stack"
