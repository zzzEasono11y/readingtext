import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import shutil
import numpy as np

spec = importlib.util.spec_from_file_location("voice_worker", Path(__file__).resolve().parents[1] / "src/voice_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class VoiceAudioTests(unittest.TestCase):
    def test_reference_manifest_validates_all_files_and_rejects_tampering_and_traversal(self):
        source = Path(__file__).resolve().parents[1] / 'assets/voice'
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for filename in ['voices.json', 'Serena-reference.wav', 'Vivian-reference.wav', 'Uncle_Fu-reference.wav']:
                shutil.copyfile(source / filename, directory / filename)
            ref = directory / 'Serena-reference.wav'
            self.assertEqual(set(worker.voice_references(ref)), {'Serena', 'Vivian', 'Uncle_Fu'})
            (directory / 'Vivian-reference.wav').write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                worker.voice_references(ref)
            manifest = json.loads((directory / 'voices.json').read_text(encoding='utf-8'))
            manifest['Vivian']['reference'] = '../outside.wav'
            (directory / 'voices.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaises(ValueError):
                worker.voice_references(ref)

    def tone(self, level=.1, seconds=1, sr=24000):
        return (level * np.sin(np.arange(int(sr * seconds)) * 2 * np.pi * 220 / sr)).astype(np.float32)

    def test_trims_excess_silence_but_preserves_word_edges(self):
        speech = self.tone()
        original = np.concatenate([np.zeros(24000), speech, np.zeros(24000)])
        result = worker.condition_audio(original, 24000)
        self.assertAlmostEqual(len(result) / 24000, 1.1, delta=.02)
        self.assertGreater(len(result), len(speech))
        self.assertEqual(result[0], 0)
        self.assertEqual(result[-1], 0)

    def test_balances_levels_without_clipping_or_changing_pitch(self):
        quiet = worker.condition_audio(self.tone(.06), 24000)
        loud = worker.condition_audio(self.tone(.14), 24000)
        rms = lambda audio: float(np.sqrt(np.mean(audio ** 2)))
        self.assertLess(rms(loud) / rms(quiet), 1.4)
        self.assertLessEqual(np.max(np.abs(worker.condition_audio(self.tone(2), 24000))), .94001)
        peak = np.argmax(np.abs(np.fft.rfft(quiet))) * 24000 / len(quiet)
        self.assertAlmostEqual(peak, 220, delta=2)

    def test_fade_is_short_and_does_not_overwrite_the_sentence(self):
        original = np.full(24000, .08, dtype=np.float32)
        result = worker.condition_audio(original, 24000)
        self.assertEqual(len(result), len(original))
        self.assertEqual(result[0], 0)
        self.assertEqual(result[-1], 0)
        self.assertAlmostEqual(float(result[240]), .075, places=5)

    def test_rejects_empty_silent_and_non_finite_results(self):
        for audio in [[], np.zeros(24000), [np.nan], [np.inf]]:
            with self.assertRaises(ValueError):
                worker.condition_audio(audio, 24000)

    def test_stream_has_one_gain_and_no_fades_or_missing_samples_at_chunk_joins(self):
        processor = worker.StreamAudio(24000)
        original = np.full(24000 * 3, .08, dtype=np.float32)
        pieces = [processor.push(piece) for piece in np.array_split(original, 7)]
        self.assertGreater(len(pieces[0]), 0)  # audio is emitted before the paragraph ends
        result = np.concatenate(pieces + [processor.push([], final=True)])
        self.assertEqual(len(result), len(original))
        self.assertEqual(result[0], 0)
        self.assertEqual(result[-1], 0)
        np.testing.assert_allclose(result[240:-240], .075, atol=.00001)

    def test_stream_trims_only_outer_silence_and_preserves_internal_pause(self):
        processor = worker.StreamAudio(24000)
        original = np.concatenate([np.zeros(24000), self.tone(), np.zeros(4800), self.tone(), np.zeros(24000)])
        result = np.concatenate([processor.push(original), processor.push([], final=True)])
        # Trailing silence already sent cannot be recalled; the rolling tail removes at most 250 ms.
        self.assertLess(len(result), len(original))
        self.assertGreater(np.count_nonzero(result == 0), 4800)
        self.assertLessEqual(np.max(np.abs(result)), .94001)

    def test_stream_rejects_non_finite_audio_and_silence(self):
        for audio in [[np.nan], [np.inf], []]:
            with self.assertRaises(ValueError):
                worker.StreamAudio(24000).push(audio, final=True)

    def test_mp3_encoder_emits_decodable_audio_before_close(self):
        import io
        import soundfile as sf
        output = io.BytesIO()
        encoder = sf.SoundFile(output, 'w', samplerate=24000, channels=1, format='MP3', compression_level=0.0, bitrate_mode='CONSTANT')
        encoder.write(self.tone(seconds=2)); encoder.flush()
        before = output.getvalue()
        self.assertGreater(len(before), 1000)
        encoder.write(self.tone(seconds=2)); encoder.close()
        decoded, sr = sf.read(io.BytesIO(output.getvalue()))
        self.assertEqual(sr, 24000)
        self.assertGreater(len(decoded), 24000 * 3.8)


if __name__ == "__main__":
    unittest.main()
