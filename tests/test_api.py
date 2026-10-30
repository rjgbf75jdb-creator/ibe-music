"""Real ASGI lifecycle + audio I/O; only the ML separator is replaced."""
import importlib.util
import io
from pathlib import Path
import sys
import threading
import time
import types
import wave

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
SR = 44100


def wav_bytes(seconds=5):
    t = np.arange(round(SR * seconds)) / SR
    data = (0.2 * np.sin(2 * np.pi * 440 * t) * 32767).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(np.repeat(data[:, None], 2, axis=1).tobytes())
    return output.getvalue()


def wait_for(client, job_id, expected, timeout=8):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = client.get(f'/api/jobs/{job_id}')
        if expected == 404 and response.status_code == 404:
            return response
        assert response.status_code == 200, response.text
        last = response.json()
        if last['status'] == expected:
            return last
        if last['status'] == 'error' and expected != 'error':
            pytest.fail(f'Unexpected job error: {last}')
        time.sleep(0.01)
    pytest.fail(f'Job did not reach {expected} within {timeout}s: {last}')


@pytest.fixture(scope='module')
def running_api(tmp_path_factory):
    patch = pytest.MonkeyPatch()
    safe_parent = tmp_path_factory.mktemp('ibe-api-only')
    scratch = safe_parent / 'jobs'
    # Set BEFORE importing app: lifespan deletes WORK. Never point it at real data.
    patch.setenv('IBE_WORKDIR', str(scratch))
    patch.setenv('IBE_MAX_MB', '1')
    patch.setenv('IBE_MAX_MIN', '12')
    fake = types.ModuleType('separator')
    fake.entered = threading.Event()
    fake.release = threading.Event()
    fake.release.set()
    fake.warmup = threading.Event()

    class Cancelled(Exception):
        pass

    def get_model(stems=4):
        fake.warmup.set()
        return object()

    def separate(audio, stems=4, report=None, cancelled=None):
        fake.entered.set()
        if not fake.release.wait(timeout=5):
            raise AssertionError('Test separator gate was not released')
        if cancelled and cancelled():
            raise Cancelled()
        if report:
            report(1.0)
        names = ['vocals', 'drums', 'bass', 'other']
        if stems == 6:
            names += ['guitar', 'piano']
        return {name: audio / len(names) for name in names}

    fake.Cancelled = Cancelled
    fake.get_model = get_model
    fake.separate = separate
    patch.setitem(sys.modules, 'separator', fake)
    spec = importlib.util.spec_from_file_location('_ibe_api_test_app', ROOT / 'app.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.WORK.resolve() == scratch.resolve()
    assert module.WORK.resolve().is_relative_to(safe_parent.resolve())

    import audio_io
    # Use real libsndfile read/write, at its native rate: no FFmpeg or torch needed.
    patch.setattr(audio_io, 'FFMPEG', None)
    try:
        with TestClient(module.app) as client:
            assert fake.warmup.wait(timeout=2), 'lifespan must start the worker'
            assert scratch.is_dir()
            yield types.SimpleNamespace(client=client, app=module, fake=fake, work=scratch)
    finally:
        fake.release.set()
        patch.undo()


@pytest.fixture
def api(running_api):
    api = running_api
    yield api
    # All test work stays under scratch. Let processing finish/cancel before cleanup.
    for job_id in list(api.app.jobs):
        api.client.delete(f'/api/jobs/{job_id}')
    api.fake.release.set()
    for job_id in list(api.app.jobs):
        wait_for(api.client, job_id, 404)


def submit(api, content=None):
    response = api.client.post('/api/jobs', files={
        'file': ('synthetic.wav', wav_bytes() if content is None else content, 'audio/wav')
    })
    assert response.status_code == 200, response.text
    return response.json()['id']


def test_health_lifespan_and_no_models(api):
    response = api.client.get('/api/health')
    assert response.status_code == 200
    assert response.json() == {'ok': True, 'queue': 0, 'max_mb': 1, 'max_min': 12}
    assert api.fake.warmup.is_set()
    assert not {'torch', 'torchaudio', 'demucs'} & sys.modules.keys()


def test_wav_upload_poll_download_delete(api):
    job_id = submit(api)
    result = wait_for(api.client, job_id, 'done')['result']
    assert result['duration'] == pytest.approx(5, abs=1 / SR)
    assert {s['name'] for s in result['stems']} == {'vocals', 'drums', 'bass', 'other'}
    for stem in result['stems']:
        response = api.client.get(f"/api/jobs/{job_id}/files/{stem['file']}")
        assert response.status_code == 200
        audio, rate = sf.read(io.BytesIO(response.content), always_2d=True)
        assert rate == SR and audio.shape[1] == 2
        assert 4.9 <= len(audio) / rate <= 5.2  # MP3 may include encoder padding.
        assert np.max(np.abs(audio)) > 0.01
    assert api.client.delete(f'/api/jobs/{job_id}').json() == {'ok': True}
    assert api.client.get(f'/api/jobs/{job_id}').status_code == 404
    assert not (api.work / job_id).exists()


def test_empty_upload_is_400(api):
    response = api.client.post('/api/jobs', files={'file': ('empty.wav', b'', 'audio/wav')})
    assert response.status_code == 400
    assert response.json()['detail'] == 'O arquivo está vazio.'


def test_upload_above_configured_limit_is_413(api):
    limit = int(api.app.MAX_MB * 1024 * 1024)
    response = api.client.post('/api/jobs', files={'file': ('large.wav', b'0' * (limit + 1), 'audio/wav')})
    assert response.status_code == 413
    assert 'O arquivo passa de 1 MB.' == response.json()['detail']


def test_unknown_job_is_404(api):
    assert api.client.get('/api/jobs/does-not-exist').status_code == 404


def test_unsafe_download_names_are_404(api):
    job_id = submit(api)
    wait_for(api.client, job_id, 'done')
    (api.work / 'canary.wav').write_bytes(b'never expose this parent file')
    # Encode literal '..': HTTP clients normalize an unencoded /files/.. URL
    # into the job metadata endpoint before ASGI sees the filename.
    for name in ['%2e%2e', '..%5Ccanary.wav', 'sub%5Ccanary.wav', '%2e%2e%2fcanary.wav']:
        response = api.client.get(f'/api/jobs/{job_id}/files/{name}')
        assert response.status_code == 404, f'{name}: {response.status_code}'


def test_cancel_queued_job_removes_it(api):
    api.fake.entered.clear()
    api.fake.release.clear()
    first = submit(api)
    try:
        assert api.fake.entered.wait(timeout=2), 'First job must occupy the real worker'
        queued = submit(api)
        state = api.client.get(f'/api/jobs/{queued}').json()
        assert state['status'] == 'queued' and state['queue'] == 1
        assert api.client.delete(f'/api/jobs/{queued}').status_code == 200
        assert api.client.get(f'/api/jobs/{queued}').status_code == 404
        assert queued not in api.app.pending
        assert not (api.work / queued).exists()
    finally:
        api.client.delete(f'/api/jobs/{first}')
        api.fake.release.set()
        wait_for(api.client, first, 404)


def test_short_audio_has_friendly_error(api):
    job_id = submit(api, wav_bytes(seconds=2))
    state = wait_for(api.client, job_id, 'error')
    assert state['error'] == 'A música é curta demais.'
