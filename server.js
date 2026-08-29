// Backend de download do YouTube para a Oficina de Mídia.
// Usa yt-dlp (via youtube-dl-exec). Roda em qualquer lugar com Node 18+.
//   npm install && npm start
// Para baixar em HD (1080p/720p) o yt-dlp precisa do ffmpeg instalado no servidor,
// pra juntar as faixas de vídeo e áudio. Sem ffmpeg, ele cai para a melhor
// qualidade "progressiva" (arquivo único, normalmente 360p, às vezes 720p).
// Deploy fácil: Railway/Render (dão HTTPS de graça, necessário pro site na Vercel).

const express = require("express");
const cors = require("cors");
const os = require("os");
const path = require("path");
const fs = require("fs");
const youtubedl = require("youtube-dl-exec");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());

function isYouTube(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(h);
  } catch { return false; }
}
function safeName(s) {
  return (s || "video").replace(/[^\w\-. ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "oficina-midia-yt" }));

// ---- metadados + alturas (resoluções) disponíveis ----
app.get("/info", async (req, res) => {
  const url = req.query.url;
  if (!isYouTube(url)) return res.status(400).json({ error: "URL do YouTube inválida." });
  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
      noPlaylist: true, preferFreeFormats: true,
    });
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
app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!isYouTube(url)) return res.status(400).send("URL do YouTube inválida.");
  const audio = req.query.audio === "1";
  const H = parseInt(req.query.height) || 0;

  const fmt = audio
    ? "bestaudio[ext=m4a]/bestaudio"
    : (H ? `bv*[height<=${H}]+ba/b[height<=${H}]/b` : "bv*+ba/b");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-"));
  const outTpl = path.join(tmp, "media.%(ext)s");
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  const opts = {
    output: outTpl, format: fmt, noPlaylist: true,
    noWarnings: true, noCheckCertificates: true, noPart: true,
  };
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
