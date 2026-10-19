"""Build the two bundled synthetic references from the pinned, already installed model."""
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
import numpy as np
import soundfile as sf
import torch
from faster_qwen3_tts import FasterQwen3TTS

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "src"))
from voice_worker import condition_audio

home = Path(sys.argv[1]).resolve()
assert json.loads((home / "ready.json").read_text(encoding="utf-8"))["revision"] == "0c0e3051f131929182e2c023b9537f8b1c68adfe"
assert torch.cuda.is_available()
torch.set_num_threads(4)
model = FasterQwen3TTS.from_pretrained(str(home / "model"), device="cuda:0", dtype=torch.bfloat16,
                                    attn_implementation="sdpa", local_files_only=True)
folder = root / "assets/voice"
manifest = json.loads((folder / "voices.json").read_text(encoding="utf-8"))
text = "清晨，窗边的光落在翻开的书页上。你不必急着读完，只要在这一刻，给自己留一点安静的时间。"
for speaker, description in [("Vivian", "明亮女声"), ("Uncle_Fu", "醇厚男声")]:
    torch.manual_seed(1627)
    pieces = []
    for piece, sr, _ in model.generate_custom_voice_streaming(text=text, speaker=speaker, language="Chinese",
            instruct="平静、自然地叙述，语气克制，保持清晰的中文发音。", temperature=.6, top_k=30,
            repetition_penalty=1.08, chunk_size=24, max_new_tokens=600):
        pieces.append(piece)
    audio = condition_audio(np.concatenate(pieces), sr)
    assert sr == 24000 and 2 < len(audio) / sr < 25
    file = folder / f"{speaker}-reference.wav"
    sf.write(str(file), audio, sr, subtype="PCM_16")
    manifest[speaker] = {"name": speaker, "description": description, "reference": file.name, "text": text,
                         "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    print(f"{speaker}: {len(audio) / sr:.2f}s", flush=True)
(folder / "voices.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
