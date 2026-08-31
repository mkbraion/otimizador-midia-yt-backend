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
const youtubedl = require("youtube-dl-exec");

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

function isYouTube(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(h);
  } catch { return false; }
}
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "oficina-midia-yt" }));

// ---- metadados + alturas (resoluções) disponíveis ----
app.get("/info", infoLimiter, async (req, res) => {
  const url = req.query.url;
  if (!isYouTube(url)) return res.status(400).json({ error: "URL do YouTube inválida." });
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
  if (!isYouTube(url)) return res.status(400).send("URL do YouTube inválida.");
  const audio = req.query.audio === "1";
  const H = parseInt(req.query.height) || 0;

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
