# LM TTS (LM Studio + Kokoro)

Small Flask app that lets you chat with an LM Studio model and hear the replies via Kokoro text-to-speech. The `web/` frontend talks to two endpoints: `/api/chat` for combined text + audio replies and `/api/tts` for on-demand speech.

## Requirements
- Python 3.10+ with `pip`
- LM Studio running locally with a chat model loaded and the API server enabled (defaults to `http://127.0.0.1:1234/v1` and key `lm-studio`)
- (Optional) GPU for faster Kokoro inference; otherwise CPU works

## Quickstart
- **Windows (simplest):** double-click `run_server.bat` — it will create/activate `.venv`, install requirements, and start the server.
- **Mac/Linux (or manual):**
  ```bash
  python -m venv .venv
  source .venv/bin/activate
  pip install --upgrade pip
  pip install -r requirements.txt

  # Start LM Studio separately, then run the app:
  python server.py
  ```
Then open http://localhost:5000 in your browser to use the chat UI.

## Config (environment variables)
- `LMSTUDIO_BASE_URL` – Base URL for the LM Studio API (default `http://127.0.0.1:1234/v1`)
- `LMSTUDIO_API_KEY` – API key for LM Studio (default `lm-studio`)
- `LMSTUDIO_MODEL_NAME` – Force a specific model ID; omit to auto-pick the first loaded model
- `KOKORO_REPO_ID` – Hugging Face repo for Kokoro weights (default `hexgrad/Kokoro-82M`)
- `KOKORO_LANG` – Default language code used when parsing `VOICES.md` (single letter, default `a`)
- `KOKORO_VOICE` – Default voice name; must exist in `VOICES.md`
- `KOKORO_SAMPLE_RATE` – Output sample rate (default `24000`)
- `PORT` – Server port (default `5000`)

## Voice catalog
Available voices are read from `VOICES.md`. Each entry exposes a `name` and `lang_code` to the frontend dropdown. Update that file to add or remove voices without touching code.

## How it works
- `/api/models` proxies LM Studio to list available model IDs.
- `/api/chat` sends the conversation to LM Studio, gets a text reply, and immediately synthesizes audio for the selected voice.
- `/api/voices` returns the Kokoro voices parsed from `VOICES.md`.
- `/api/tts` runs Kokoro TTS for arbitrary text (used by the “Speak” buttons).

Local chat history, selected model, voice, and temperature are cached in `localStorage` so your settings persist between refreshes.
