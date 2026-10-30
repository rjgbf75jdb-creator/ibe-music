# Plano do Ibe Music

**Divisão do trabalho:** Claude planeja e revisa; Codex implementa e testa. Uma etapa por vez.
Ao terminar uma etapa, o Codex informa: arquivos alterados, comandos de teste e a saída deles.
O Claude revisa contra os critérios de conclusão antes de liberar a próxima etapa.

## Estado atual (revisão de 30/10/2026)

O app está completo para o uso descrito no README: separação com Demucs, análise de BPM/tom/acordes,
motor de áudio próprio (tom, velocidade, loop A-B, metrônomo), letra sincronizada, playlists e exportação.
O motor (`static/engine.js`) carrega a posição original de cada amostra através do esticador e do
reamostrador, e por isso metrônomo e loop continuam certos com tom e velocidade alterados. Esse desenho deve ser mantido.

Ambiente verificado neste PC: Python 3.12.10 na `.venv`, torch 2.15.0, torchaudio 2.11.1, demucs 4.0.1,
numpy 1.26.4, FFmpeg 9.0.2 e Node 24. **O Git não está instalado.** O projeto não tem controle de versão nem testes automáticos.

## Achados da revisão

| # | Onde | Problema | Gravidade | Etapa |
|---|------|----------|-----------|-------|
| 1 | projeto todo | Sem Git e sem testes: não dá para revisar diferenças nem pegar regressões. | Alta (processo) | 1 |
| 2 | `requirements.txt` | torch e torchaudio sem versão fixa: uma instalação nova puxa versões diferentes das testadas. O `.venv\ok` também nunca reinstala quando o `requirements.txt` muda. | Média | 2 |
| 3 | `iniciar.bat`, `iniciar.sh` | Porta 7860 fixa na espera e no endereço aberto, mas o `app.py` respeita `PORT`. Com `PORT=8000`, a janela abre no endereço errado. | Baixa | 2 |
| 4 | `app.py:143` | Ao iniciar, apaga a pasta `WORK` inteira, e ela vem de `IBE_WORKDIR` (`app.py:26`). Se essa variável apontar para uma pasta com arquivos do usuário, eles são apagados. | Média (pouco provável, dano alto) | 2 |
| 5 | `app.py:151` | CORS `*` e nenhuma checagem de Origin: qualquer site aberto no navegador consegue criar trabalhos no servidor local e ler as respostas. Se restringir, manter configurável (o Ajustes aceita um servidor remoto). | Baixa | 2 |
| 6 | `app.py:166` | O limite de MB só é checado depois que o Starlette já gravou o upload inteiro em arquivo temporário. | Baixa | 2 |
| 7 | `separator.py:18` | Muda o `torch.load` do processo inteiro para `weights_only=False`, e não só para os modelos do Demucs. | Baixa | 2 |
| 8 | `index.html:15-17` | A fonte vem do Google Fonts, mas o README diz que nada é enviado para a internet. | Baixa | 2 |
| 9 | `app.js:91`, `app.js:881`, README | No celular via `http://IP` não há contexto seguro, então não há service worker nem AudioWorklet. O app só abre com o PC ligado, e o README não avisa isso. | Média (expectativa) | 3 |
| 10 | `app.js:115`, `app.js:683` | Todas as faixas ficam na memória em Int16: com 6 faixas de 12 min, são cerca de 760 MB. A exportação da mix decodifica tudo de novo e ainda aloca a saída em Float32. Há risco de a aba fechar no iPhone. | Média | 3 |
| 11 | biblioteca | As músicas só existem no IndexedDB de cada aparelho: limpar os dados do navegador apaga tudo, e não há como levar músicas do PC para o celular. | Média (produto) | 4 |
| 12 | `analysis.py:183` | Os acordes são só maiores e menores: não há 7ª, sus nem baixo invertido, nem correção manual. | Melhoria | 5 |

## Etapas

1. **Base de trabalho**: Git e testes automáticos, sem mudar o comportamento do app. **← próxima**
2. **Robustez e instalação**: achados 2 a 8.
3. **Celular e memória**: achados 9 e 10.
4. **Backup e transferência da biblioteca**: achado 11.
5. **Qualidade musical**: achado 12, mais a correção manual de acordes, BPM e compasso.

O escopo e os critérios de cada etapa a partir da 2 serão detalhados quando a etapa anterior for aprovada.

## Etapa 1: base de trabalho (critérios de conclusão)

**Pré-requisito:** instalar o Git (`winget install --id Git.Git -e`). Isso precisa do OK do usuário.

**Escopo**

- `git init` em `ibe-music/ibe-music`, com `.gitignore` para `.venv/`, `work/`, `__pycache__/` e `*.pyc`.
  O primeiro commit é o código exatamente como está hoje (linha de base), antes de qualquer outra mudança.
- `requirements-dev.txt` com `pytest` e `httpx` (necessário para o `TestClient` do FastAPI).
- `tests/test_api.py`:
  - Antes de importar o `app`, colocar um `separator` falso em `sys.modules` (sem torch e sem baixar modelo) e definir `IBE_WORKDIR` como uma pasta temporária.
  - Usar o `TestClient` como gerenciador de contexto, para o `lifespan` rodar.
  - Casos: um WAV de 5 s passa por enviar → consultar até `done` → baixar cada faixa (200) → `DELETE`, e depois `GET` do trabalho dá 404. Arquivo vazio dá 400. Arquivo acima do limite dá 413. Trabalho inexistente dá 404. Nome de arquivo com `..` ou `\` dá 404. Cancelar um trabalho na fila o remove. Áudio com menos de 3 s termina em `error` com a mensagem amigável.
- `tests/test_analysis.py`, com sinais sintéticos:
  - Cliques a 120 BPM por 20 s em `drums`: BPM 120 ± 2 e intervalo entre batidas de 0,50 ± 0,02 s.
  - Tríades C–G–Am–F, 2 s cada e repetidas, em `other`, com as fundamentais em `bass`: tom C maior e acorde correto em pelo menos 75% do tempo.
  - Silêncio: BPM 0, sem acordes e sem exceção.
- `tests/engine.test.mjs`, com `node:test` e sem dependências npm, carregando `static/engine.js` via `vm`:
  - Velocidade 0,5: a saída tem cerca de 2× o comprimento (±2%).
  - Tom +3 com velocidade 1: o comprimento fica igual (±2%).
  - Mudo em uma faixa: a saída é só a outra faixa. Ignorar os primeiros 100 ms, por causa da suavização do ganho e do fade.
  - Loop A=1 s, B=2 s: depois de chegar a B, todas as posições `P` ficam em [A, B].
  - Fim da música: `ended` fica verdadeiro depois de `length`.
- Um comando único para rodar tudo (`testar.bat`) e uma seção curta "Desenvolvimento" no README.

**Pronto quando**

- `git log` mostra pelo menos 2 commits: a linha de base e depois os testes.
- A diferença entre a linha de base e o HEAD não altera nenhum `.py` existente nem nada em `static/`.
- Todos os testes passam sem internet e sem baixar modelo, em menos de 60 s neste PC.
- Se um teste revelar um bug real, ele fica marcado com `xfail`/`skip` e o motivo, e é relatado. Não corrigir nesta etapa e não afrouxar tolerâncias sem relatar o valor medido.
- O Codex entrega a lista de arquivos criados, a saída do `testar.bat` e os `xfail`, se houver.
