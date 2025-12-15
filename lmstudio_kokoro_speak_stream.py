import re
import queue
import threading
import numpy as np
import sounddevice as sd
import torch
from openai import OpenAI
from kokoro import KModel, KPipeline

# ---------- LM Studio (OpenAI-compatible) ----------
LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1"   # default :contentReference[oaicite:2]{index=2}
LMSTUDIO_API_KEY = "lm-studio"                   # not actually required, but OpenAI client wants a string

MODEL_NAME = "nous-capybara-34b"  # e.g. what LM Studio shows in the Local Server tab

# ---------- Kokoro ----------
KOKORO_REPO_ID = "hexgrad/Kokoro-82M"
KOKORO_LANG = "a"      # English
KOKORO_VOICE = "af_nicole"
SAMPLE_RATE = 24000

# Chunk speech at sentence-ish boundaries
SENT_END_RE = re.compile(r"([.!?]+|\n)")

def split_into_speakable_chunks(buffer: str):
    """
    Return (chunks_to_speak, remainder).
    Speaks complete sentences / lines; keeps remainder for later.
    """
    parts = SENT_END_RE.split(buffer)
    chunks = []
    cur = ""
    for i in range(0, len(parts) - 1, 2):
        text_part = parts[i]
        ender = parts[i + 1]
        cur += text_part + ender
        if cur.strip():
            chunks.append(cur.strip())
        cur = ""

    remainder = ""
    if len(parts) % 2 == 1:
        remainder = parts[-1]  # trailing partial sentence
    return chunks, remainder


def main():
    # 1) Init Kokoro
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = KModel(repo_id=KOKORO_REPO_ID).to(device).eval()
    pipeline = KPipeline(lang_code=KOKORO_LANG, repo_id=KOKORO_REPO_ID, model=model)

    # 2) Audio playback worker (plays chunks sequentially)
    audio_q: queue.Queue[np.ndarray | None] = queue.Queue()

    def audio_player():
        while True:
            audio = audio_q.get()
            if audio is None:
                break
            # Ensure mono float32
            audio = np.asarray(audio, dtype=np.float32)
            sd.play(audio, SAMPLE_RATE, blocking=True)

    t_player = threading.Thread(target=audio_player, daemon=True)
    t_player.start()

    # 3) TTS worker (text -> audio -> queue)
    tts_q: queue.Queue[str | None] = queue.Queue()

    def tts_worker():
        while True:
            text = tts_q.get()
            if text is None:
                audio_q.put(None)
                break
            # Generate audio for this chunk
            try:
                out = next(pipeline(text, voice=KOKORO_VOICE))
                audio_q.put(out.audio)
            except Exception as e:
                print(f"\n[TTS error] {e}\n")

    t_tts = threading.Thread(target=tts_worker, daemon=True)
    t_tts.start()

    # 4) Chat loop
    client = OpenAI(base_url=LMSTUDIO_BASE_URL, api_key=LMSTUDIO_API_KEY)

    messages = []
    print("Type a prompt. Ctrl+C to exit.\n")

    while True:
        user = input("You: ").strip()
        if not user:
            continue

        messages.append({"role": "user", "content": user})
        print("Assistant: ", end="", flush=True)

        buffer = ""
        try:
            stream = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                stream=True,
                temperature=0.7,
            )

            full = ""
            for event in stream:
                delta = event.choices[0].delta
                if delta and delta.content:
                    token = delta.content
                    print(token, end="", flush=True)
                    full += token
                    buffer += token

                    # Speak sentences as soon as they complete
                    chunks, buffer = split_into_speakable_chunks(buffer)
                    for c in chunks:
                        tts_q.put(c)

            print("\n")
            messages.append({"role": "assistant", "content": full})

            # If leftover partial text, speak it too (optional)
            if buffer.strip():
                tts_q.put(buffer.strip())

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"\n[LLM error] {e}\n")

    # shutdown
    tts_q.put(None)
    t_tts.join(timeout=2)

if __name__ == "__main__":
    main()
