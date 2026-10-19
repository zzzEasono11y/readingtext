"""Serena runs locally; JSON lines use stdout, model logs use stderr."""
import concurrent.futures
import base64
import contextlib
import io
import hashlib
import json
from pathlib import Path
import sys
import threading
import time

output = sys.stdout
lock = threading.Lock()


def reply(value):
    with lock:
        output.write(json.dumps(value, ensure_ascii=False) + "\n")
        output.flush()


def download(root, model, revision):
    from huggingface_hub import snapshot_download
    snapshot_download(model, revision=revision, local_dir=str(root / "model-continuous"))


def condition_audio(samples, sr):
    import numpy as np
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError("没有生成有效声音")
    hop = max(1, int(sr * .01))
    padded = np.pad(audio, (0, (-len(audio)) % hop))
    rms = np.sqrt(np.mean(padded.reshape(-1, hop) ** 2, axis=1))
    voiced = np.flatnonzero(rms > max(.0025, float(rms.max()) * .02))
    if not voiced.size:
        raise ValueError("生成的声音为空白")
    start = max(0, int(voiced[0]) * hop - int(sr * .04))
    end = min(len(audio), (int(voiced[-1]) + 1) * hop + int(sr * .06))
    audio = audio[start:end].copy()
    level = float(np.sqrt(np.mean(audio ** 2)))
    gain = min(float(np.clip(.075 / max(level, .0001), .63, 1.58)), .94 / max(float(np.max(np.abs(audio))), .0001))
    audio *= gain
    edge = min(int(sr * .008), len(audio) // 2)
    if edge:
        ramp = np.linspace(0, 1, edge, dtype=np.float32)
        audio[:edge] *= ramp
        audio[-edge:] *= ramp[::-1]
    return audio


class StreamAudio:
    """Keep gain fixed for a paragraph; never trim or fade between chunks."""
    def __init__(self, sr):
        import numpy as np
        self.sr = sr
        self.pending = np.array([], dtype=np.float32)
        self.gain = None
        self.first = True

    def push(self, samples, final=False):
        import numpy as np
        piece = np.asarray(samples, dtype=np.float32).reshape(-1)
        if not np.isfinite(piece).all():
            raise ValueError("声音数据无效")
        if self.gain is not None:
            piece = np.clip(piece * self.gain, -.94, .94)
        self.pending = np.concatenate([self.pending, piece])
        if self.gain is None:
            voiced = np.flatnonzero(np.abs(self.pending) > .0025)
            if not voiced.size:
                self.pending = self.pending[-int(self.sr * .04):]
                if final:
                    raise ValueError("生成的声音为空白")
                return np.array([], dtype=np.float32)
            self.pending = self.pending[max(0, int(voiced[0]) - int(self.sr * .04)):]
            level = float(np.sqrt(np.mean(self.pending ** 2)))
            self.gain = min(float(np.clip(.075 / max(level, .0001), .63, 1.58)), .94 / max(float(np.max(np.abs(self.pending))), .0001))
            self.pending *= self.gain
        if final:
            voiced = np.flatnonzero(np.abs(self.pending) > .0025)
            self.pending = self.pending[:min(len(self.pending), int(voiced[-1]) + int(self.sr * .06) + 1)] if voiced.size else self.pending[:0]
            count = len(self.pending)
        else:
            count = max(0, len(self.pending) - int(self.sr * .25))
        result = self.pending[:count].copy()
        self.pending = self.pending[count:]
        edge = min(int(self.sr * .008), len(result))
        if edge and self.first:
            result[:edge] *= np.linspace(0, 1, edge)
            self.first = False
        if final and edge:
            result[-edge:] *= np.linspace(1, 0, edge)
        return result


def voice_references(reference):
    directory = reference.resolve().parent
    voices = json.loads((directory / 'voices.json').read_text(encoding='utf-8'))
    if set(voices) != {'Serena', 'Vivian', 'Uncle_Fu'}:
        raise ValueError('音色清单无效')
    for value in voices.values():
        filename = (directory / value['reference']).resolve()
        if filename.parent != directory or hashlib.sha256(filename.read_bytes()).hexdigest() != value['sha256']:
            raise ValueError('音色参考文件校验失败')
        value['audio'] = str(filename)
    return voices


def serve(root, reference):
    import numpy as np
    import soundfile as sf
    import torch
    from faster_qwen3_tts import FasterQwen3TTS

    voices = voice_references(reference)
    if not torch.cuda.is_available():
        raise RuntimeError("此体验版需要支持 CUDA 的 NVIDIA 显卡。")
    torch.set_num_threads(4)
    with contextlib.redirect_stdout(sys.stderr):
        model = FasterQwen3TTS.from_pretrained(str(root / "model-continuous"), device="cuda:0",
                                             dtype=torch.bfloat16, attn_implementation="sdpa", local_files_only=True)
    audio_dir = root / "audio"
    audio_dir.mkdir(exist_ok=True)
    for old in audio_dir.glob("*.wav"):
        old.unlink(missing_ok=True)
    epoch = [0]
    reference_text = voices['Serena']['text']

    # Prepare graphs and the fixed reference once, before accepting playback work.
    with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
        warm = model.generate_voice_clone_streaming(text="留一点时间，给阅读。", language="Chinese", ref_audio=str(reference),
                                                   ref_text=reference_text, append_silence=True, chunk_size=12, max_new_tokens=60)
        with contextlib.closing(warm):
            next(warm)

    def generate(request):
        expected = request["epoch"]
        if expected != epoch[0]:
            reply({"id": request["id"], "error": "朗读任务已取消。"})
            return
        try:
            voice = voices[request.get('speaker', 'Serena')]
            started = time.perf_counter()
            torch.manual_seed(1627)
            streaming = request.get("stream", False)
            encoded = io.BytesIO()
            encoder = None
            sent = 0
            conditioner = None
            def send_encoded():
                nonlocal sent
                data = encoded.getvalue()
                if len(data) > sent:
                    reply({"id": request["id"], "chunk": base64.b64encode(data[sent:]).decode("ascii")})
                    sent = len(data)
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                generator = model.generate_voice_clone_streaming(
                    text=request["text"], language="Chinese", ref_audio=voice['audio'], ref_text=voice['text'],
                    xvec_only=False, append_silence=True, temperature=.6, top_k=30, repetition_penalty=1.08,
                    instruct=("保持参考声音的音色和温柔叙述方式，根据文意轻微调整重音、停顿和语气，情绪克制，避免突然改变音高或夸张表演。" if request.get("style") == "natural" else None),
                    max_new_tokens=1800, chunk_size=12 if streaming else 24)
                pieces = []
                with contextlib.closing(generator):
                    for piece, sr, _ in generator:
                        if expected != epoch[0]:
                            reply({"id": request["id"], "error": "朗读任务已取消。"})
                            return
                        if streaming:
                            if encoder is None:
                                encoder = sf.SoundFile(encoded, "w", samplerate=sr, channels=1, format="MP3", compression_level=0.0, bitrate_mode="CONSTANT")
                                conditioner = StreamAudio(sr)
                            encoder.write(conditioner.push(piece))
                            encoder.flush()
                            send_encoded()
                        else:
                            pieces.append(piece)
            if expected != epoch[0]:
                reply({"id": request["id"], "error": "朗读任务已取消。"})
                return
            if streaming:
                if encoder is None:
                    raise ValueError("没有生成声音")
                encoder.write(conditioner.push([], final=True))
                encoder.close()
                send_encoded()
                reply({"id": request["id"], "done": True, "elapsed": time.perf_counter() - started})
            else:
                audio = condition_audio(np.concatenate(pieces) if pieces else np.array([]), sr)
                sf.write(str(audio_dir / (request["id"] + ".wav")), audio, sr, subtype="PCM_16")
                reply({"id": request["id"], "seconds": len(audio) / sr, "elapsed": time.perf_counter() - started})
        except Exception as error:
            print(repr(error), file=sys.stderr)
            reply({"id": request["id"], "error": "声音生成失败，请重试。"})
        finally:
            if 'encoder' in locals() and encoder is not None and not encoder.closed:
                encoder.close()

    reply({"ready": True})
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("cancel"):
                epoch[0] = request["epoch"]
            else:
                executor.submit(generate, request)
        epoch[0] += 1


if __name__ == "__main__":
    sys.stdout = sys.stderr
    directory = Path(sys.argv[2]).resolve()
    if sys.argv[1] == "--download":
        download(directory, sys.argv[3], sys.argv[4])
    elif sys.argv[1] == "--check":
        import torch
        import faster_qwen3_tts
        if not torch.cuda.is_available():
            raise RuntimeError("此体验版需要支持 CUDA 的 NVIDIA 显卡。")
        for filename in ["model.safetensors", "speech_tokenizer/model.safetensors"]:
            if (directory / "model-continuous" / filename).stat().st_size < 1000000:
                raise RuntimeError("语音模型下载不完整。")
    else:
        serve(directory, Path(sys.argv[3]))
