# Telinha — contexto do projeto

App desktop para **Windows** (Electron) de transmissão de tela entre um grupo pequeno de amigos, **P2P via WebRTC**, sem servidor próprio. A rede entre os PCs é o **Tailscale** (todos na mesma tailnet). A comunicação por voz continua no Discord; o Telinha é só vídeo + áudio da transmissão.

Repositório: `github.com/jonatanfragoso/App-Telinha` (público, necessário para o auto-update).
Interface e mensagens ao usuário: **português do Brasil**.

**Posicionamento (importante para o Jonatan):** o Telinha é para **uso privado entre amigos adultos (18+)**, sem fins comerciais. Desde 17/08/2026 o Discord está sem vídeo/compartilhamento de tela no Brasil por ordem da ANPD (ECA Digital). O Telinha **não** contorna isso: não usa, não modifica e não se integra ao Discord. Nunca divulgue nem descreva o app (site, README, textos) como "alternativa ao bloqueio do Discord" ou "jeito de burlar". O aviso "Uso responsável" fica no README e no site (`#uso`); mantenha-o. Se um dia houver divulgação para o público em geral, recomende falar com um advogado.

## Objetivos e decisões já tomadas

- **Qualidade configurável:** 360p até 4K / "Original", 15–144 fps, 1–50 Mbps, codec H.264 (padrão, encode por GPU), VP9 ou AV1, prioridade fluidez/nitidez. Há predefinições, a última escolha fica salva (localStorage) e dá pra mudar resolução/fps/bitrate **ao vivo** (`applyConstraints` + `setParameters`).
- **Áudio sem vazar o Discord:** um helper nativo (`native/audiocap.exe`, C++) usa o **Process Loopback** do Windows (Win10 2004+). Os modos são: só o app da janela compartilhada (inclui a árvore de processos), sistema inteiro exceto um app de voz (`audio.voiceApps()` acha os abertos via `tasklist` numa lista de exes conhecidos — Discord/PTB/Canary, TeamSpeak, Teams, Zoom, WhatsApp, Skype, Mumble etc. — e exclui a árvore do escolhido; o Windows só permite excluir **uma** árvore por captura, então com dois abertos ou Discord no navegador a interface avisa que vai vazar; sem app de voz, exclui o próprio Telinha) e app específico (lista as sessões de áudio). O helper manda PCM s16le 48 kHz estéreo pelo stdout → main → IPC → AudioWorklet (`renderer/pcm-worklet.js`) → MediaStreamDestination → track WebRTC. O Opus vai estéreo a 192 kbps (SDP munging).
- **4:3 esticado:** o jogo desenha 4:3 e o monitor de quem joga estica, então a captura chega 4:3 e quem assiste via faixas pretas. Quem transmite marca "Mostrar esticado" (seletor, salvo no `telinha.quality`, ou "Esticado" ao vivo) e vai `streaming.stretch` na sala; o tile usa `object-fit: fill` (classe `.stretch`). Quem assiste pode ligar/desligar no botão "⇔ Esticar" (topo e barra da tela cheia), e a escolha dele vence a de quem transmite. Só muda a exibição, não o vídeo.
- **Tela cheia:** barra no rodapé com degradê (nome, mudo, volume %, esticar, sair) que some junto com o ponteiro após 2,5 s parado; roda do mouse ajusta o volume e M muta.
- **Topologia:** mesh. Quem transmite envia uma cópia para cada espectador e usa o próprio upload. Várias pessoas podem transmitir ao mesmo tempo, e cada espectador escolhe quais assistir (tiles com volume próprio).
- **Host = só sinalização.** Todo app roda HTTP `/info` + WebSocket `/ws` na porta **47800**, escutando no IP do Tailscale. O app descobre os peers com `tailscale status --json`, consulta o `/info` de cada um e elege um host de forma determinística: maior `priority` (+`boost`), depois quem abriu antes (`startedAt`), depois o `id`. O host repassa offer/answer/ICE; a mídia **não** passa por ele. Failover automático: se o host cai, os clientes reelegem e as conexões de mídia continuam. "Tornar host" manda `promote` (boost=1000). Prioridade nas configurações: 10 = host fixo, 0 = normal, −10 = evitar.
- **Firewall:** o instalador (`build/installer.nsh`, `customInstall`) cria a regra `Telinha-Tailscale` (entrada, Telinha.exe, só `remoteip=100.64.0.0/10`), pedindo um UAC só se ela ainda não existe; antes apaga as regras de entrada do exe, porque um "Cancelar" no aviso do Windows cria bloqueio e bloqueio vence permissão. ⚙ mostra o estado e tem "Liberar no firewall" (`lib/firewall.js`, mesma regra via PowerShell `-Verb RunAs`), que também aparece na dica "Ninguém mais por aqui". Efeito colateral: na versão instalada, "IPs extras" na LAN precisa de regra à parte.
- **Rede do Tailscale:** a conta pode estar em várias tailnets, mas o PC usa uma por vez (caso real: o Jonatan ficou na rede antiga dele e não via o amigo; `tailscale ping` dava *no matching peer*). ⚙ → "Rede do Tailscale" lista `tailscale switch --list` e troca com `tailscale switch <id>` (só IDs da lista); a dica de sala vazia mostra a rede atual (`CurrentTailnet.Name`), botões "Ir para a rede X" (outras redes do PC) e "Entrar em outra rede…". "Entrar em outra rede…" roda `tailscale login` (adiciona conta/rede e passa a usá-la), lê o link `https://login.tailscale.com/...` da saída e abre no navegador; espera até 10 min o login terminar.
- **Salas:** a mesma tailnet pode ter grupos separados pelo nome da sala (`room`). Não há login; o nome é só um apelido; o `id` é um UUID novo a cada execução.
- **Sem STUN/TURN:** `iceServers: []`; os candidatos host do adaptador do Tailscale bastam. A flag `--disable-features=WebRtcHideLocalIpsWithMdns` é **obrigatória**, porque sem ela quem só assiste anuncia `.local` (mDNS) e não conecta.
- **Chat:** sala (`# Sala`) + conversas privadas. Mensagem `{type:'chat', scope:'room'|'dm', text, name}` pelo relay do host (para a sala, uma cópia para cada membro). Só em memória, nada é salvo. **Imagens** (📎, Ctrl+V de print ou arrastar): o renderer reduz para ≤ 1920 px em webp (GIF ≤ 2 MB vai como está), prévia antes de enviar, e manda `chatimg` em pedaços de 200 KB (`id`, `n`, `i`, `part`), porque o host derruba mensagens WebSocket > 512 KB (`maxPayload`, inclusive em versões antigas). Quem recebe aceita só png/jpeg/webp/gif, ≤ ~2 MB, até 3 envios simultâneos por pessoa, e guarda as últimas 60 imagens na memória. **Apagar para todos:** toda mensagem/imagem tem `id`; o autor manda `chatdel {id, scope}` para quem está na sala/conversa, e quem recebe só apaga se `from` for o autor original (fica "mensagem apagada").
- **"Jogando agora" + pedir transmissão:** opt-in (`gameDetect`, desligado por padrão). `lib/games.js` lista processos a cada 15 s via PowerShell (`Get-Process`, caminho + se tem janela) e decide: lista do usuário (`gameList`, "exe = Nome") > lista pública do Discord (`/api/v9/applications/detectable`, baixada e reduzida para `userData/games-db.json`, renovada a cada 7 dias; nomes genéricos como `game.exe` sem pasta são ignorados) > pastas de lojas (steamapps\common, Epic, GOG, Xbox, Riot, EA, Ubisoft; precisa ter janela). `gameIgnore` = nunca mostrar. Para a sala vai só `self.playing = {name, requests}`. Pedido = `askstream` → cartão Aceitar/Recusar (+ notificação do Windows e taskbar piscando); aceitar **só abre o seletor de tela**. Limites: 1 pedido por pessoa a cada 10 min, 30 min após recusa, expira em 2 min. Quem pediu entra sozinho se a transmissão começar em até 5 min. Teste sem jogo: `TELINHA_FAKE_GAME="Nome"`.
- **Segurança (qualquer PC da tailnet pode falar com o app):** tudo que vem de outros PCs é dado, nunca HTML: membros passam por `cleanMember` no renderer e todo texto vai por `esc()`/`textContent`. O CSP (sem `unsafe-inline` para scripts) é a segunda barreira. `settings:set` só aceita campos conhecidos (`cleanSettings` no main) e o `tailscalePath`, que é executado, só pode ser um `tailscale.exe` existente. Links externos só `http(s)`, e a janela não navega. Quem transmite vê um aviso quando alguém começa a assistir. Opcional, feito pelo dono da tailnet: política de acesso liberando só TCP 47800 + UDP entre amigos.
- **Avatar:** no lugar da inicial. `settings.avatar` = emoji da lista `AV_EMOJIS` + cor (0–7) ou foto (data URL 128×128 webp/jpeg, recortada no renderer, ≤ 90 KB, `hash` = sha256[0..16] calculado no main). Na sala vai só `self.avatar` = `{kind:'emoji',…}` ou `{kind:'photo',hash}`; quem não tem a foto pede `avatarreq` e recebe `avatar` pelo relay, e só aceita se o sha256 bater com o hash (cache em memória).
- **Sons** (WebAudio, sem arquivos; opção `sounds`, ligada por padrão): entrou / saiu / começou a transmitir. "Entrou" = id nunca visto (sem som ao abrir o app nem ao trocar de sala); "saiu" só conta com o mesmo host há ≥ 10 s, porque na troca de host a lista se refaz aos poucos. Silenciados (vira aviso na tela) quando você transmite com "som do sistema", senão iriam na transmissão.
- **Auto-update:** `electron-updater` + GitHub Releases. Funciona só na versão instalada (NSIS, por usuário, sem admin). Verifica ao abrir e a cada 2 h e baixa em segundo plano (`autoDownload` desligado: `lib/updater.js` controla o download e o adia/cancela enquanto há transmissão própria ou assistida, avisado pelo renderer via `update:busy`). Pronto, mostra a faixa "Nova versão… [Atualizar agora] [Depois]" e o botão verde no topo. **Só instala com o clique** (`autoInstallOnAppQuit = false`); a faixa volta a cada abertura do app.

## Estrutura

```
main.js              janela, flags do Chromium, IPC, desktopCapturer
preload.js           API window.telinha (contextIsolation)
lib/mesh.js          descoberta, eleição de host, servidor de sinalização
lib/tailscale.js     wrapper de `tailscale status --json`
lib/audio.js         spawn do audiocap.exe e repasse do PCM
lib/updater.js       electron-updater
lib/games.js         detecção de jogo (opt-in) e lista do Discord
renderer/index.html  UI (sem framework)
renderer/app.js      WebRTC, seletor de fontes, tiles, estatísticas, chat, pedidos, configurações
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

Commits sem tag **não** geram atualização. No workflow o `electron-builder` só compila (`npm run dist`, que também gera o `latest.yml`), e um passo com `gh release create` + `gh release upload --clobber` publica tudo. Não volte a usar `npm run release` no CI: o electron-builder envia os arquivos em paralelo e criava **duas Releases por tag** (até a v0.2.0), o que fez o `latest.yml` sumir na v0.1.0.

**Depois de publicar** (pedido do Jonatan, autorizado de forma permanente): conferir que o Actions terminou e que a Release nova tem `latest.yml` + `.exe` + `.blockmap`, e então **manter só as duas últimas Releases**, apagando as mais antigas sem perguntar (`gh.exe api -X DELETE repos/jonatanfragoso/App-Telinha/releases/<id>`). As tags no git ficam. No WSL não há `gh`: use o `gh.exe` do Windows sempre com `-R jonatanfragoso/App-Telinha`.

Link para amigos novos: https://jonatanfragoso.github.io/App-Telinha/ (GitHub Pages, pasta `docs/`, branch main; sai no ar com um push, sem tag). A página busca as versões na API do GitHub e ignora as releases duplicadas. Download direto: https://github.com/jonatanfragoso/App-Telinha/releases/latest

## Estado atual / pendências

- v0.1.2 publicada com o auto-update testado e funcionando.
- **Não testado em Windows ainda:** regra do firewall no instalador/botão e a troca de rede do Tailscale pelo app e o botão "Entrar em outra rede…" (`tailscale login`).
- **Ainda não validado em uso real:** captura de áudio por processo no Windows, 1080p60 entre PCs diferentes pelo Tailscale e failover com transmissão em andamento. A eleição de host foi testada com 3 instâncias simuladas (127.0.0.1/2/3).
- O teste automatizado de tela usa as variáveis `TELINHA_SHOT` / `TELINHA_JS` em `main.js` (captura um PNG e fecha o app).
- **Não testado em Windows ainda:** chat, detecção de jogo (PowerShell) e pedidos de transmissão. A regra de detecção foi testada no Node com a lista real do Discord e caminhos simulados.
- **Assinatura de código (SignPath Foundation, grátis para open source):** inscrição enviada em 28/10/2026, aguardando resposta por e-mail. A política exigida está em `docs/assinatura.html` e o site cita a SignPath abaixo do botão de download. Se aprovarem: assinar o instalador **durante** o build (antes de gerar o `latest.yml`, senão o sha512 do atualizador não bate). Possíveis objeções: o fallback do `native/audiocap.exe` versionado no workflow (eles exigem compilação a partir do código) e o `Telinha.exe` ser o binário do Electron (terceiros). Se recusarem por o projeto ser novo, tentar de novo depois de mais uso.
- Ideias futuras: histórico do chat (decidido por ora manter igual ao TeamSpeak, sumindo ao fechar; se voltar: cada PC guarda o que viu, por tailnet + sala, 30 dias, DMs identificadas pelo IP do PC, e "apagar para todos" reenviado a quem volta, porque a preocupação é mensagem enviada sem querer ficar salva), SFU no host para quem tem upload fraco, lista de quem está assistindo para os espectadores, atalho de tela cheia, notificação quando alguém entra ao vivo.
