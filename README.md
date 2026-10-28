# Telinha

**Página para os amigos (download + passo a passo):** https://jonatanfragoso.github.io/App-Telinha/

Transmissão de tela entre amigos no Windows: **P2P, 1080p60 (ou de 360p até 4K), com áudio só do app que você escolher**, sem servidor. A conexão entre os PCs passa pelo **Tailscale**.

- O vídeo vai **direto** de quem transmite para quem assiste. Quem transmite usa o próprio upload.
- Um dos PCs é o **host**, que só repassa as mensagens de conexão (pouquíssimos dados). Se o host sair, outro assume sozinho.
- Mais de uma pessoa pode transmitir ao mesmo tempo, e você assiste uma ou várias, cada uma com seu próprio volume.
- O áudio pode ser **só da janela/app compartilhado** ou **o sistema todo, menos o app de voz** (Discord, TeamSpeak, Teams…). Assim a voz da call não vaza.

> **Uso responsável.** O Telinha é um projeto pessoal, gratuito e de código aberto, feito para **grupos privados de amigos adultos (18+)** compartilharem a tela entre si.
> - Não é um serviço público nem uma rede social: não tem servidor, contas ou cadastro, e não guarda nem distribui conteúdo. Tudo acontece direto entre os PCs de pessoas que já se conhecem.
> - Não modifica, não usa e não contorna o Discord nem qualquer outra plataforma. É um programa separado, como outros apps de compartilhamento de tela.
> - Não é destinado a crianças e adolescentes.
> - Cada pessoa é responsável pelo que transmite. Não use o Telinha para conteúdo ilegal, para expor alguém sem consentimento ou para qualquer coisa que envolva menores de idade.

---

## 1. Instalação (para cada amigo)

### 1.1 Tailscale (uma vez)

1. **Quem organiza** (o dono da rede) cria a conta em https://tailscale.com e instala o Tailscale no PC.
2. No painel (https://login.tailscale.com/admin/users), use **Invite users** e convide cada amigo por e-mail.
   - Todos precisam estar na **mesma tailnet**. O recurso "compartilhar dispositivo" não basta, porque ele só funciona em uma direção.
   - O plano gratuito tem limite de usuários. Confira se cabe o tamanho do grupo.
   - Para outro amigo também poder convidar: em **Users**, ⋯ ao lado do nome dele → **Edit role → IT admin**. Ele convida para a mesma rede (não crie outra rede: redes diferentes não se enxergam).
3. Cada amigo aceita o convite, instala o Tailscale no Windows e faz login com a conta convidada.
   - Quem já usava o Tailscale com outra rede: a conta pode estar em várias, mas o PC usa **uma por vez**. Entre na rede do grupo pelo ícone do Tailscale → **Add another account…** e escolha a rede de quem convidou. Depois dá para trocar pelo Telinha, em ⚙ → **Rede do Tailscale**.
4. Para testar, rode `tailscale status` no terminal: devem aparecer os PCs dos outros.

### 1.2 Telinha

1. Baixe o `Telinha-Setup-x.y.z.exe` (da página de **Releases** do repositório, ou do arquivo que alguém mandou).
2. Se o Windows mostrar **"O Windows protegeu o computador"**, clique em **Mais informações → Executar assim mesmo**. O aviso aparece porque o programa não é assinado digitalmente.
3. No final da instalação o Windows pede um **Sim**: é o instalador liberando o Telinha no **Firewall do Windows**, só para a rede do Tailscale (`100.64.0.0/10`). As atualizações não perguntam de novo. Se recusar, dá para liberar depois em ⚙ → **Liberar no firewall**.
4. Abra o Telinha, clique em **⚙** e coloque seu **nome**.

A partir daí, as atualizações chegam sozinhas (veja a seção 6).

**Requisitos:** Windows 10 versão 2004 (maio de 2020) ou mais novo, ou Windows 11. A captura de áudio por app depende disso.

---

## 2. Usuários, apelidos e salas

- **Nome:** é o apelido que aparece para todos. O padrão é o nome do PC. Para mudar: ⚙ → *Seu nome*.
- **Sala:** só aparece pra você quem estiver na mesma sala. O padrão é `geral`. Serve para separar grupos diferentes que usam a mesma tailnet.
- Não tem login nem senha. Quem está na tailnet e abre o Telinha na mesma sala entra. Cada vez que o app abre, ele gera um ID interno novo; o nome é só para exibição.
- A lista **Na sala** mostra quem está online. A coroa ♛ marca o host. **AO VIVO** marca quem está transmitindo. Embaixo do nome aparece se a conexão é **direta** (boa) ou **via relay** (lenta, veja a seção 7).

---

## 3. Configurando o host

O host **não** carrega vídeo de ninguém. Ele só ajuda os PCs a se encontrarem, então qualquer PC serve.

- No PC que fica ligado o tempo todo (o do seu amigo): ⚙ → **Ser host → "Sempre que eu estiver online (host fixo)"**.
- Nos outros, deixe **Normal**. Quem não quer ser host de jeito nenhum pode escolher **Evitar**.

Como a escolha funciona:

1. Se o host fixo estiver online, ele é o host.
2. Se não estiver, o primeiro a abrir o Telinha vira host.
3. Se o host fechar o app ou cair, em poucos segundos outra pessoa assume. As transmissões que já estavam rolando **continuam**, porque o vídeo não passa pelo host.
4. Quando o host fixo volta, ele retoma o papel.
5. Na lista, passe o mouse em alguém e clique em **Tornar host** para escolher manualmente.

---

## 4. Transmitindo e assistindo

**Para transmitir**, clique em **Transmitir** e:

1. Escolha uma **Tela** ou **Janela**.
2. Escolha o **Áudio**:
   - *Só o som desta janela (app.exe)*: aparece quando você escolhe uma janela. Só o som daquele programa vai junto. Se a janela for de um navegador, vai o som de todas as abas dele.
   - *Som do sistema, sem o Discord* (ou sem o TeamSpeak, Teams etc.): tudo que toca no PC, menos o app de voz que estiver aberto, detectado sozinho. O Windows só deixa tirar **um** app: se tiver dois apps de voz abertos, ou o Discord no navegador, o Telinha avisa que um deles vai vazar.
   - *Escolher um app específico*: útil para transmitir a tela inteira com o som de um app só (Spotify, um jogo etc.).
   - *Sem áudio*.
3. Escolha a **Qualidade**. Pode usar uma predefinição (360p30 até 4K60) ou ajustar resolução, FPS (15 a 144), bitrate (1 a 50 Mbps), codec e prioridade. O app lembra a última escolha.
4. Clique em **Começar transmissão**.

Durante a transmissão, o painel do topo mostra cada pessoa assistindo, com fps, Mbps e resolução reais. **GPU** quer dizer encode por hardware (ótimo); **CPU** é encode por software (mais pesado). Se aparecer **limitado: banda**, o seu upload não está dando conta; se aparecer **limitado: CPU**, o PC está pesado. Dá pra mudar resolução, FPS, bitrate e prioridade **sem parar a transmissão**.

**Para assistir**, procure em **Ao vivo agora** e clique em **Assistir**. Dá pra assistir várias transmissões ao mesmo tempo, cada uma em um quadro com volume próprio. Clique duplo (ou ⛶) deixa em tela cheia, e ⓘ mostra as estatísticas.

### Chat

O painel **💬 Chat** à direita tem a conversa da **Sala** (todo mundo da sala vê) e conversas privadas: passe o mouse em alguém da lista e clique em 💬. As mensagens não ficam salvas: fechou o app, sumiram. O botão **💬 Chat** no topo esconde/mostra o painel e mostra quantas mensagens novas chegaram.

### Jogando agora e pedidos de transmissão (opcional)

Em ⚙ → **Jogos** dá pra ligar **"Mostrar para a sala quando eu estiver jogando"**. Vem **desligado**: desligado, o Telinha nem verifica o que está aberto.

- Ligado, aparece **🎮 Nome do jogo** embaixo do seu nome na lista. Só o nome do jogo vai para a sala, nunca título de janela ou outros programas.
- O jogo é reconhecido pela lista de jogos que o próprio Discord usa, pelas pastas da Steam, Epic, GOG, Xbox, Riot, EA e Ubisoft, e pela sua lista em **Meus jogos** (ex.: `eldenring.exe = Elden Ring`). Em **Nunca mostrar** você bloqueia um .exe.
- Com **"Deixar pedirem para eu transmitir enquanto jogo"**, os outros veem o botão **Pedir transmissão**, mas **só enquanto você está jogando**. Você recebe um aviso com **Escolher o que transmitir** ou **Recusar**. Aceitar só abre a escolha de tela: **nada é transmitido sem você confirmar**.
- Cada pessoa pode pedir no máximo uma vez a cada 10 minutos (30 depois de uma recusa). Sem resposta em 2 minutos, o pedido expira.

### Quanto de upload eu preciso?

Quem transmite envia uma cópia para **cada** pessoa assistindo:

| Qualidade | Bitrate sugerido | 3 pessoas assistindo |
|---|---|---|
| 720p30 | 4 Mbps | ~12 Mbps |
| 1080p60 | 8–10 Mbps | ~30 Mbps |
| 1440p60 | 16 Mbps | ~48 Mbps |
| 4K60 | 35 Mbps | ~105 Mbps |

---

## 5. Desenvolvimento (VS Code)

Requisitos: **Node.js 22+**, **Git** e VS Code.

```bash
git clone git@github.com:jonatanfragoso/App-Telinha.git
cd App-Telinha
npm install
npm start          # abre o app direto do código
npm run dist       # gera dist/Telinha-Setup-x.y.z.exe localmente (sem publicar)
```

Estrutura:

```
main.js              processo principal (janela, captura, IPC)
preload.js           ponte segura entre a interface e o main
lib/mesh.js          descoberta via Tailscale, eleição de host, sinalização
lib/tailscale.js     lê "tailscale status --json"
lib/audio.js         conversa com o audiocap.exe
lib/updater.js       atualização automática (GitHub Releases)
lib/games.js         detecção de "jogando agora" (opcional)
renderer/            interface (HTML/CSS/JS) e WebRTC
native/audiocap.cpp  helper C++ de áudio por processo (Process Loopback do Windows)
native/audiocap.exe  já compilado. Recompile só se mexer no .cpp
.github/workflows/   compila e publica a versão nova no GitHub
```

Se alterar o `native/audiocap.cpp`, recompile com:
- **WSL/Linux:** `sudo apt install g++-mingw-w64-x86-64-posix` e depois `./native/build.sh`
- **Windows:** abra o *x64 Native Tools Command Prompt* do Visual Studio, entre em `native` e rode `build.bat`

**Testar dois PCs no mesmo computador não funciona**, porque os dois usariam a mesma porta (47800). Teste com outro PC na tailnet. Também dá pra testar na rede local sem Tailscale: coloque o IP do outro PC em ⚙ → *IPs extras* (na versão instalada, a regra do firewall só libera a rede do Tailscale; para a rede local, crie uma regra à parte).

---

## 6. Atualizações automáticas

O app instalado verifica o **GitHub Releases** ao abrir e a cada 2 horas. Quando encontra uma versão nova, baixa em segundo plano (esperando terminar se você estiver transmitindo ou assistindo) e mostra uma faixa no topo: **Nova versão disponível. [Atualizar agora] [Depois]**. Clicando, ele instala e reabre em poucos segundos, sem precisar desinstalar nada. **Nada é instalado sem você clicar**; se escolher "Depois", a faixa volta na próxima vez que abrir o app, e o botão verde **Atualizar para x.y.z** fica no topo.

### Configuração

O `package.json` já aponta para **jonatanfragoso/App-Telinha** (em `build.publish`). Para as atualizações funcionarem, o repositório precisa ser **público**: o atualizador baixa os Releases sem login, e não há senha nem token no código. Se um dia mudar o nome do repositório, ajuste `build.publish` e `repository` no `package.json`.

### Publicar uma versão nova

```bash
# faça as alterações, teste com npm start, faça o commit
npm version patch        # 0.1.0 -> 0.1.1 (use "minor" para 0.2.0); cria a tag sozinho
git push --follow-tags
```

O GitHub Actions compila no Windows e publica o `Telinha-Setup-x.y.z.exe` + `latest.yml` em **Releases**. Acompanhe na aba **Actions** do repositório (leva uns 5 minutos). Depois disso, os apps dos amigos atualizam sozinhos.

Também dá pra publicar a partir do seu PC: `set GH_TOKEN=seu_token` e depois `npm run release` (o token precisa da permissão *contents: write*).

> O instalador só é mandado para os amigos **uma vez**. Depois disso, cada `npm version` + `git push --follow-tags` chega até eles pelo botão **Atualizar**.

---

## 7. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "Tailscale não encontrado ou desligado" | Abra o Tailscale e faça login. Se instalou em outra pasta, informe o caminho em ⚙. |
| Não aparece ninguém na sala | Confira se estão na mesma tailnet (`tailscale status`; em ⚙ → *Rede do Tailscale* aparece a rede em uso), com o Telinha aberto, na mesma sala, e se o firewall está liberado (⚙ → *Firewall do Windows*). Teste: `http://IP-DO-AMIGO:47800/info` no navegador; se não carregar, `tailscale ping IP-DO-AMIGO` (pong = firewall dele; *no matching peer* = redes diferentes). |
| "via relay (lento)" | O Tailscale não conseguiu conexão direta (CGNAT pesado) e está usando os servidores DERP dele, que são lentos para vídeo. Teste com `tailscale ping NOME-DO-PC`. Reiniciar o Tailscale ou ativar UPnP no roteador costuma resolver. |
| Imagem travando ou borrada | Veja as estatísticas. "limitado: banda" → reduza bitrate/resolução; "CPU" → use H.264 e confira se aparece "GPU". |
| Áudio falhou | Exige Windows 10 2004+. O app escolhido precisa estar tocando som. Veja o erro em ⚙ → Registro. |
| Tela preta ao capturar um jogo | Rode o jogo em janela ou sem bordas, ou capture a tela inteira em vez da janela. |
