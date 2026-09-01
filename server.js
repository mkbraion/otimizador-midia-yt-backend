// Backend de download do YouTube para a Oficina de Mídia.
// Usa yt-dlp (via youtube-dl-exec). Roda em qualquer lugar com Node 18+.
//   npm install && npm start
// Para baixar em HD (1080p/720p) o yt-dlp precisa do ffmpeg instalado no servidor,
// pra juntar as faixas de vídeo e áudio. Sem ffmpeg, ele cai para a melhor
// qualidade "progressiva" (arquivo único, normalmente 360p, às vezes 720p).
// Deploy fácil: Railway/Render (dão HTTPS de graça, necessário pro site na Vercel).

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const os = require("os");
const path = require("path");
const fs = require("fs");
const ytdl = require("youtube-dl-exec");
// usa o yt-dlp mais recente instalado no container (YTDLP_PATH); local cai no bundled.
const youtubedl = (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH))
  ? ytdl.create(process.env.YTDLP_PATH) : ytdl;

const app = express();
const PORT = process.env.PORT || 8080;

// limite de duração (segundos) — bloqueia filmes/lives enormes. Ajustável por env.
const MAX_DURATION = parseInt(process.env.MAX_DURATION) || 2700; // 45 min

app.set("trust proxy", 1); // atrás do proxy do Railway (IP real vem no X-Forwarded-For)
app.use(cors());

// proteção contra abuso: limite de requisições por IP
const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "Muitas buscas seguidas. Espere um minuto e tente de novo." } });
const dlLimiter = rateLimit({ windowMs: 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: "Muitos downloads seguidos. Espere um minuto e tente de novo." } });

function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}
function isYouTube(u) {
  const h = host(u);
  return !!h && ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(h);
}
// Outros sites suportados nativamente pelo yt-dlp (grátis, sem API paga).
function isTikTok(u)    { const h = host(u); return !!h && /(^|\.)tiktok\.com$/.test(h); }
function isPinterest(u) { const h = host(u); return !!h && (/(^|\.)pinterest\.[a-z.]+$/.test(h) || h === "pin.it"); }
function isMedal(u)     { const h = host(u); return !!h && /(^|\.)medal\.tv$/.test(h); }
function isInstagram(u) { const h = host(u); return !!h && (/(^|\.)instagram\.com$/.test(h) || h === "instagr.am"); }
function isFacebook(u)  { const h = host(u); return !!h && (/(^|\.)facebook\.com$/.test(h) || h === "fb.watch" || h === "fb.com"); }
// URL aceita pelo backend público.
function isSupported(u) { return isYouTube(u) || isTikTok(u) || isPinterest(u) || isMedal(u) || isInstagram(u) || isFacebook(u); }
function safeName(s) {
  return (s || "video").replace(/[^\w\-. ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

// Cookies opcionais (pra driblar o "confirme que não é um robô" em IP de nuvem).
// Defina a env YTDLP_COOKIES_B64 = base64 de um cookies.txt exportado do navegador logado.
const COOKIE_PATH = (() => {
  const b64 = process.env.YTDLP_COOKIES_B64;
  if (!b64) return null;
  try { const p = path.join(os.tmpdir(), "yt-cookies.txt"); fs.writeFileSync(p, Buffer.from(b64, "base64")); return p; }
  catch { return null; }
})();

// Opções comuns: tenta clientes que às vezes passam sem login + cookies se houver.
function commonOpts() {
  const o = {
    noWarnings: true, noCheckCertificates: true, noPlaylist: true,
    extractorArgs: "youtube:player_client=default,android,web_safari,tv",
  };
  if (COOKIE_PATH) o.cookies = COOKIE_PATH;
  return o;
}

// ---- API de extração (RapidAPI) — quando configurada, contorna o bloqueio do YouTube ----
// Assine "youtube-media-downloader" no RapidAPI e defina no servidor:
//   RAPIDAPI_KEY   = sua chave
//   RAPIDAPI_HOST  = youtube-media-downloader.p.rapidapi.com  (padrão)
const RAPID_KEY = process.env.RAPIDAPI_KEY || "";
const RAPID_HOST = process.env.RAPIDAPI_HOST || "youtube-media-downloader.p.rapidapi.com";
const USE_API = !!RAPID_KEY;
const { Readable } = require("stream");

function videoId(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1).split("/")[0];
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const m = url.pathname.match(/\/(shorts|embed)\/([^/?#]+)/); if (m) return m[2];
  } catch {}
  return null;
}
async function apiDetails(id) {
  const r = await fetch(`https://${RAPID_HOST}/v2/video/details?videoId=${encodeURIComponent(id)}`,
    { headers: { "X-RapidAPI-Key": RAPID_KEY, "X-RapidAPI-Host": RAPID_HOST } });
  if (!r.ok) throw new Error("API respondeu " + r.status);
  return r.json();
}
const fnum = q => { const m = String(q || "").match(/(\d{3,4})/); return m ? parseInt(m[1]) : 0; };
const pickThumb = j => { const t = j.thumbnails || j.thumbnail; if (Array.isArray(t) && t.length) return t[t.length - 1].url || t[t.length - 1]; return j.thumbnail || null; };
const apiVideos = j => (j.videos && j.videos.items) || j.videos || j.formats || [];
const apiAudios = j => (j.audios && j.audios.items) || j.audios || [];
const { spawn } = require("child_process");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const vh = v => fnum(v.quality || v.qualityLabel || v.height);
// só H.264/avc (mp4) dá pra juntar por cópia e tocar em qualquer lugar — é o que entregamos.
function videoPool(j) {
  const vids = apiVideos(j).filter(v => v && v.url);
  const avc = vids.filter(v => /avc1|h264/i.test(v.mimeType || ""));
  const mp4 = vids.filter(v => (v.extension || "").toLowerCase() === "mp4");
  const pool = avc.length ? avc : (mp4.length ? mp4 : vids);
  return pool.slice().sort((a, b) => vh(b) - vh(a));
}
function infoFromApi(j) {
  const heights = [...new Set(videoPool(j).map(vh).filter(Boolean))].sort((a, b) => b - a);
  return {
    title: j.title, duration: j.lengthSeconds || j.duration || 0, thumbnail: pickThumb(j),
    uploader: (j.channel && j.channel.name) || j.author || j.uploader,
    maxHeight: heights[0] || null, heights,
  };
}
function streamUrl(res, url, filename, ctype) {
  return fetch(url).then(up => {
    if (!up.ok || !up.body) { if (!res.headersSent) res.status(502).send("Falha ao obter o arquivo."); return; }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", ctype);
    const len = up.headers.get("content-length"); if (len) res.setHeader("Content-Length", len);
    Readable.fromWeb(up.body).pipe(res);
  });
}
async function fetchToFile(url, file) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error("fetch " + r.status);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    Readable.fromWeb(r.body).pipe(ws); ws.on("finish", resolve); ws.on("error", reject);
  });
}
async function apiDownload(res, url, audio, H, title) {
  const id = videoId(url); if (!id) return res.status(400).send("Link inválido.");
  const j = await apiDetails(id);
  const dur = j.lengthSeconds || j.duration || 0;
  if (dur && dur > MAX_DURATION) return res.status(413).send(`Vídeo muito longo (máx. ${Math.round(MAX_DURATION / 60)} min neste servidor público).`);

  if (audio) {
    const a = apiAudios(j); const aud = a.find(x => (x.extension || "") === "m4a") || a[0];
    if (!aud || !aud.url) return res.status(500).send("Sem faixa de áudio disponível.");
    return streamUrl(res, aud.url, safeName(title) + ".m4a", "audio/mp4");
  }

  const pool = videoPool(j);
  const chosen = H ? (pool.find(v => vh(v) <= H) || pool[pool.length - 1]) : pool[0];
  if (!chosen) return res.status(500).send("Nenhum formato disponível.");
  // 360p já vem com áudio → manda direto
  if (chosen.hasAudio) return streamUrl(res, chosen.url, safeName(title) + ".mp4", "video/mp4");

  // resoluções altas: junta vídeo + áudio com ffmpeg, TRANSMITINDO em tempo real
  // (mp4 fragmentado por pipe) — evita o timeout do proxy em vídeos grandes.
  const a = apiAudios(j); const aud = a.find(x => (x.extension || "") === "m4a") || a[0];
  if (!aud || !aud.url) return streamUrl(res, chosen.url, safeName(title) + ".mp4", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(title)}.mp4"`);
  res.setHeader("Content-Type", "video/mp4");
  const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error",
    "-i", chosen.url, "-i", aud.url, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]);
  p.stdout.pipe(res);
  p.stderr.on("data", () => {});
  p.on("error", () => { if (!res.headersSent) res.status(500).end("Erro ao processar o vídeo."); });
  res.on("close", () => { try { p.kill("SIGKILL"); } catch {} });
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "oficina-midia-yt", api: USE_API, host: USE_API ? RAPID_HOST : null }));

// debug: inspeciona a resposta crua da API (só quando a API está configurada)
app.get("/raw", infoLimiter, async (req, res) => {
  if (!USE_API) return res.status(404).json({ error: "API não configurada" });
  try { res.json(await apiDetails(videoId(req.query.url))); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- metadados + alturas (resoluções) disponíveis ----
app.get("/info", infoLimiter, async (req, res) => {
  const url = req.query.url;
  if (!isSupported(url)) return res.status(400).json({ error: "Link não suportado. Use YouTube, TikTok, Instagram, Facebook, Pinterest ou Medal." });
  if (USE_API && isYouTube(url)) {
    try {
      const info = infoFromApi(await apiDetails(videoId(url)));
      if (info.duration && info.duration > MAX_DURATION)
        return res.status(413).json({ error: `Vídeo muito longo (máx. ${Math.round(MAX_DURATION / 60)} min neste servidor público).` });
      return res.json(info);
    } catch (e) { /* se a API falhar, tenta o yt-dlp abaixo */ }
  }
  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true, preferFreeFormats: true, ...commonOpts(),
    });
    if (info.duration && info.duration > MAX_DURATION)
      return res.status(413).json({ error: `Vídeo muito longo (máx. ${Math.round(MAX_DURATION / 60)} min neste servidor público).` });
    const heights = [...new Set((info.formats || [])
      .filter(f => f.vcodec && f.vcodec !== "none" && f.height)
      .map(f => f.height))].sort((a, b) => b - a);
    res.json({
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      maxHeight: heights[0] || null,
      heights,
    });
  } catch (e) {
    res.status(500).json({ error: "Não consegui ler o vídeo. " + (e.stderr || e.message || "") });
  }
});

// ---- download: baixa (e junta, se houver ffmpeg) num temp e envia ----
app.get("/download", dlLimiter, async (req, res) => {
  const url = req.query.url;
  if (!isSupported(url)) return res.status(400).send("Link não suportado. Use YouTube, TikTok, Instagram, Facebook, Pinterest ou Medal.");
  const audio = req.query.audio === "1";
  const H = parseInt(req.query.height) || 0;

  if (USE_API && isYouTube(url)) {
    try { await apiDownload(res, url, audio, H, req.query.title); return; }
    catch (e) { if (res.headersSent) return; /* senão, tenta o yt-dlp abaixo */ }
  }

  // bloqueia vídeos longos demais (metadados rápidos, sem baixar)
  try {
    const dur = parseInt(String(await youtubedl(url, { print: "%(duration)s", skipDownload: true, ...commonOpts() })).trim());
    if (dur && dur > MAX_DURATION)
      return res.status(413).send(`Vídeo muito longo (máx. ${Math.round(MAX_DURATION / 60)} min neste servidor público).`);
  } catch (e) { /* se falhar aqui, o download abaixo devolve o erro real */ }

  const fmt = audio
    ? "bestaudio[ext=m4a]/bestaudio"
    : (H ? `bv*[height<=${H}]+ba/b[height<=${H}]/b` : "bv*+ba/b");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-"));
  const outTpl = path.join(tmp, "media.%(ext)s");
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  const opts = { output: outTpl, format: fmt, noPart: true, ...commonOpts() };
  if (!audio) opts.mergeOutputFormat = "mp4";

  try {
    await youtubedl(url, opts);
    const files = fs.readdirSync(tmp);
    if (!files.length) throw new Error("nada foi baixado");
    const file = path.join(tmp, files[0]);
    const ext = path.extname(file) || (audio ? ".m4a" : ".mp4");
    const dlName = safeName(req.query.title) + ext;
    res.download(file, dlName, () => cleanup());
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(500).send("Falha ao baixar: " + (e.stderr || e.message || ""));
  }
});

app.listen(PORT, () => console.log(`Backend YouTube da Oficina de Mídia em http://localhost:${PORT}`));
