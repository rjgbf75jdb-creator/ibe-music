"""Separação de faixas com Demucs (Meta, código aberto, licença MIT)."""
import threading
import types

import numpy as np
import torch

MODELS = {4: "htdemucs", 6: "htdemucs_6s"}
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
_cache = {}
_lock = threading.Lock()


class Cancelled(Exception):
    pass


def _allow_demucs_checkpoints():
    """O torch 2.6+ recusa checkpoints antigos por padrão; os do Demucs são oficiais."""
    if getattr(torch.load, "_ibe", False):
        return
    original = torch.load

    def load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return original(*args, **kwargs)

    load._ibe = True
    torch.load = load


def get_model(stems=4):
    name = MODELS.get(stems, MODELS[4])
    with _lock:
        if name not in _cache:
            _allow_demucs_checkpoints()
            from demucs.pretrained import get_model as demucs_model
            model = demucs_model(name)
            model.eval()
            _cache[name] = model
        return _cache[name]


def preload():
    """Baixa os modelos antes (usado no Docker para o primeiro envio ser rápido)."""
    for stems in MODELS:
        get_model(stems)


class _Progress:
    """Substitui o tqdm do Demucs para medir o progresso e permitir cancelar."""

    def __init__(self, n_models, report, cancelled):
        self.n_models, self.report, self.cancelled, self.loops = max(1, n_models), report, cancelled, 0

    def tqdm(self, iterable, **_):
        items = list(iterable)
        base, total = self.loops, max(1, len(items))
        self.loops += 1
        for i, item in enumerate(items):
            if self.cancelled and self.cancelled():
                raise Cancelled()
            yield item
            if self.report:
                self.report(min(1.0, (base + (i + 1) / total) / self.n_models))


def separate(audio, stems=4, report=None, cancelled=None):
    """audio: float32 (2, n) em 44,1 kHz. Devolve {nome_da_faixa: array (2, n)}."""
    from demucs import apply as dapply

    model = get_model(stems)
    x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (x - mean) / std
    shim = _Progress(len(getattr(model, "models", [model])), report, cancelled)
    old = getattr(dapply, "tqdm", None)
    dapply.tqdm = types.SimpleNamespace(tqdm=shim.tqdm)
    try:
        with torch.no_grad():
            out = dapply.apply_model(model, x[None], device=DEVICE, shifts=1, split=True,
                                     overlap=0.25, progress=True)[0]
    finally:
        if old is not None:
            dapply.tqdm = old
    out = (out * std + mean).cpu().numpy()
    return {name: out[i] for i, name in enumerate(model.sources)}
