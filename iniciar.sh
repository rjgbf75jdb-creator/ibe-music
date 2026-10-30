#!/usr/bin/env bash
# Ibe Music no Mac/Linux: ./iniciar.sh   (para abrir no celular pelo Wi-Fi: HOST=0.0.0.0 ./iniciar.sh)
cd "$(dirname "$0")" || exit 1
PY=python3.11; command -v "$PY" >/dev/null 2>&1 || PY=python3
if [ ! -f .venv/ok ]; then
  echo "Instalando o Ibe Music (só na primeira vez: precisa de internet e pode levar vários minutos)..."
  "$PY" -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt \
    && .venv/bin/python -c "import separator; separator.preload()" && touch .venv/ok \
    || { echo "Algo deu errado. Confira se o Python 3.11 está instalado e se há internet."; exit 1; }
fi
( for i in $(seq 1 40); do sleep 2; curl -s -o /dev/null http://127.0.0.1:7860/api/health && break; done
  (command -v open >/dev/null && open http://localhost:7860) || xdg-open http://localhost:7860 ) >/dev/null 2>&1 &
exec .venv/bin/python app.py
