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
const archiver = require("archiver");
const ytdl = require("youtube-dl-exec");
// usa o yt-dlp mais recente instalado no container (YTDLP_PATH); local cai no bundled.
const youtubedl = (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH))
  ? ytdl.create(process.env.YTDLP_PATH) : ytdl;

const app = express();
const PORT = process.env.PORT || 8080;

// limite de duração (segundos) — bloqueia filmes/lives enormes. Ajustável por env.
const MAX_DURATION = parseInt(process.env.MAX_DURATION) || 2700; // 45 min
// teto de itens ao listar um perfil/playlist (protege a banda do servidor público)
const MAX_PLAYLIST = parseInt(process.env.MAX_PLAYLIST) || 40;

app.set("trust proxy", 1); // atrás do proxy do Railway (IP real vem no X-Forwarded-For)
app.use(cors());
app.use(express.json({ limit: "512kb" })); // pra receber o cookie do IG por POST

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

// Seleção de formato: prioriza H.264 (avc1) — toca em qualquer player, inclusive no
// Reprodutor do Windows — na MESMA resolução, sem recompressão. Só cai pra HEVC/AV1/VP9
// se não existir versão H.264. Sem corte, sem marca d'água (padrão do yt-dlp).
function pickFormat(audio, H) {
  if (audio) return "bestaudio[ext=m4a]/bestaudio";
  const hc = H ? `[height<=${H}]` : "";
  // Prioriza H.264 nas duas nomenclaturas que o yt-dlp usa: "avc1…" (YouTube/IG) e "h264" (TikTok).
  return [
    `bv*[vcodec^=avc1]${hc}+ba`, `b[vcodec^=avc1]${hc}`,
    `bv*[vcodec^=h264]${hc}+ba`, `b[vcodec^=h264]${hc}`,
    `bv*${hc}+ba`, `b${hc}`, `b`,
  ].join("/");
}

// Cookies opcionais (pra driblar o "confirme que não é um robô" em IP de nuvem
// e pra listar/baixar do Instagram, que exige login).
// Grava um cookies.txt (base64) num arquivo temp e devolve o caminho.
function cookieFile(b64, name) {
  if (!b64) return null;
  try { const p = path.join(os.tmpdir(), name); fs.writeFileSync(p, Buffer.from(b64, "base64")); return p; }
  catch { return null; }
}
// Cookie geral (YouTube etc.): env YTDLP_COOKIES_B64.
const COOKIE_PATH = cookieFile(process.env.YTDLP_COOKIES_B64, "yt-cookies.txt");
// Cookie SÓ do Instagram (use uma conta secundária/descartável): env YTDLP_IG_COOKIES_B64.
// Mantido separado pra não enviar a sua sessão do IG para os outros sites.
const IG_COOKIE_PATH = cookieFile(process.env.YTDLP_IG_COOKIES_B64, "ig-cookies.txt");

// Cookies do IG enviados pelo site (por visitante): guardados SÓ em memória,
// keyados por um token opaco (sid). Nunca vão pra URL/log. Expiram em 2h.
const crypto = require("crypto");
const IG_SESSIONS = new Map(); // sid -> { file, ts }
const IG_TTL = 2 * 60 * 60 * 1000;
function igSweep() {
  const now = Date.now();
  for (const [sid, v] of IG_SESSIONS) {
    if (now - v.ts > IG_TTL) { try { fs.rmSync(v.file, { force: true }); } catch {} IG_SESSIONS.delete(sid); }
  }
}
function igFileFor(sid) {
  if (!sid) return null;
  const v = IG_SESSIONS.get(sid);
  if (!v) return null;
  if (Date.now() - v.ts > IG_TTL) { try { fs.rmSync(v.file, { force: true }); } catch {} IG_SESSIONS.delete(sid); return null; }
  return v.file;
}

// Opções comuns: tenta clientes que às vezes passam sem login + cookies conforme o site.
function commonOpts(url, igSid) {
  const o = {
    noWarnings: true, noCheckCertificates: true, noPlaylist: true,
    extractorArgs: "youtube:player_client=default,android,web_safari,tv",
  };
  // Instagram: 1º o cookie do visitante (sid), depois o do servidor (env), senão o geral.
  if (url && isInstagram(url)) {
    const sess = igFileFor(igSid);
    if (sess) o.cookies = sess;
    else if (IG_COOKIE_PATH) o.cookies = IG_COOKIE_PATH;
    else if (COOKIE_PATH) o.cookies = COOKIE_PATH;
  } else if (COOKIE_PATH) o.cookies = COOKIE_PATH;
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "oficina-midia-yt", api: USE_API, host: USE_API ? RAPID_HOST : null, igCookie: !!IG_COOKIE_PATH, cookie: !!COOKIE_PATH, galleryDl: fs.existsSync(process.env.GALLERYDL_PATH || "/usr/local/bin/gallery-dl") }));

// ---- registra um cookie do Instagram enviado pelo site (POST, fica só em memória) ----
// Body: { cookie: "<conteúdo do cookies.txt>" }  →  devolve { sid }
app.post("/ig-cookie", infoLimiter, (req, res) => {
  igSweep();
  const raw = (req.body && req.body.cookie ? String(req.body.cookie) : "").trim();
  if (!raw) return res.status(400).json({ error: "Cookie vazio." });
  if (raw.length > 300000) return res.status(413).json({ error: "Cookie grande demais." });
  if (!/instagram/i.test(raw)) return res.status(400).json({ error: "Isso não parece um cookies.txt do Instagram (exporte estando logado no instagram.com)." });
  if (IG_SESSIONS.size > 500) { const first = IG_SESSIONS.keys().next().value; const v = IG_SESSIONS.get(first); if (v) { try { fs.rmSync(v.file, { force: true }); } catch {} } IG_SESSIONS.delete(first); }
  try {
    const sid = crypto.randomBytes(9).toString("hex");
    const file = path.join(os.tmpdir(), "ig-" + sid + ".txt");
    fs.writeFileSync(file, raw);
    IG_SESSIONS.set(sid, { file, ts: Date.now() });
    res.json({ sid, ttlMinutes: Math.round(IG_TTL / 60000) });
  } catch (e) { res.status(500).json({ error: "Não consegui salvar o cookie." }); }
});

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
      dumpSingleJson: true, preferFreeFormats: true, ...commonOpts(url, req.query.ig),
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
// ---- lista os vídeos de um PERFIL/playlist (só metadados, sem baixar) ----
// Ex.: https://www.tiktok.com/@usuario  |  https://www.instagram.com/usuario
app.get("/playlist", infoLimiter, async (req, res) => {
  const url = req.query.url;
  if (!isSupported(url)) return res.status(400).json({ error: "Link não suportado." });
  try {
    const info = await youtubedl(url, {
      ...commonOpts(url, req.query.ig), dumpSingleJson: true, flatPlaylist: true, playlistEnd: MAX_PLAYLIST, yesPlaylist: true,
    });
    const raw = Array.isArray(info.entries) ? info.entries : (info.id ? [info] : []);
    const entries = raw.map(e => {
      let u = e.webpage_url || e.url || e.original_url || "";
      // TikTok às vezes devolve só o id → reconstrói o link do vídeo
      if (u && !/^https?:/i.test(u) && (e.uploader_id || info.uploader_id))
        u = `https://www.tiktok.com/@${e.uploader_id || info.uploader_id}/video/${e.id}`;
      const th = (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length - 1].url : e.thumbnail;
      return { url: u, title: e.title || e.description || e.id || "", thumbnail: th || null, duration: e.duration || null };
    }).filter(e => /^https?:/i.test(e.url));
    if (!entries.length) return res.status(404).json({ error: "Nenhum vídeo encontrado neste perfil (pode ser privado ou exigir login)." });
    res.json({
      title: info.title || info.uploader || info.channel || "Perfil",
      uploader: info.uploader || info.channel || info.uploader_id || null,
      count: entries.length,
      truncated: raw.length >= MAX_PLAYLIST,
      max: MAX_PLAYLIST,
      entries,
    });
  } catch (e) {
    res.status(500).json({ error: "Não consegui listar o perfil. " + (e.stderr || e.message || "") });
  }
});

// ---- baixar VÁRIOS de uma vez num único .zip (uma requisição só, sem bater no limite) ----
const zipLimiter = rateLimit({ windowMs: 60 * 1000, max: 4, standardHeaders: true, legacyHeaders: false,
  message: { error: "Muitos pacotes seguidos. Espere um minuto." } });
const BATCH = new Map(); // token -> { items, ts }
const BATCH_TTL = 30 * 60 * 1000;
function batchSweep() { const now = Date.now(); for (const [k, v] of BATCH) if (now - v.ts > BATCH_TTL) BATCH.delete(k); }

// baixa 1 vídeo pra um subdir temp e devolve o caminho do arquivo
async function downloadOne(it, root) {
  const sub = fs.mkdtempSync(path.join(root, "v-"));
  const outTpl = path.join(sub, "media.%(ext)s");
  const fmt = pickFormat(it.audio, it.height);
  const opts = { output: outTpl, format: fmt, formatSort: "vcodec:h264", noPart: true, ...commonOpts(it.url, it.ig) };
  if (!it.audio) opts.mergeOutputFormat = "mp4";
  await youtubedl(it.url, opts);
  const files = fs.readdirSync(sub);
  if (!files.length) throw new Error("vazio");
  return path.join(sub, files[0]);
}

// registra a seleção e devolve um token
app.post("/batch", infoLimiter, (req, res) => {
  batchSweep();
  const b = req.body || {};
  let urls = Array.isArray(b.urls) ? b.urls : [];
  const titles = Array.isArray(b.titles) ? b.titles : [];
  const height = parseInt(b.height) || 0, audio = !!b.audio, ig = b.ig ? String(b.ig) : null;
  const items = urls
    .map((u, i) => ({ url: String(u || ""), title: titles[i] || ("video_" + (i + 1)), height, audio, ig }))
    .filter(it => isSupported(it.url))
    .slice(0, MAX_PLAYLIST);
  if (!items.length) return res.status(400).json({ error: "Nenhum link válido." });
  if (BATCH.size > 200) { const first = BATCH.keys().next().value; BATCH.delete(first); }
  const token = crypto.randomBytes(9).toString("hex");
  BATCH.set(token, { items, ts: Date.now() });
  res.json({ token, count: items.length });
});

// gera e envia o .zip (baixa cada vídeo e vai empacotando em streaming)
app.get("/zip", zipLimiter, async (req, res) => {
  const job = BATCH.get(req.query.token);
  if (!job) return res.status(404).send("Lote expirado — refaça a seleção no site.");
  const items = job.items;
  res.setHeader("Content-Disposition", 'attachment; filename="videos.zip"');
  res.setHeader("Content-Type", "application/zip");
  const archive = archiver("zip", { zlib: { level: 0 } }); // vídeos já são comprimidos → "store"
  archive.on("error", () => { try { res.destroy(); } catch {} });
  archive.pipe(res);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
  let aborted = false;
  res.on("close", () => { aborted = true; });
  for (let i = 0; i < items.length; i++) {
    if (aborted) break;
    try {
      const file = await downloadOne(items[i], root);
      const ext = path.extname(file) || (items[i].audio ? ".m4a" : ".mp4");
      archive.append(fs.createReadStream(file), { name: String(i + 1).padStart(2, "0") + "-" + safeName(items[i].title) + ext });
    } catch (e) { /* pula o item que falhar e segue */ }
  }
  try { await archive.finalize(); } catch (e) {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// ---- baixar PERFIL do Instagram (fotos + vídeos + destaques) via gallery-dl ----
const GALLERY_DL = process.env.GALLERYDL_PATH || "gallery-dl";
const IGJOBS = new Map(); // token -> { url, mode, ig, ts }
const IG_MAX_ITEMS = parseInt(process.env.IG_MAX_ITEMS) || 80;
function igUserUrl(input) {
  let u = String(input || "").trim();
  const m = u.match(/instagram\.com\/([^/?#]+)/i);
  let user = (m ? m[1] : u).replace(/^@/, "");
  if (["p", "reel", "reels", "stories", "tv", "explore"].includes(user.toLowerCase())) return null;
  if (!/^[A-Za-z0-9._]{1,60}$/.test(user)) return null;
  return "https://www.instagram.com/" + user + "/";
}
// registra o pedido (precisa do cookie do IG)
app.post("/ig-collect", infoLimiter, (req, res) => {
  batchSweep();
  const b = req.body || {};
  const url = igUserUrl(b.user || b.url);
  if (!url) return res.status(400).json({ error: "Informe o @ ou o link de um perfil do Instagram." });
  const mode = ["posts", "highlights", "all"].includes(b.mode) ? b.mode : "all";
  const ig = b.ig ? String(b.ig) : null;
  // aceita o cookie do navegador (sid) OU o cookie fixo do servidor (env YTDLP_IG_COOKIES_B64)
  if (!igFileFor(ig) && !IG_COOKIE_PATH) return res.status(400).json({ error: "Baixar um perfil exige o cookie do Instagram (conta secundária). Configure em 'Cookie do Instagram' ou no servidor." });
  const token = crypto.randomBytes(9).toString("hex");
  IGJOBS.set(token, { url, mode, ig, ts: Date.now() });
  res.json({ token, mode });
});
// baixa tudo com gallery-dl e envia um .zip
app.get("/ig-zip", zipLimiter, async (req, res) => {
  for (const [k, v] of IGJOBS) if (Date.now() - v.ts > BATCH_TTL) IGJOBS.delete(k);
  const job = IGJOBS.get(req.query.token);
  if (!job) return res.status(404).send("Pedido expirado — refaça no site.");
  const cookie = igFileFor(job.ig) || IG_COOKIE_PATH;
  if (!cookie) return res.status(400).send("Cookie do Instagram ausente ou expirado — salve o cookie de novo.");
  const include = job.mode === "highlights" ? "highlights"
    : job.mode === "posts" ? "posts,reels"
    : "posts,reels,highlights";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-"));
  const args = ["--cookies", cookie, "-q", "--no-part", "-D", dir,
    "-o", "extractor.instagram.include=" + include,
    "--range", "1-" + IG_MAX_ITEMS, job.url];
  let err = "";
  const p = spawn(GALLERY_DL, args);
  p.stderr.on("data", d => { err += d.toString(); });
  await new Promise(r => { p.on("close", r); p.on("error", () => r()); });
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const fp = path.join(d, f); const st = fs.statSync(fp); st.isDirectory() ? walk(fp) : files.push(fp); } })(dir);
  if (!files.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return res.status(502).send("Nada baixado. O Instagram pode ter bloqueado (IP de nuvem) ou o cookie expirou/é inválido. Detalhe: " + err.slice(0, 400));
  }
  res.setHeader("Content-Disposition", 'attachment; filename="instagram.zip"');
  res.setHeader("Content-Type", "application/zip");
  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", () => { try { res.destroy(); } catch {} });
  archive.pipe(res);
  for (const fp of files) archive.append(fs.createReadStream(fp), { name: path.relative(dir, fp).replace(/\\/g, "/") });
  try { await archive.finalize(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

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
    const dur = parseInt(String(await youtubedl(url, { print: "%(duration)s", skipDownload: true, ...commonOpts(url, req.query.ig) })).trim());
    if (dur && dur > MAX_DURATION)
      return res.status(413).send(`Vídeo muito longo (máx. ${Math.round(MAX_DURATION / 60)} min neste servidor público).`);
  } catch (e) { /* se falhar aqui, o download abaixo devolve o erro real */ }

  const fmt = audio
    ? "bestaudio[ext=m4a]/bestaudio"
    : pickFormat(false, H);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-"));
  const outTpl = path.join(tmp, "media.%(ext)s");
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  const opts = { output: outTpl, format: fmt, formatSort: "vcodec:h264", noPart: true, ...commonOpts(url, req.query.ig) };
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
