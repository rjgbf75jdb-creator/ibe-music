# Ibe Music

App individual para ensaiar: roda no seu computador, só você usa e, depois da instalação, funciona sem internet.

- **Separa as faixas**: voz, bateria, baixo e outros (ou 6 faixas, com guitarra e teclado)
- **Muda o tom** (±6 meios tons) e a **velocidade** (50% a 150%) sem distorcer
- **Detecta BPM, tom e acordes**, com os acordes rolando no tempo da música
- **Metrônomo** sincronizado, **repetir trecho A-B**, **letra sincronizada** e **playlists**
- Exporta cada faixa (MP3) ou a mix ajustada (WAV)

Nada é enviado para a internet: a separação acontece no seu PC e as músicas ficam salvas no navegador.

## Instalar e abrir (Windows)

1. Extraia o zip (botão direito → **Extrair tudo…**).
2. Dê dois cliques em **iniciar.bat**. Na primeira vez, ele instala sozinho o Python, o FFmpeg, as bibliotecas e os modelos de IA (cerca de 1,5 GB, com internet). Se aparecer "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**.
3. O Ibe Music abre numa janela própria. Deixe a janela preta aberta (pode minimizar) enquanto usa.

Depois disso, é só abrir o **iniciar.bat**, mesmo sem internet. Para criar um atalho: botão direito em iniciar.bat → **Enviar para** → **Área de trabalho**.

**Mac/Linux**: rode `./iniciar.sh` no terminal.

## Usar no celular (opcional)

Com o PC e o celular no mesmo Wi-Fi, abra **iniciar-com-celular.bat**. A janela preta mostra o endereço para digitar no celular (algo como `http://192.168.0.10:7860`). Se o Windows perguntar sobre o firewall, permita em **redes privadas**.

No **iPhone**: abra o endereço no Safari e toque em **Compartilhar → Adicionar à Tela de Início**. Assim ele abre como app e as músicas ficam guardadas. As músicas precisam estar no app **Arquivos**; as do Apple Music são protegidas e não podem ser usadas. Para arquivos .m4a do iPhone, instale o FFmpeg no PC.

Nesse modo, quem estiver no mesmo Wi-Fi também consegue abrir o app. Para uso só no PC, use o iniciar.bat normal. O PC e o celular têm bibliotecas separadas: cada música fica salva no aparelho onde você a enviou.

## Como usar

1. **Biblioteca**: escolha 4 ou 6 faixas e envie o arquivo. Acompanhe o progresso; ao terminar, a música aparece na lista.
2. **Estúdio**: toque, silencie (**Mudo**) ou isole (**Solo**) cada faixa e ajuste o volume.
3. **Tom** com − e +, **Velocidade** no controle deslizante.
4. **Repetir trecho**: toque em Marcar A no início e Marcar B no fim.
5. **Letra**: cole a letra, toque em Sincronizar e marque cada verso enquanto toca. Depois disso, os acordes aparecem em cima de cada linha.
6. Atalhos no teclado: espaço toca/pausa, setas voltam/avançam 5 s, Enter marca a linha na sincronização.

Cada música leva alguns minutos para separar, dependendo do computador. Com placa de vídeo NVIDIA (CUDA), a separação usa a GPU automaticamente e fica bem mais rápida.

## Ajustes avançados

Variáveis de ambiente opcionais: `IBE_MAX_MIN` (duração máxima, padrão 12 min), `IBE_MAX_MB` (tamanho máximo, padrão 80 MB), `PORT` (padrão 7860) e `HOST` (padrão `127.0.0.1`, só este computador).

## Arquivos

- `app.py`: servidor local com fila de processamento
- `separator.py`: separação de faixas com [Demucs](https://github.com/facebookresearch/demucs) (Meta, licença MIT)
- `analysis.py`: BPM, batidas, tom e acordes
- `audio_io.py`: leitura e gravação de áudio
- `static/`: o app (interface, motor de áudio, modo offline)

Use o Ibe Music com músicas que você tem o direito de usar.

## Desenvolvimento

Com o Python do projeto e o Node.js no PATH, instale uma vez as dependências de teste:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

Depois execute `testar.bat` (ou `.\testar.bat` no PowerShell). Esse comando roda os testes
Python e `node --test tests/engine.test.mjs`, sem instalar nada e sem baixar modelos,
com orçamento de execução inferior a 60 segundos. A instalação inicial das dependências
pode precisar de internet; a execução dos testes funciona offline.

Os testes de API substituem apenas o separador de IA por um falso antes de importar
`app.py` e direcionam `IBE_WORKDIR` para uma pasta temporária exclusiva, preservando
`work/` e as músicas reais. Usam leitura e gravação reais com soundfile, sem FFmpeg.
Os testes Python bloqueiam rede externa e importações de torch/torchaudio/Demucs.
A análise usa sinais sintéticos; o motor é carregado em uma VM do Node, sem npm.

Nesta etapa, bugs encontrados são documentados como `xfail`/`skip`, sem modificar o app.
Há uma reprodução adicional conhecida a 22.050 Hz: após 100 ms de mudo, o resíduo
é `0.0031866133` (critério `<= 0.0001`). O caso fica marcado como `skip` somente para
esse valor conhecido. Os cinco critérios obrigatórios do motor passam a 44.100 Hz,
a taxa nominal solicitada pelo app. Nenhuma tolerância foi relaxada.
