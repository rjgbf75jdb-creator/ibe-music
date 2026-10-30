"""Offline entry point for testar.bat. No installation or model downloads."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def main():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which('node')
    if not node:
        print('Node.js nao encontrado no PATH. Instale Node antes de rodar os testes.')
        return 1
    environment = os.environ.copy()
    environment.update({
        'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
        'PIP_NO_INDEX': '1',
        'HF_HUB_OFFLINE': '1',
        'TRANSFORMERS_OFFLINE': '1',
        'OMP_NUM_THREADS': '1',
        'OPENBLAS_NUM_THREADS': '1',
        'MKL_NUM_THREADS': '1',
        'PYTHONUTF8': '1',
    })
    started = time.perf_counter()
    deadline = started + 58
    failed = False
    commands = [
        [sys.executable, '-m', 'pytest', 'tests', '-q', '-ra', '--durations=5'],
        [node, '--test', 'tests/engine.test.mjs'],
    ]
    print('Etapa 1: API e analise sem rede externa/modelos; motor em VM local.', flush=True)
    for command in commands:
        print('\n> ' + subprocess.list2cmdline(command), flush=True)
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            print('FALHA: orcamento de tempo de 58 s esgotado.', flush=True)
            failed = True
            break
        try:
            result = subprocess.run(command, cwd=root, env=environment, timeout=remaining)
            failed |= result.returncode != 0
        except subprocess.TimeoutExpired:
            print('FALHA: comando excedeu o orcamento de tempo.', flush=True)
            failed = True
            break
    elapsed = time.perf_counter() - started
    print(f'\nDuracao total: {elapsed:.2f} s (limite: menos de 60 s).', flush=True)
    failed |= elapsed >= 60
    print('RESULTADO: FALHOU.' if failed else 'RESULTADO: OK; consultar os skips conhecidos acima.', flush=True)
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
