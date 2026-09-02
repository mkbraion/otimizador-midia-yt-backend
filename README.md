# Oficina de Mídia — Backend de download do YouTube

Servidor Node que a [Oficina de Mídia](https://otimizador-midia.vercel.app) usa para baixar
vídeos do YouTube (via **yt-dlp**). O download acontece do **seu** servidor direto para o seu
aparelho — a Vercel (site) não participa disso.

> **Por que um backend?** Navegador nenhum consegue baixar do YouTube (bloqueio de origem +
> assinatura dos links). Precisa de um servidor rodando o yt-dlp. E como o site é HTTPS,
> o servidor também precisa ser HTTPS (por isso Railway/Render, que dão HTTPS de graça).

## Endpoints
- `GET /health` — teste rápido.
- `GET /info?url=<link>` — título, duração, miniatura e resoluções disponíveis.
- `GET /download?url=<link>&height=<720>&title=<nome>` — baixa o vídeo (junta em HD se houver ffmpeg).
- `GET /download?url=<link>&audio=1` — baixa só o áudio (.m4a).

## Rodar localmente
```bash
npm install
npm start
# servidor em http://localhost:8080
```
Para baixar em HD (1080p/720p) instale o **ffmpeg** no sistema. Sem ffmpeg, o yt-dlp cai para a
melhor qualidade "progressiva" (arquivo único, normalmente 360p).

> ⚠️ Rodando em `http://localhost`, o site **HTTPS** da Vercel não consegue chamar o servidor
> (bloqueio de "conteúdo misto"). Para usar com o site publicado, hospede o servidor com HTTPS
> (Railway/Render). Para uso 100% local, rode o site localmente também.

## Deploy no Railway (recomendado — HTTPS + ffmpeg automáticos)
1. Suba este repositório no GitHub.
2. Em [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → escolha este repo.
3. O `nixpacks.toml` já instala o **ffmpeg**; o start é `npm start`.
4. Railway gera uma URL `https://...up.railway.app`. Cole ela no campo **"Endereço do seu servidor"** da Oficina de Mídia.

## Deploy no Render
1. **New → Web Service** apontando para o repo. Build `npm install`, start `npm start`.
2. O ambiente Node do Render **não traz ffmpeg** — para HD, use um Dockerfile com ffmpeg
   (ou aceite o fallback 360p). Railway é mais simples para este caso.

## Modo API (estável, contorna o bloqueio do YouTube)
Rodar yt-dlp de um IP de nuvem leva bloqueio ("Sign in to confirm you're not a bot").
Pra ficar estável como os sites grandes, use uma API de extração:

1. No [RapidAPI](https://rapidapi.com), assine **youtube-media-downloader** (tem plano free com cota).
2. No Railway → seu serviço → **Variables**, adicione:
   - `RAPIDAPI_KEY` = sua chave do RapidAPI
   - `RAPIDAPI_HOST` = `youtube-media-downloader.p.rapidapi.com` (opcional; é o padrão)
3. Redeploy. Confira em `/health` que aparece `"api": true`.

Com a API ligada, `/info` e `/download` usam ela; sem chave, caem no yt-dlp.
`/raw?url=...` mostra a resposta crua da API (útil pra depurar).

## Observações
- Só aceita links do YouTube (validação de domínio no servidor).
- Uso pessoal. Respeite os direitos autorais e os Termos do YouTube — baixe conteúdo seu,
  de domínio público, Creative Commons ou com permissão.
