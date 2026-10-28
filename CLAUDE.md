# Telinha — contexto do projeto

App desktop para **Windows** (Electron) de transmissão de tela entre um grupo pequeno de amigos, **P2P via WebRTC**, sem servidor próprio. A rede entre os PCs é o **Tailscale** (todos na mesma tailnet). A comunicação por voz continua no Discord; o Telinha é só vídeo + áudio da transmissão.

Repositório: `github.com/jonatanfragoso/App-Telinha` (público, necessário para o auto-update).
Interface e mensagens ao usuário: **português do Brasil**.

## Objetivos e decisões já tomadas

- **Qualidade configurável:** 360p até 4K / "Original", 15–144 fps, 1–50 Mbps, codec H.264 (padrão, encode por GPU), VP9 ou AV1, prioridade fluidez/nitidez. Há predefinições, a última escolha fica salva (localStorage) e dá pra mudar resolução/fps/bitrate **ao vivo** (`applyConstraints` + `setParameters`).
- **Áudio sem vazar o Discord:** um helper nativo (`native/audiocap.exe`, C++) usa o **Process Loopback** do Windows (Win10 2004+). Os modos são: só o app da janela compartilhada (inclui a árvore de processos), sistema inteiro exceto o Discord (exclui a árvore do Discord.exe; se o Discord não estiver aberto, exclui o próprio Telinha) e app específico (lista as sessões de áudio). O helper manda PCM s16le 48 kHz estéreo pelo stdout → main → IPC → AudioWorklet (`renderer/pcm-worklet.js`) → MediaStreamDestination → track WebRTC. O Opus vai estéreo a 192 kbps (SDP munging).
- **Topologia:** mesh. Quem transmite envia uma cópia para cada espectador e usa o próprio upload. Várias pessoas podem transmitir ao mesmo tempo, e cada espectador escolhe quais assistir (tiles com volume próprio).
- **Host = só sinalização.** Todo app roda HTTP `/info` + WebSocket `/ws` na porta **47800**, escutando no IP do Tailscale. O app descobre os peers com `tailscale status --json`, consulta o `/info` de cada um e elege um host de forma determinística: maior `priority` (+`boost`), depois quem abriu antes (`startedAt`), depois o `id`. O host repassa offer/answer/ICE; a mídia **não** passa por ele. Failover automático: se o host cai, os clientes reelegem e as conexões de mídia continuam. "Tornar host" manda `promote` (boost=1000). Prioridade nas configurações: 10 = host fixo, 0 = normal, −10 = evitar.
- **Salas:** a mesma tailnet pode ter grupos separados pelo nome da sala (`room`). Não há login; o nome é só um apelido; o `id` é um UUID novo a cada execução.
- **Sem STUN/TURN:** `iceServers: []`; os candidatos host do adaptador do Tailscale bastam. A flag `--disable-features=WebRtcHideLocalIpsWithMdns` é **obrigatória**, porque sem ela quem só assiste anuncia `.local` (mDNS) e não conecta.
- **Auto-update:** `electron-updater` + GitHub Releases. Funciona só na versão instalada (NSIS, por usuário, sem admin). Verifica ao abrir e a cada 2 h, baixa em segundo plano e mostra o botão verde "Atualizar para x.y.z"; se o usuário não clicar, instala ao fechar.

## Estrutura

```
main.js              janela, flags do Chromium, IPC, desktopCapturer
preload.js           API window.telinha (contextIsolation)
lib/mesh.js          descoberta, eleição de host, servidor de sinalização
lib/tailscale.js     wrapper de `tailscale status --json`
lib/audio.js         spawn do audiocap.exe e repasse do PCM
lib/updater.js       electron-updater
renderer/index.html  UI (sem framework)
renderer/app.js      WebRTC, seletor de fontes, tiles, estatísticas, configurações
renderer/style.css   tema escuro, acento #ff5a3c
renderer/pcm-worklet.js  ring buffer PCM -> áudio
native/audiocap.cpp  helper de áudio (comandos: sessions | hwnd <h> | find <exe> | capture include|exclude <pid>)
native/audiocap.exe  binário versionado (MinGW, estático)
.github/workflows/release.yml  build + publicação no Windows ao enviar tag v*
```

## Fluxo de desenvolvimento

- `npm install` → `npm start` roda o app pelo código.
- **No WSL** o `npm start` abre a versão Linux do Electron: dá pra ver a interface, mas **captura de áudio, Tailscale do Windows e o comportamento real não funcionam**. Teste de verdade = Windows (PowerShell: `npm install && npm start`) ou o instalador gerado pelo CI.
- Não dá pra testar duas instâncias no mesmo PC (porta 47800 e trava de instância única). Para testar na LAN sem Tailscale, use ⚙ → IPs extras.
- Recompilar o helper (só se mexer no .cpp): WSL `sudo apt install g++-mingw-w64-x86-64-posix && ./native/build.sh`, ou MSVC com `native\build.bat`. Faça commit do `audiocap.exe`.
- `npm run dist` gera o instalador localmente (no Windows; no Linux exige wine + wine32).

## Publicar versão (chega aos amigos pelo botão Atualizar)

```bash
git add -A && git commit -m "..."
npm version patch          # ou minor; cria a tag vX.Y.Z
git push --follow-tags     # o Actions compila e publica a Release
```

Commits sem tag **não** geram atualização. O workflow tem um passo final que reenvia `latest.yml` + `.exe` + `.blockmap` com `gh release upload --clobber`, porque na v0.1.0 o `latest.yml` ficou de fora e o updater dava 404. Não remova esse passo.

Link de download para amigos novos: https://github.com/jonatanfragoso/App-Telinha/releases/latest

## Estado atual / pendências

- v0.1.2 publicada com o auto-update testado e funcionando.
- **Ainda não validado em uso real:** captura de áudio por processo no Windows, 1080p60 entre PCs diferentes pelo Tailscale e failover com transmissão em andamento. A eleição de host foi testada com 3 instâncias simuladas (127.0.0.1/2/3).
- O teste automatizado de tela usa as variáveis `TELINHA_SHOT` / `TELINHA_JS` em `main.js` (captura um PNG e fecha o app).
- Ideias futuras: SFU no host para quem tem upload fraco, lista de quem está assistindo para os espectadores, atalho de tela cheia, notificação quando alguém entra ao vivo.
