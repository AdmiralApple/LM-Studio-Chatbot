import base64
import io
import os
import re
import threading
import time
import wave
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
from flask import Flask, jsonify, request
from flask_cors import CORS
from kokoro import KModel, KPipeline
from openai import OpenAI

# ---------- Configuration ----------
LMSTUDIO_BASE_URL = os.getenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234/v1")
LMSTUDIO_API_KEY = os.getenv("LMSTUDIO_API_KEY", "lm-studio")
LMSTUDIO_MODEL_NAME = os.getenv("LMSTUDIO_MODEL_NAME")  # None => auto-detect

KOKORO_REPO_ID = os.getenv("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")
KOKORO_DEFAULT_LANG = os.getenv("KOKORO_LANG", "a")
SAMPLE_RATE = int(os.getenv("KOKORO_SAMPLE_RATE", "24000"))
VOICES_PATH = Path(__file__).with_name("VOICES.md")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "web")


def _parse_voice_catalog(path: Path, fallback_lang: str) -> Dict[str, Dict[str, str]]:
    voices: Dict[str, Dict[str, str]] = {}
    if not path.exists():
        return voices

    lang_code = fallback_lang
    lang_re = re.compile(r"lang_code='([a-z])'", re.IGNORECASE)

    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue

            lang_match = lang_re.search(line)
            if lang_match:
                lang_code = lang_match.group(1)
                continue

            if not line.startswith("|") or line.startswith("| Name") or line.startswith("| ----"):
                continue

            cells = [c.strip() for c in line.split("|")[1:-1]]
            if not cells:
                continue

            name_cell = cells[0]
            # Remove markdown emphasis/escape characters (e.g., "**af\_heart**" -> "af_heart")
            name = re.sub(r"[`*]", "", name_cell).replace("\\_", "_").strip()
            if not name or name.lower() == "name":
                continue

            voices[name] = {"lang": lang_code}

    return voices


# ---------- App + Clients ----------
app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
CORS(app)

client = OpenAI(base_url=LMSTUDIO_BASE_URL, api_key=LMSTUDIO_API_KEY)

device = "cuda" if torch.cuda.is_available() else "cpu"
kokoro_model = KModel(repo_id=KOKORO_REPO_ID).to(device).eval()
tts_lock = threading.Lock()
pipelines: Dict[str, KPipeline] = {}
_model_cache: dict[str, float | List[str]] = {"ts": 0.0, "models": []}
MODEL_CACHE_TTL = 30.0  # seconds

voice_catalog = _parse_voice_catalog(VOICES_PATH, KOKORO_DEFAULT_LANG)
DEFAULT_VOICE = os.getenv("KOKORO_VOICE", "af_nicole")
if DEFAULT_VOICE not in voice_catalog:
    DEFAULT_VOICE = next(iter(voice_catalog.keys()), DEFAULT_VOICE or "af_nicole")
    if DEFAULT_VOICE not in voice_catalog:
        voice_catalog[DEFAULT_VOICE] = {"lang": KOKORO_DEFAULT_LANG}


def get_voice_info(requested: Optional[str]) -> tuple[str, str]:
    voice = (requested or DEFAULT_VOICE or "").strip()
    info = voice_catalog.get(voice)
    if not info:
        raise ValueError(f"Voice '{voice}' is not available.")
    return voice, info["lang"]


def get_pipeline(lang_code: str) -> KPipeline:
    pipeline = pipelines.get(lang_code)
    if pipeline is None:
        pipeline = KPipeline(
            lang_code=lang_code, repo_id=KOKORO_REPO_ID, model=kokoro_model
        )
        pipelines[lang_code] = pipeline
    return pipeline


def _audio_to_wav_base64(audio: np.ndarray) -> str:
    """Convert Kokoro float audio to base64 wav bytes."""
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().cpu().numpy()
    arr = np.asarray(audio, dtype=np.float32).flatten()
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())

    return base64.b64encode(buf.getvalue()).decode("ascii")


def synthesize_audio(
    text: str, voice_name: Optional[str] = None
) -> Tuple[str, str]:
    resolved_voice, lang_code = get_voice_info(voice_name)

    clean_text = (text or "").strip()
    if not clean_text:
        raise ValueError("No text provided to synthesize.")

    last_error: Optional[Exception] = None
    for attempt in (0, 1):
        pipeline = get_pipeline(lang_code)

        try:
            with tts_lock:
                segments: List[np.ndarray] = []
                for chunk in pipeline(clean_text, voice=resolved_voice):
                    audio = chunk.audio
                    if isinstance(audio, torch.Tensor):
                        audio = audio.detach().cpu().numpy()
                    arr = np.asarray(audio, dtype=np.float32).flatten()
                    if arr.size:
                        segments.append(arr)
                if not segments:
                    raise RuntimeError("Kokoro returned empty audio.")
                audio = np.concatenate(segments)
            return _audio_to_wav_base64(audio), resolved_voice
        except Exception as exc:  # pragma: no cover - safety net for runtime TTS failures
            last_error = exc
            # Reset the cached pipeline in case it got into a bad state for this language.
            pipelines.pop(lang_code, None)
            if attempt == 0:
                continue
            error_msg = f"TTS failed for voice '{resolved_voice}': {exc}"
            app.logger.error(error_msg)
            raise RuntimeError(error_msg) from exc

    raise RuntimeError(
        f"TTS failed for voice '{resolved_voice}': {last_error}"
    ) from last_error


def _fetch_lmstudio_models() -> List[str]:
    """Query LM Studio for available model IDs."""
    try:
        response = client.models.list()
    except Exception as exc:
        app.logger.warning("Failed to fetch LM Studio models: %s", exc)
        return []

    data = getattr(response, "data", []) or []
    return [getattr(model, "id", "") for model in data if getattr(model, "id", "")]


def available_models(force_refresh: bool = False) -> List[str]:
    """Return cached list of LM Studio models or query again."""
    if LMSTUDIO_MODEL_NAME:
        return [LMSTUDIO_MODEL_NAME]

    now = time.monotonic()
    cached = _model_cache["models"]
    ts = _model_cache["ts"]
    if not force_refresh and cached and now - ts < MODEL_CACHE_TTL:
        return cached  # type: ignore[return-value]

    models = _fetch_lmstudio_models()
    if models:
        _model_cache["models"] = models
        _model_cache["ts"] = now
        return models

    return cached or []  # type: ignore[return-value]


def resolve_model_name(requested: Optional[str] = None) -> str:
    """Pick a model for the current completion request."""
    if requested:
        return requested

    models = available_models()
    if not models:
        raise RuntimeError("No LM Studio model is currently loaded.")
    return models[0]


@app.route("/api/chat", methods=["POST"])
def chat():
    payload = request.get_json(force=True) or {}
    messages: List[dict] = payload.get("messages", [])
    temperature = float(payload.get("temperature", 0.7))
    requested_voice = payload.get("voice")

    if not messages:
        return jsonify({"error": "messages are required"}), 400

    try:
        resolved_voice, _ = get_voice_info(requested_voice)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        model_name = resolve_model_name(payload.get("model"))
        completion = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=temperature,
        )
        content = completion.choices[0].message.content or ""
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        app.logger.error("LLM failure: %s", exc)
        return jsonify({"error": str(exc)}), 500

    try:
        audio_b64, resolved_voice = synthesize_audio(content, resolved_voice)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {"content": content, "audio": audio_b64, "model": model_name, "voice": resolved_voice}
    )


@app.route("/api/tts", methods=["POST"])
def tts():
    payload = request.get_json(force=True) or {}
    text = payload.get("text", "")
    voice = payload.get("voice")

    try:
        audio_b64, resolved_voice = synthesize_audio(text, voice)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"audio": audio_b64, "voice": resolved_voice})


@app.route("/api/models", methods=["GET"])
def list_models():
    models = available_models(force_refresh=True)
    return jsonify({"models": models})


@app.route("/api/voices", methods=["GET"])
def list_voices():
    voices = [
        {"name": name, "lang_code": meta["lang"]}
        for name, meta in sorted(voice_catalog.items())
    ]
    return jsonify({"voices": voices, "default": DEFAULT_VOICE})


@app.route("/")
def root():
    return app.send_static_file("index.html")


@app.errorhandler(404)
def not_found(_):
    return app.send_static_file("index.html")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
