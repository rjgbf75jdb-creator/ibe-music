"""Leitura e gravação de áudio (FFmpeg quando existe; senão, soundfile)."""
import shutil
import subprocess

import numpy as np

SR = 44100
FFMPEG = shutil.which("ffmpeg")


class AudioError(Exception):
    """Erro com mensagem amigável para mostrar no app."""


def load(path, sr=SR):
    """Lê qualquer áudio como array float32 (2, n) em 44,1 kHz."""
    if FFMPEG:
        cmd = [FFMPEG, "-v", "error", "-nostdin", "-i", str(path), "-vn",
               "-ac", "2", "-ar", str(sr), "-f", "f32le", "pipe:1"]
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode != 0:
            raise AudioError("Não consegui ler esse arquivo. Envie um MP3, WAV, M4A ou FLAC.")
        a = np.frombuffer(p.stdout, dtype=np.float32)
        if a.size < sr:
            raise AudioError("O arquivo não tem áudio suficiente.")
        return np.ascontiguousarray(a[: a.size // 2 * 2].reshape(-1, 2).T)
    try:
        import soundfile as sf
        data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception as exc:
        raise AudioError("Sem o FFmpeg instalado, envie MP3, WAV ou FLAC.") from exc
    a = data.T
    if a.shape[0] == 1:
        a = np.repeat(a, 2, axis=0)
    a = a[:2]
    if file_sr != sr:
        import julius
        import torch
        a = julius.resample_frac(torch.from_numpy(np.ascontiguousarray(a)), int(file_sr), sr).numpy()
    return np.ascontiguousarray(a, dtype=np.float32)


def save_mp3(base_path, audio, sr=SR):
    """Grava (2, n) como MP3 192k. Devolve o nome do arquivo criado."""
    audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
    if FFMPEG:
        path = base_path.with_suffix(".mp3")
        cmd = [FFMPEG, "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2",
               "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "192k", str(path)]
        if subprocess.run(cmd, input=audio.T.tobytes(), capture_output=True).returncode == 0:
            return path.name
    import soundfile as sf
    try:
        path = base_path.with_suffix(".mp3")
        sf.write(str(path), audio.T, sr, format="MP3")
        return path.name
    except Exception:
        path = base_path.with_suffix(".wav")
        sf.write(str(path), audio.T, sr, subtype="PCM_16")
        return path.name
