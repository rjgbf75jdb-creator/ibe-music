"""Análise musical do Ibe Music: BPM, batidas, tom e acordes.

Usa só numpy (sem librosa/numba), para instalar fácil em qualquer PC.
"""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

# Perfis de Krumhansl-Kessler (maior e menor)
_KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
# Harmônicos: (número, peso) -> desvio em semitons relativo à nota
_HARMONICS = [(1, 1.0), (2, 0.6), (3, 0.36), (4, 0.22), (5, 0.13), (6, 0.08)]


def _mono(x):
    x = np.asarray(x, dtype=np.float32)
    return x.mean(axis=0) if x.ndim == 2 else x


def _rms(y):
    return float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))) if len(y) else 0.0


def _stft_mag(y, n_fft, hop, chunk=256):
    """Gera blocos (quadros x bins) de magnitude sem estourar a memória.
    O quadro f fica centralizado em f*hop amostras."""
    win = np.hanning(n_fft + 1)[:-1].astype(np.float32)
    y = np.pad(np.asarray(y, dtype=np.float32), (n_fft // 2, n_fft // 2))
    if len(y) < n_fft:
        y = np.pad(y, (0, n_fft - len(y)))
    frames = sliding_window_view(y, n_fft)[::hop]
    for s in range(0, len(frames), chunk):
        yield np.abs(np.fft.rfft(frames[s:s + chunk] * win, axis=1)).astype(np.float32)


# ---------------------------------------------------------------- ritmo

def _onset_envelopes(y, sr, n_bands=40):
    """Fluxo espectral (geral e de graves) e quadros por segundo."""
    hop = max(256, int(round(sr * 512 / 22050)))
    n_fft = 4 * hop
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    edges = np.geomspace(30.0, min(8000.0, sr * 0.45), n_bands + 1)
    band = np.digitize(freqs, edges) - 1
    ok = (band >= 0) & (band < n_bands)
    M = np.zeros((n_bands, len(freqs)), dtype=np.float32)
    M[band[ok], np.where(ok)[0]] = 1.0
    M /= np.maximum(M.sum(axis=1, keepdims=True), 1.0)
    B = np.vstack([mag @ M.T for mag in _stft_mag(y, n_fft, hop)])
    ref = np.percentile(B, 99) + 1e-9
    L = np.log1p(100.0 * B / ref)
    D = np.maximum(0.0, np.diff(L, axis=0, prepend=L[:1]))
    low = edges[1:] <= 160.0
    env = D.mean(axis=1)
    low_env = D[:, low].mean(axis=1) if low.any() else env
    return env, low_env, sr / hop


def _estimate_bpm(env, fps, lo=50.0, hi=210.0, center=110.0):
    n = len(env)
    if n < fps * 6:
        return 0.0
    x = env - env.mean()
    nfft = 1 << int(np.ceil(np.log2(2 * n)))
    F = np.fft.rfft(x, nfft)
    ac = np.fft.irfft(F * np.conj(F), nfft)[:n]
    ac /= ac[0] + 1e-9
    lags = np.arange(max(2, int(60 * fps / hi)), min(n - 2, int(np.ceil(60 * fps / lo))) + 1)
    if len(lags) < 3:
        return 0.0
    bpm = 60 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / center) / 0.9) ** 2)
    double = np.where(2 * lags < n, ac[np.minimum(2 * lags, n - 1)], 0.0)
    score = (np.clip(ac[lags], 0, None) + 0.5 * np.clip(double, 0, None)) * prior
    i = int(np.argmax(score))
    lag = float(lags[i])
    a, b, c = ac[lags[i] - 1], ac[lags[i]], ac[lags[i] + 1]
    den = a - 2 * b + c
    if den < 0:
        lag += float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    return 60 * fps / lag


def _track_beats(env, fps, bpm, tightness=100.0):
    """Programação dinâmica de Ellis (2007): batidas que seguem o BPM e os ataques."""
    period = int(round(60.0 * fps / bpm))
    if period < 2 or len(env) < 4 * period:
        return np.array([], dtype=int)
    o = env / (env.std() + 1e-9)
    k = np.arange(-period, period + 1)
    local = np.convolve(o, np.exp(-0.5 * (k * 32.0 / period) ** 2), mode="same")
    n = len(local)
    window = np.arange(-2 * period, -int(round(period / 2)) + 1)
    txwt = -tightness * np.log(-window / period) ** 2
    cum = np.zeros(n)
    back = np.full(n, -1, dtype=int)
    thr = 0.01 * local.max()
    started = False
    for i in range(n):
        idx = window + i
        valid = idx >= 0
        cand = txwt.copy()
        cand[~valid] = -np.inf if valid.any() else 0.0
        cand[valid] += cum[idx[valid]]
        j = int(np.argmax(cand)) if valid.any() else 0
        best = cand[j] if valid.any() else 0.0
        cum[i] = local[i] + (best if np.isfinite(best) else 0.0)
        if not started and local[i] < thr:
            back[i] = -1
        else:
            back[i] = idx[j] if valid.any() else -1
            started = True
    # última batida: máximo local forte mais tardio
    m = np.r_[False, (cum[1:-1] > cum[:-2]) & (cum[1:-1] >= cum[2:]), False]
    if not m.any():
        return np.array([], dtype=int)
    med = np.median(cum[m])
    last = int(np.where(m & (cum * 2 > med))[0].max())
    beats = [last]
    while back[beats[-1]] >= 0 and len(beats) < n:
        beats.append(back[beats[-1]])
    beats = np.array(beats[::-1], dtype=int)
    # corta batidas fracas no começo e no fim
    if len(beats) > 4:
        sm = np.convolve(local[beats], np.hanning(7)[1:-1], mode="same")
        t = 0.5 * np.sqrt(np.mean(sm ** 2))
        strong = np.where(sm > t)[0]
        if len(strong):
            beats = beats[strong[0]:strong[-1] + 1]
    return beats


# ---------------------------------------------------------------- harmonia

def _estimate_tuning(y, sr):
    """Desvio de afinação em semitons (-0.5..0.5) em relação a A=440."""
    n_fft = 1 << int(np.ceil(np.log2(sr * 0.37)))
    S = None
    count = 0
    for mag in _stft_mag(y, n_fft, n_fft):
        s = mag.sum(axis=0)
        S = s if S is None else S + s
        count += len(mag)
    if S is None or count == 0:
        return 0.0
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    lo, hi = np.searchsorted(freqs, [100.0, 2000.0])
    A = np.log(S + 1e-9)
    i = np.arange(max(lo, 1), min(hi, len(S) - 1))
    pk = i[(S[i] > S[i - 1]) & (S[i] >= S[i + 1]) & (S[i] > 0.05 * S[lo:hi].max())]
    if len(pk) < 5:
        return 0.0
    a, b, c = A[pk - 1], A[pk], A[pk + 1]
    den = a - 2 * b + c
    delta = np.where(den < 0, 0.5 * (a - c) / np.where(den == 0, -1, den), 0.0)
    f = (pk + np.clip(delta, -0.5, 0.5)) * sr / n_fft
    midi = 69 + 12 * np.log2(f / 440.0)
    dev = midi - np.round(midi)
    w = S[pk] ** 2
    ang = np.arctan2(np.sum(w * np.sin(2 * np.pi * dev)), np.sum(w * np.cos(2 * np.pi * dev)))
    return float(ang / (2 * np.pi))


def _chroma(y, sr, n_fft, hop, fmin, fmax, tuning=0.0):
    """Cromagrama (quadros x 12, C=0) e energia por quadro."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    sel = np.where((freqs >= fmin) & (freqs <= fmax))[0]
    midi = 69 + 12 * np.log2(freqs[sel] / 440.0) - tuning
    near = np.round(midi)
    W = np.zeros((12, len(sel)), dtype=np.float32)
    W[near.astype(int) % 12, np.arange(len(sel))] = np.cos(np.pi * (midi - near)) ** 2
    chroma, energy = [], []
    for mag in _stft_mag(y, n_fft, hop):
        m = mag[:, sel]
        energy.append(m.sum(axis=1))
        chroma.append(np.sqrt(m) @ W.T)
    return np.vstack(chroma), np.concatenate(energy)


def _templates():
    T, labels = [], []
    for root in range(12):
        for q, ints in (("M", (0, 4, 7)), ("m", (0, 3, 7))):
            v = np.zeros(12)
            for iv in ints:
                for h, wgt in _HARMONICS:
                    v[(root + iv + int(round(12 * np.log2(h)))) % 12] += wgt
            T.append(v / np.linalg.norm(v))
            labels.append((root, q))
    return np.array(T), labels


def _key_from_chroma(profile):
    p = (profile - profile.mean()) / (profile.std() + 1e-9)
    best = (-2.0, 0, "major")
    for mode, kk in (("major", _KK_MAJOR), ("minor", _KK_MINOR)):
        z = (kk - kk.mean()) / kk.std()
        for pc in range(12):
            r = float(np.mean(p * np.roll(z, pc)))
            if r > best[0]:
                best = (r, pc, mode)
    return {"pc": best[1], "mode": best[2], "confidence": round(best[0], 3)}


def _diatonic(key):
    """Acordes do campo harmônico (para dar um leve empurrão na detecção)."""
    k = key["pc"] if key["mode"] == "major" else (key["pc"] + 3) % 12
    s = {(k, "M"), ((k + 5) % 12, "M"), ((k + 7) % 12, "M"),
         ((k + 2) % 12, "m"), ((k + 4) % 12, "m"), ((k + 9) % 12, "m")}
    if key["mode"] == "minor":
        s.add(((key["pc"] + 7) % 12, "M"))
    return s


def _viterbi(scores, penalty):
    S, K = scores.shape
    dp = scores[0].copy()
    back = np.zeros((S, K), dtype=int)
    ar = np.arange(K)
    for s in range(1, S):
        j = int(np.argmax(dp))
        switch = dp[j] - penalty
        take = switch > dp
        back[s] = np.where(take, j, ar)
        dp = np.where(take, switch, dp) + scores[s]
    path = [int(np.argmax(dp))]
    for s in range(S - 1, 0, -1):
        path.append(int(back[s][path[-1]]))
    return path[::-1]


def _segment_sum(values, frame_t, starts):
    idx = np.clip(np.searchsorted(starts, frame_t, side="right") - 1, 0, len(starts) - 1)
    out = np.zeros((len(starts),) + values.shape[1:])
    np.add.at(out, idx, values)
    cnt = np.bincount(idx, minlength=len(starts)).astype(float)
    return out, cnt


# ---------------------------------------------------------------- principal

def analyze(stems, sr):
    """Recebe as faixas separadas ({nome: array (2, n)}) e devolve BPM, batidas, tom e acordes."""
    mix = sum(_mono(v) for v in stems.values())
    dur = len(mix) / sr
    out = {"bpm": 0.0, "beats": [], "beat_strength": [], "key": None, "chords": [], "tuning": 0.0}
    if dur < 3 or _rms(mix) < 1e-5:
        return out

    # ---- BPM e batidas (bateria + baixo; se não houver bateria, a mix toda)
    rhythm = np.zeros_like(mix)
    for n in ("drums", "bass"):
        if n in stems:
            rhythm = rhythm + _mono(stems[n])
    if _rms(rhythm) < 0.15 * _rms(mix):
        rhythm = mix
    env, low_env, fps = _onset_envelopes(rhythm, sr)
    bpm = _estimate_bpm(env, fps)
    beat_f = _track_beats(env, fps, bpm) if bpm > 0 else np.array([], dtype=int)
    beats = beat_f / fps
    if len(beat_f):
        lo = np.array([low_env[max(0, f - 2):f + 3].max() for f in beat_f])
        strength = lo / (lo.max() + 1e-9)
    else:
        strength = np.array([])
    if len(beats) >= 8:
        med = float(np.median(np.diff(beats)))
        slope = float(np.polyfit(np.arange(len(beats)), beats, 1)[0])
        period = slope if abs(slope - med) < 0.1 * med else med
        bpm = 60.0 / period

    # ---- harmonia: instrumentos harmônicos (+ um pouco da voz)
    harm = np.zeros_like(mix)
    for n, w in (("other", 1.0), ("guitar", 1.0), ("piano", 1.0), ("bass", 0.5), ("vocals", 0.3)):
        if n in stems:
            harm = harm + w * _mono(stems[n])
    if _rms(harm) < 1e-5:
        harm = mix - (_mono(stems["drums"]) if "drums" in stems else 0)
    tuning = _estimate_tuning(harm, sr)
    n_fft = 1 << int(np.ceil(np.log2(sr * 0.37)))
    hop = n_fft // 4
    C, energy = _chroma(harm, sr, n_fft, hop, 55.0, 5000.0, tuning)
    bass_src = _mono(stems["bass"]) if "bass" in stems else harm
    Bc, _ = _chroma(bass_src, sr, n_fft, hop, 35.0, 300.0, tuning)
    n = min(len(C), len(Bc))
    C, Bc, energy = C[:n], Bc[:n], energy[:n]
    frame_t = np.arange(n) * hop / sr

    active = energy > 0.1 * np.median(energy[energy > 0]) if np.any(energy > 0) else energy > 0
    key = _key_from_chroma(C[active].sum(axis=0) if active.any() else C.sum(axis=0))

    # ---- grade de segmentos: batidas (estendidas antes/depois), senão 0,5 s
    if len(beats) >= 8:
        per = 60.0 / bpm
        before = np.arange(beats[0] - per, 0.05, -per)[::-1]
        after = np.arange(beats[-1] + per, dur - 0.05, per)
        grid = np.concatenate([before, beats, after])
    else:
        grid = np.arange(0.5, dur - 0.05, 0.5)
    starts = np.unique(np.concatenate([[0.0], grid[grid > 0.05]]))

    Cs, cnt = _segment_sum(C, frame_t, starts)
    Bs, _ = _segment_sum(Bc, frame_t, starts)
    Es, _ = _segment_sum(energy[:, None], frame_t, starts)
    keep = cnt > 0
    starts, Cs, Bs, Es, cnt = starts[keep], Cs[keep], Bs[keep], Es[keep, 0], cnt[keep]
    Es = Es / cnt

    T, labels = _templates()
    Cn = Cs / (np.linalg.norm(Cs, axis=1, keepdims=True) + 1e-9)
    sim = Cn @ T.T
    Bn = Bs / (Bs.sum(axis=1, keepdims=True) + 1e-9)
    roots = np.array([r for r, _ in labels])
    dia = _diatonic(key)
    key_bonus = np.array([0.06 if lab in dia else 0.0 for lab in labels])
    scores = sim + 0.35 * Bn[:, roots] + key_bonus
    thr = 0.08 * np.median(Es[Es > 0]) if np.any(Es > 0) else 0
    n_score = np.where(Es < thr, 3.0, 0.3)[:, None]
    path = _viterbi(np.hstack([scores, n_score]), penalty=0.18)

    chords = []
    for s, p in enumerate(path):
        lab = ("N" if p == len(labels) else labels[p])
        item = {"t": round(float(starts[s]), 3), "pc": -1, "q": "N"} if lab == "N" else \
            {"t": round(float(starts[s]), 3), "pc": int(lab[0]), "q": lab[1]}
        if chords and chords[-1]["pc"] == item["pc"] and chords[-1]["q"] == item["q"]:
            continue
        chords.append(item)

    out.update(
        bpm=round(float(bpm), 1),
        beats=[round(float(b), 3) for b in beats],
        beat_strength=[round(float(s), 3) for s in strength],
        key=key,
        chords=chords,
        tuning=round(tuning * 100, 1),
    )
    return out
