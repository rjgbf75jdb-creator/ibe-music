# Ibe Music no iPhone

O app do iPhone usa a mesma interface de `static/`. A separação de faixas continua no PC.

## 1. Gerar o app (.ipa) no GitHub, sem Mac
1. Envie a pasta `ibe-music` para um repositório no GitHub.
2. No GitHub, abra **Actions → App iOS → Run workflow**.
3. Quando terminar, baixe o artefato **IbeMusic-ipa** e extraia o `IbeMusic.ipa`.

## 2. Instalar no iPhone (Windows)
1. Instale o **Sideloadly** (sideloadly.io) e o iTunes.
2. Ligue o iPhone no PC pelo cabo e arraste o `IbeMusic.ipa` para o Sideloadly.
3. Entre com o seu Apple ID e clique em **Start**.
4. No iPhone: **Ajustes → Geral → VPN e Gerenciamento de Dispositivo**, confie no seu Apple ID.
5. Com Apple ID gratuito, o app expira em 7 dias. Para renovar, repita o passo 2.

## 3. Ligar ao PC
1. No PC, abra o **iniciar-com-celular.bat** e anote o endereço (ex.: `http://192.168.0.10:7860`).
2. No app: **Ajustes** (ícone no canto superior) → cole o endereço → **Salvar**.
3. Quando o iPhone perguntar sobre a rede local, toque em **Permitir**.

## Atualizar a interface no app
Depois de mudar algo em `static/`, rode `npm run sync` dentro de `app-ios/` e gere o .ipa de novo.
