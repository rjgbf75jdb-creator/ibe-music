"""Ibe Music: servidor que separa faixas e analisa BPM, tom e acordes.

Rode com:  python app.py   e abra http://localhost:7860
"""
import mimetypes
import os
import shutil
import threading
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# O Windows às vezes registra .js com o tipo errado, o que quebra o app
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".webmanifest")

BASE = Path(__file__).resolve().parent
WORK = Path(os.environ.get("IBE_WORKDIR", BASE / "work"))
MAX_MB = float(os.environ.get("IBE_MAX_MB", "80"))
MAX_MIN = float(os.environ.get("IBE_MAX_MIN", "12"))
TTL = 3 * 3600  # resultados ficam no servidor por até 3 horas
LABELS = {"vocals": "Voz", "drums": "Bateria", "bass": "Baixo",
          "guitar": "Guitarra", "piano": "Teclado", "other": "Outros"}
ORDER = list(LABELS)

jobs = {}
pending = []
cv = threading.Condition()


def _public(job):
    data = {k: job[k] for k in ("id", "title", "stems", "status", "stage", "progress", "error", "result")}
    data["queue"] = pending.index(job["id"]) + 1 if job["id"] in pending else 0
    return data


def _remove(jid):
    jobs.pop(jid, None)
    shutil.rmtree(WORK / jid, ignore_errors=True)


def _process(job):
    import analysis
    import audio_io
    import separator

    d = WORK / job["id"]

    def stage(text, progress):
        job["stage"], job["progress"] = text, round(progress, 3)

    def check():
        if job["cancel"]:
            raise separator.Cancelled()

    stage("Lendo o arquivo", 0.02)
    audio = audio_io.load(job["input"])
    Path(job["input"]).unlink(missing_ok=True)
    dur = audio.shape[1] / audio_io.SR
    if dur < 3:
        raise audio_io.AudioError("A música é curta demais.")
    if dur > MAX_MIN * 60:
        raise audio_io.AudioError(f"Envie músicas com até {int(MAX_MIN)} minutos.")
    check()

    stage("Separando as faixas", 0.05)
    stems = separator.separate(audio, job["stems"],
                               report=lambda f: stage("Separando as faixas", 0.05 + 0.8 * f),
                               cancelled=lambda: job["cancel"])
    del audio
    check()

    stage("Detectando BPM, tom e acordes", 0.86)
    try:
        info = analysis.analyze(stems, audio_io.SR)
    except Exception:  # a análise nunca deve derrubar a separação
        traceback.print_exc()
        info = {"bpm": 0.0, "beats": [], "beat_strength": [], "key": None, "chords": [], "tuning": 0.0}
    check()

    names = sorted(stems, key=lambda n: ORDER.index(n) if n in ORDER else 99)
    files = []
    for i, name in enumerate(names):
        stage("Preparando os arquivos", 0.92 + 0.08 * i / len(names))
        files.append({"name": name, "label": LABELS.get(name, name.title()),
                      "file": audio_io.save_mp3(d / name, stems[name])})
        check()
    job["result"] = {"duration": round(dur, 3), "stems": files, **info}
    job["status"] = "done"
    stage("Pronto", 1.0)


def _worker():
    try:  # deixa o modelo carregado para o primeiro envio
        import separator
        separator.get_model(4)
        print("  Modelo de separação pronto.")
    except Exception:
        traceback.print_exc()
    while True:
        with cv:
            while not pending:
                cv.wait()
            jid = pending.pop(0)
            job = jobs.get(jid)
            if not job or job["cancel"]:
                continue
            job["status"], job["stage"] = "processing", "Começando"
        try:
            _process(job)
        except Exception as exc:
            if type(exc).__name__ == "Cancelled":
                _remove(jid)
            elif type(exc).__name__ == "AudioError":
                job.update(status="error", error=str(exc))
            else:
                traceback.print_exc()
                job.update(status="error", error="Não foi possível processar essa música. Tente de novo.")


def _janitor():
    while True:
        time.sleep(600)
        now = time.time()
        for jid, job in list(jobs.items()):
            if now - job["created"] > TTL and job["status"] != "processing":
                with cv:
                    if jid in pending:
                        pending.remove(jid)
                _remove(jid)


@asynccontextmanager
async def lifespan(_app):
    shutil.rmtree(WORK, ignore_errors=True)  # sobras de execuções anteriores
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_worker, daemon=True).start()
    threading.Thread(target=_janitor, daemon=True).start()
    yield


app = FastAPI(title="Ibe Music", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"ok": True, "queue": len(pending), "max_mb": MAX_MB, "max_min": MAX_MIN}


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...), stems: int = Form(4)):
    jid = uuid.uuid4().hex[:12]
    d = WORK / jid
    d.mkdir(parents=True)
    ext = "".join(c for c in Path(file.filename or "").suffix.lower() if c.isalnum() or c == ".")[:8]
    dest = d / f"input{ext or '.audio'}"
    size, limit = 0, MAX_MB * 1024 * 1024
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > limit:
                f.close()
                shutil.rmtree(d, ignore_errors=True)
                raise HTTPException(413, f"O arquivo passa de {int(MAX_MB)} MB.")
            f.write(chunk)
    if size == 0:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "O arquivo está vazio.")
    job = {"id": jid, "title": Path(file.filename or "Música").stem[:120], "stems": 6 if stems == 6 else 4,
           "status": "queued", "stage": "Na fila", "progress": 0.0, "error": None, "result": None,
           "created": time.time(), "input": str(dest), "cancel": False}
    with cv:
        jobs[jid] = job
        pending.append(jid)
        cv.notify()
    return _public(job)


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "Envio não encontrado.")
    return _public(job)


@app.get("/api/jobs/{jid}/files/{fname}")
def get_file(jid: str, fname: str):
    job = jobs.get(jid)
    path = WORK / jid / fname
    if not job or job["status"] != "done" or "/" in fname or "\\" in fname or not path.is_file():
        raise HTTPException(404, "Arquivo não encontrado.")
    return FileResponse(path, media_type=mimetypes.guess_type(fname)[0] or "application/octet-stream")


@app.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    with cv:
        job = jobs.get(jid)
        if job:
            job["cancel"] = True
            if jid in pending:
                pending.remove(jid)
            if job["status"] != "processing":
                _remove(jid)
    return {"ok": True}


app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")

def _lan_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "7860"))
    host = os.environ.get("HOST", "127.0.0.1")  # padrão: só este computador
    print(f"\n  Ibe Music rodando em http://localhost:{port}")
    if host in ("0.0.0.0", "::"):
        ip = _lan_ip()
        if ip:
            print(f"  No celular (mesmo Wi-Fi), abra: http://{ip}:{port}")
    print("  Deixe esta janela aberta enquanto usa. Para fechar, aperte Ctrl+C.\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")
