const crypto = require('crypto');
const dotenv = require('dotenv');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const { readJson, writeJson } = require('./services/storage');
const {
  buildAuthorizeUrl,
  createState,
  exchangeCodeForToken,
  fetchUserInfo,
  getStoredTikTokAuth,
  getValidAccessToken,
  normalizeTokenResponse,
  setStoredTikTokAuth,
} = require('./services/tiktokAuth');
const { uploadVideoToInbox } = require('./services/tiktokPosting');
const { listVideos } = require('./services/tiktokDisplay');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3001);

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ dest: UPLOADS_DIR });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('trust proxy', 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure:
        SESSION_COOKIE_SECURE === 'true'
          ? true
          : SESSION_COOKIE_SECURE === 'false'
            ? false
            : process.env.NODE_ENV === 'production' && String(BASE_URL).startsWith('https://'),
    },
  })
);

const QUEUE_FILE = 'queue.json';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusClass(status) {
  switch (status) {
    case 'PENDING':
      return 'status-pending';
    case 'FAILED':
      return 'status-failed';
    case 'SENT_TO_INBOX':
      return 'status-success';
    case 'UPLOADING':
      return 'status-uploading';
    case 'REJECTED':
      return 'status-muted';
    default:
      return 'status-muted';
  }
}

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root{
      --bg:#222222;
      --panel:#030712;
      --panel-soft:rgba(3,7,18,.92);
      --panel-border:#db2777;
      --panel-border-soft:#52525b;
      --text:#ffffff;
      --muted:#d1d5db;
      --muted-2:#9ca3af;
      --pink:#db2777;
      --pink-hover:#9d174d;
      --green:#10b981;
      --amber:#f59e0b;
      --red:#ef4444;
      --blue:#60a5fa;
      --radius:18px;
      --shadow:0 18px 40px rgba(0,0,0,.28);
    }
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{
      margin:0;
      font-family:Arial,sans-serif;
      line-height:1.45;
      color:var(--text);
      background:#222 url("https://mh-rp.net/images/background.jpg") no-repeat fixed center;
      background-size:cover;
      background-blend-mode:overlay;
    }
    a{color:inherit;text-decoration:none}
    small{color:var(--muted-2)}
    .site-shell{min-height:100vh;display:flex;flex-direction:column}
    .topbar{
      position:sticky;
      top:0;
      z-index:50;
      background:rgba(3,7,18,.96);
      backdrop-filter:blur(8px);
      border-bottom:1px solid rgba(255,255,255,.06);
    }
    .topbar-inner,.content,.footer-inner{
      width:min(1120px,calc(100% - 32px));
      margin:0 auto;
    }
    .topbar-inner{
      min-height:74px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:16px;
    }
    .brand{
      display:flex;
      align-items:center;
      gap:12px;
      font-weight:800;
      letter-spacing:.04em;
    }
    .brand img{
      width:42px;
      height:42px;
      object-fit:contain;
      display:block;
    }
    .nav-links{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      align-items:center;
      justify-content:flex-end;
    }
    .nav-link{
      padding:10px 14px;
      border-radius:12px;
      color:var(--muted);
      transition:.2s ease;
      font-weight:700;
      font-size:14px;
    }
    .nav-link:hover{background:rgba(219,39,119,.18);color:#fff}
    .nav-link.is-active{
      color:#fff;
      box-shadow:inset 0 -2px 0 var(--pink);
    }
    .content{
      flex:1;
      padding:36px 0 56px;
    }
    .hero{
      background:var(--panel-soft);
      border:8px solid var(--panel-border);
      border-radius:var(--radius);
      padding:28px;
      box-shadow:var(--shadow);
      margin-bottom:24px;
      text-align:center;
    }
    .hero h1,.hero h2,.section-head h2,.card h2,.card h3{margin:0 0 12px}
    .hero p{
      margin:0 auto;
      max-width:760px;
      color:var(--muted);
    }
    .section-head{
      margin:0 0 14px;
    }
    .section-head p{margin:0;color:var(--muted)}
    .layout-grid{
      display:grid;
      grid-template-columns:1.2fr .8fr;
      gap:22px;
      align-items:start;
    }
    .stack{display:grid;gap:20px}
    .card{
      background:var(--panel-soft);
      border:1px solid rgba(255,255,255,.08);
      border-radius:var(--radius);
      padding:22px;
      box-shadow:var(--shadow);
    }
    .card.featured{
      border:3px solid var(--panel-border);
    }
    .card p:last-child{margin-bottom:0}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .meta-grid{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:14px;
      margin-top:18px;
    }
    .meta-item{
      background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);
      border-radius:14px;
      padding:14px;
    }
    .meta-item strong{display:block;font-size:20px;margin-bottom:4px}
    .flow-list{
      list-style:none;
      padding:0;
      margin:0;
      display:grid;
      gap:12px;
    }
    .flow-list li{
      display:flex;
      gap:14px;
      align-items:flex-start;
      padding:12px 14px;
      border-radius:14px;
      background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);
    }
    .flow-step{
      width:28px;
      height:28px;
      flex:0 0 28px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border-radius:999px;
      background:var(--pink);
      font-weight:800;
      font-size:13px;
    }
    form{margin:0}
    input,textarea,select,button{font:inherit}
    label{
      display:block;
      font-weight:700;
      margin-bottom:8px;
    }
    input[type="text"],input[type="password"],textarea{
      width:100%;
      padding:13px 14px;
      color:#fff;
      background:#111827;
      border:1px solid rgba(255,255,255,.12);
      border-radius:14px;
      outline:none;
    }
    input[type="file"]{
      width:100%;
      padding:12px;
      color:#fff;
      background:#111827;
      border:1px dashed rgba(255,255,255,.24);
      border-radius:14px;
    }
    input:focus,textarea:focus,select:focus{
      border-color:var(--pink);
      box-shadow:0 0 0 3px rgba(219,39,119,.18);
    }
    textarea{min-height:120px;resize:vertical}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    button,.btn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:44px;
      padding:10px 18px;
      border:none;
      border-radius:999px;
      background:var(--pink);
      color:#fff;
      font-weight:800;
      cursor:pointer;
      transition:.2s ease;
      text-decoration:none;
    }
    button:hover,.btn:hover{background:var(--pink-hover);transform:translateY(-1px)}
    .btn-secondary{
      background:transparent;
      border:1px solid rgba(255,255,255,.16);
      color:#fff;
    }
    .btn-secondary:hover{background:rgba(255,255,255,.06)}
    .btn-danger{background:#7f1d1d}
    .btn-danger:hover{background:#991b1b}
    .message{
      padding:14px 16px;
      border-radius:14px;
      margin:0 0 16px;
      border:1px solid transparent;
    }
    .message.ok{background:rgba(16,185,129,.14);border-color:rgba(16,185,129,.35);color:#bbf7d0}
    .message.warn{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.28);color:#fde68a}
    .message.err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.28);color:#fecaca}
    .tag{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:7px 12px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.04);
      font-size:13px;
      font-weight:800;
    }
    .status-pending{color:#fde68a;border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.14)}
    .status-failed{color:#fecaca;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.12)}
    .status-success{color:#bbf7d0;border-color:rgba(16,185,129,.32);background:rgba(16,185,129,.14)}
    .status-uploading{color:#bfdbfe;border-color:rgba(96,165,250,.32);background:rgba(96,165,250,.14)}
    .status-muted{color:#e5e7eb}
    .queue-card{
      border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.03);
      border-radius:16px;
      padding:16px;
    }
    .queue-card + .queue-card{margin-top:12px}
    .queue-top{
      display:flex;
      justify-content:space-between;
      gap:18px;
      align-items:flex-start;
    }
    .queue-title{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      align-items:center;
      margin-bottom:6px;
    }
    .inline-list{
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:14px;
    }
    .video-list{
      display:grid;
      gap:12px;
    }
    .video-item{
      display:flex;
      gap:14px;
      align-items:center;
      padding:12px;
      border-radius:14px;
      background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);
    }
    .video-item img{
      width:96px;
      height:54px;
      object-fit:cover;
      border-radius:12px;
      border:1px solid rgba(255,255,255,.12);
      background:#111827;
    }
    .footer{
      background:#030712;
      margin-top:auto;
      border-top:1px solid rgba(255,255,255,.06);
    }
    .footer-inner{
      padding:28px 0 34px;
      text-align:center;
      color:var(--muted);
    }
    .footer-links{
      display:flex;
      flex-wrap:wrap;
      justify-content:center;
      gap:18px;
      margin:0 0 16px;
      padding:0;
      list-style:none;
    }
    .footer-links a{font-weight:700}
    .footer-links a:hover{color:#fff}
    @media (max-width: 860px){
      .layout-grid{grid-template-columns:1fr}
      .meta-grid{grid-template-columns:1fr}
      .topbar-inner{padding:10px 0;align-items:flex-start;flex-direction:column}
      .nav-links{justify-content:flex-start}
      .content{padding-top:26px}
      .hero{padding:22px}
      .queue-top{flex-direction:column}
    }
  </style>
</head>
<body>
  <div class="site-shell">
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/">
          <img src="https://mh-rp.net/images/logo.png" alt="MHRP" />
          <span>MHRP</span>
        </a>
        <nav class="nav-links">
          <a class="nav-link" href="https://mh-rp.net/">INICIO</a>
          <a class="nav-link is-active" href="/">TIKTOK UPLOADER</a>
          <a class="nav-link" href="/admin">PANEL ADMIN</a>
        </nav>
      </div>
    </header>
    <main class="content">
      ${bodyHtml}
    </main>
    <footer class="footer">
      <div class="footer-inner">
        <ul class="footer-links">
          <li><a href="https://mh-rp.net/legal">Aviso legal</a></li>
          <li><a href="https://mh-rp.net/privacidad">Política de privacidad</a></li>
          <li><a href="https://mh-rp.net/cookies">Política de cookies</a></li>
          <li><a href="mailto:soporte@mh-rp.net">Contacto</a></li>
        </ul>
        <div><small>Demo de integración TikTok para revisión de MHRP.</small></div>
      </div>
    </footer>
  </div>
</body>
</html>`;
}

function getQueue() {
  const queue = readJson(QUEUE_FILE, []);
  return Array.isArray(queue) ? queue : [];
}

function setQueue(queue) {
  writeJson(QUEUE_FILE, queue);
}

function getQueueItem(id) {
  return getQueue().find((x) => x.id === id) || null;
}

function updateQueueItem(id, patch) {
  const queue = getQueue();
  const idx = queue.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  queue[idx] = { ...queue[idx], ...patch, updatedAtMs: Date.now() };
  setQueue(queue);
  return queue[idx];
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.redirect('/admin/login');
}

function formatQueueRow(item) {
  const status = item.status || 'PENDING';
  const caption = item.caption ? escapeHtml(item.caption) : '';
  const fileName = escapeHtml(item.originalName || path.basename(item.filePath || ''));
  const statusTag = `<span class="tag ${statusClass(status)}">${escapeHtml(status)}</span>`;
  const publish = item.publishId ? `<div><small>publish_id: ${escapeHtml(item.publishId)}</small></div>` : '';
  const error = item.lastError ? `<div class="err"><small>${escapeHtml(item.lastError)}</small></div>` : '';

  return `<div class="queue-card">
    <div class="queue-top">
      <div>
        <div class="queue-title"><strong>${fileName}</strong> ${statusTag}</div>
        ${caption ? `<div><small>${caption}</small></div>` : ''}
        ${publish}
        ${error}
      </div>
      <div class="actions">
        <form method="post" action="/admin/item/${encodeURIComponent(item.id)}/approve">
          <button type="submit">Aprobar y subir</button>
        </form>
        <form method="post" action="/admin/item/${encodeURIComponent(item.id)}/reject">
          <button type="submit" class="btn-danger">Rechazar</button>
        </form>
      </div>
    </div>
  </div>`;
}

function missingEnv() {
  const missing = [];
  if (!TIKTOK_CLIENT_KEY) missing.push('TIKTOK_CLIENT_KEY');
  if (!TIKTOK_CLIENT_SECRET) missing.push('TIKTOK_CLIENT_SECRET');
  if (!TIKTOK_REDIRECT_URI) missing.push('TIKTOK_REDIRECT_URI');
  if (!ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');
  return missing;
}

app.get('/', (req, res) => {
  const msg = req.query.msg ? `<div class="message ok">${escapeHtml(req.query.msg)}</div>` : '';
  const err = req.query.err ? `<div class="message err">${escapeHtml(req.query.err)}</div>` : '';
  const body = `
  <section class="hero">
    <h1>Centro de aportes TikTok para MHRP</h1>
    <p>Los jugadores envían clips desde esta sección. El equipo de MHRP los revisa desde el panel de administración y solo los aprobados se mandan a TikTok como borrador para su publicación final.</p>
    <div class="meta-grid">
      <div class="meta-item"><strong>1</strong><small>Usuario sube el video</small></div>
      <div class="meta-item"><strong>2</strong><small>Moderación interna MHRP</small></div>
      <div class="meta-item"><strong>3</strong><small>Envío a TikTok inbox/draft</small></div>
    </div>
  </section>
  <section class="layout-grid">
    <div class="stack">
      <div class="card featured">
        <div class="section-head">
          <h2>Enviar video</h2>
          <p>Tu clip quedará pendiente de revisión hasta que lo apruebe un administrador.</p>
        </div>
        ${msg}${err}
        <form action="/submit" method="post" enctype="multipart/form-data">
          <label>Caption</label>
          <input type="text" name="caption" maxlength="2200" placeholder="Describe el clip o añade contexto" />
          <div style="height:16px"></div>
          <label>Archivo de video</label>
          <input type="file" name="videoFile" accept="video/*" required />
          <div class="actions">
            <button type="submit">Enviar para revisión</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Cómo funciona</h2>
          <p>Este bloque queda muy bien en el vídeo de revisión porque enseña el flujo completo dentro de la propia web.</p>
        </div>
        <ol class="flow-list">
          <li><span class="flow-step">1</span><div><strong>Usuario</strong><br/><small>Sube el vídeo desde la web de MHRP.</small></div></li>
          <li><span class="flow-step">2</span><div><strong>Panel admin</strong><br/><small>El contenido entra en cola y espera revisión.</small></div></li>
          <li><span class="flow-step">3</span><div><strong>Aprobación</strong><br/><small>El admin decide si se rechaza o se manda a TikTok.</small></div></li>
          <li><span class="flow-step">4</span><div><strong>TikTok</strong><br/><small>Se sube como inbox/draft para revisión final de la cuenta MHRP.</small></div></li>
        </ol>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="section-head">
          <h2>Acceso admin</h2>
          <p>Desde aquí se aprueban los vídeos y se conecta la cuenta de TikTok.</p>
        </div>
        <div class="actions">
          <a class="btn" href="/admin">Ir al panel admin</a>
          <a class="btn btn-secondary" href="https://mh-rp.net/" target="_blank" rel="noopener noreferrer">Volver a MHRP</a>
        </div>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Checklist para TikTok</h2>
        </div>
        <div class="flow-list">
          <li><span class="flow-step">A</span><div><strong>Login Kit</strong><br/><small>Solo el admin conecta la cuenta oficial de MHRP.</small></div></li>
          <li><span class="flow-step">B</span><div><strong>Content Posting API</strong><br/><small>Solo los vídeos aprobados llegan a TikTok.</small></div></li>
          <li><span class="flow-step">C</span><div><strong>video.list</strong><br/><small>Se pueden enseñar los últimos vídeos públicos de la cuenta.</small></div></li>
        </div>
      </div>
    </div>
  </section>
  </div>
  `;
  res.send(page('MHRP TikTok Uploader', body));
});

app.post('/submit', upload.single('videoFile'), (req, res) => {
  if (!req.file) {
    res.redirect('/?err=' + encodeURIComponent('Debes adjuntar un archivo.'));
    return;
  }

  const id = crypto.randomUUID();
  const caption = String(req.body.caption || '').trim();

  const item = {
    id,
    caption,
    originalName: req.file.originalname,
    filePath: req.file.path,
    status: 'PENDING',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };

  const queue = getQueue();
  queue.unshift(item);
  setQueue(queue);

  res.redirect('/?msg=' + encodeURIComponent('Enviado. Queda pendiente de revisión.'));
});

app.get('/admin/login', (req, res) => {
  const err = req.query.err ? `<div class="message err">${escapeHtml(req.query.err)}</div>` : '';
  const body = `
  <section class="hero">
    <h1>Panel de moderación MHRP</h1>
    <p>Accede con la contraseña de administración para revisar la cola, conectar TikTok y aprobar el contenido enviado por los usuarios.</p>
  </section>
  <section class="layout-grid" style="grid-template-columns:.95fr 1.05fr">
    <div class="card featured">
      <h2>Login admin</h2>
      ${err}
      <form method="post" action="/admin/login">
        <label>Password</label>
        <input type="password" name="password" required placeholder="Introduce la contraseña del panel" />
        <div class="actions">
          <button type="submit">Entrar al panel</button>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Qué puedes mostrar en la demo</h2>
      <ol class="flow-list">
        <li><span class="flow-step">1</span><div><strong>Subida desde la web</strong><br/><small>Un usuario manda un vídeo y queda pendiente.</small></div></li>
        <li><span class="flow-step">2</span><div><strong>Moderación</strong><br/><small>El admin revisa la cola desde este panel.</small></div></li>
        <li><span class="flow-step">3</span><div><strong>Conexión TikTok</strong><br/><small>La cuenta oficial MHRP se conecta vía Login Kit.</small></div></li>
        <li><span class="flow-step">4</span><div><strong>Envío</strong><br/><small>El vídeo aprobado se manda a inbox/draft.</small></div></li>
      </ol>
    </div>
  </section>`;
  res.send(page('Admin login', body));
});

app.post('/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    res.redirect('/admin/login?err=' + encodeURIComponent('Password incorrecta.'));
    return;
  }
  req.session.isAdmin = true;
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/admin/connect', requireAdmin, (req, res) => {
  const missing = missingEnv();
  if (missing.length) {
    res.send(
      page(
        'Config faltante',
        `<div class="card"><p class="err">Faltan variables: ${escapeHtml(missing.join(', '))}</p></div>`
      )
    );
    return;
  }

  const state = createState();
  req.session.tiktokState = state;
  const authorizeUrl = buildAuthorizeUrl({
    clientKey: TIKTOK_CLIENT_KEY,
    redirectUri: TIKTOK_REDIRECT_URI,
    scopes: ['user.info.basic', 'video.upload', 'video.list'],
    state,
  });
  res.redirect(authorizeUrl);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');

  if (!req.session?.tiktokState || state !== req.session.tiktokState) {
    res.redirect('/admin?err=' + encodeURIComponent('State inválido.'));
    return;
  }

  if (!code) {
    res.redirect('/admin?err=' + encodeURIComponent('Falta code en callback.'));
    return;
  }

  try {
    const tokenRes = await exchangeCodeForToken({
      clientKey: TIKTOK_CLIENT_KEY,
      clientSecret: TIKTOK_CLIENT_SECRET,
      code,
      redirectUri: TIKTOK_REDIRECT_URI,
    });
    const normalized = normalizeTokenResponse(tokenRes);
    setStoredTikTokAuth(normalized);
    res.redirect('/admin?msg=' + encodeURIComponent('Cuenta TikTok conectada.'));
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    res.redirect('/admin?err=' + encodeURIComponent('Error OAuth: ' + JSON.stringify(details)));
  }
});

app.get('/admin', requireAdmin, async (req, res) => {
  const msg = req.query.msg ? `<div class="message ok">${escapeHtml(req.query.msg)}</div>` : '';
  const err = req.query.err ? `<div class="message err">${escapeHtml(req.query.err)}</div>` : '';
  const missing = missingEnv();
  const auth = getStoredTikTokAuth();

  let authBlock = '';
  if (missing.length) {
    authBlock = `<div class="message err">Faltan variables: ${escapeHtml(missing.join(', '))}</div>`;
  } else if (!auth?.access_token) {
    authBlock = `<div class="message warn">TikTok no está conectado todavía.</div>
      <div class="actions"><a class="btn" href="/admin/connect">Conectar TikTok (admin)</a></div>`;
  } else {
    let whoami = null;
    try {
      const token = await getValidAccessToken({
        clientKey: TIKTOK_CLIENT_KEY,
        clientSecret: TIKTOK_CLIENT_SECRET,
      });
      if (token.ok) {
        const info = await fetchUserInfo({ accessToken: token.accessToken });
        whoami = info?.data?.user || null;
      }
    } catch {
      whoami = null;
    }
    const name = whoami?.display_name ? escapeHtml(whoami.display_name) : escapeHtml(auth.open_id || 'desconocido');
    authBlock = `<div class="message ok">TikTok conectado como: <strong>${name}</strong></div>
      <div class="actions"><a class="btn btn-secondary" href="/admin/connect">Reconectar</a></div>`;
  }

  const queue = getQueue();
  const pending = queue.filter((x) => x.status === 'PENDING' || x.status === 'FAILED');
  const queueHtml = pending.length
    ? pending.map(formatQueueRow).join('')
    : `<div class="card"><p>No hay pendientes.</p></div>`;

  let videosHtml = '';
  try {
    const token = await getValidAccessToken({
      clientKey: TIKTOK_CLIENT_KEY,
      clientSecret: TIKTOK_CLIENT_SECRET,
    });
    if (token.ok) {
      const list = await listVideos({ accessToken: token.accessToken, maxCount: 5 });
      const videos = list?.data?.videos || [];
      if (Array.isArray(videos) && videos.length) {
        const rows = videos
          .map((v) => {
            const title = escapeHtml(v.title || '(sin título)');
            const id = escapeHtml(v.id || '');
            const cover = v.cover_image_url ? `<img src="${escapeHtml(v.cover_image_url)}" alt="${title}" />` : '';
            return `<div class="video-item">
              ${cover}
              <div><div><strong>${title}</strong></div><small>${id}</small></div>
            </div>`;
          })
          .join('');
        videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3><div class="video-list">${rows}</div></div>`;
      } else {
        videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3><p><small>No hay videos públicos o no hay acceso.</small></p></div>`;
      }
    }
  } catch (e) {
    videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3><p class="warn"><small>No se pudo listar: ${escapeHtml(e?.message || 'error')}</small></p></div>`;
  }

  const body = `
  <section class="hero">
    <h1>Backoffice TikTok MHRP</h1>
    <p>Desde aquí el equipo revisa los clips recibidos, conecta la cuenta oficial de TikTok y aprueba los vídeos que se enviarán a inbox/draft.</p>
  </section>
  <section class="layout-grid">
    <div class="stack">
      <div class="card featured">
        <h2>Estado de la integración</h2>
        ${msg}${err}
        ${authBlock}
        <div class="actions">
          <form method="post" action="/admin/logout"><button type="submit" class="btn-secondary">Cerrar sesión admin</button></form>
        </div>
      </div>
      <div class="card">
        <h2>Cola pendiente</h2>
        <p><small>Se muestran los vídeos pendientes o fallidos. Al aprobar, el archivo se sube a TikTok para revisión final y publicación desde la cuenta MHRP.</small></p>
        <div class="inline-list">
          <span class="tag ${statusClass('PENDING')}">PENDING</span>
          <span class="tag ${statusClass('UPLOADING')}">UPLOADING</span>
          <span class="tag ${statusClass('SENT_TO_INBOX')}">SENT_TO_INBOX</span>
          <span class="tag ${statusClass('FAILED')}">FAILED</span>
        </div>
      </div>
      <div class="card">
        ${queueHtml}
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <h2>Flujo revisado por TikTok</h2>
        <ol class="flow-list">
          <li><span class="flow-step">1</span><div><strong>Usuario envía clip</strong><br/><small>El vídeo entra en cola y se guarda en el servidor.</small></div></li>
          <li><span class="flow-step">2</span><div><strong>Admin revisa</strong><br/><small>Se decide si se rechaza o se aprueba.</small></div></li>
          <li><span class="flow-step">3</span><div><strong>Subida a TikTok</strong><br/><small>Solo el contenido aprobado se manda a inbox/draft.</small></div></li>
          <li><span class="flow-step">4</span><div><strong>Cuenta MHRP</strong><br/><small>La publicación final se hace desde la propia cuenta.</small></div></li>
        </ol>
      </div>
      ${videosHtml}
    </div>
  </section>
  `;

  res.send(page('Admin', body));
});

app.post('/admin/item/:id/reject', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  const item = getQueueItem(id);
  if (!item) {
    res.redirect('/admin?err=' + encodeURIComponent('Item no encontrado.'));
    return;
  }
  updateQueueItem(id, { status: 'REJECTED', lastError: null });
  res.redirect('/admin?msg=' + encodeURIComponent('Rechazado.'));
});

app.post('/admin/item/:id/approve', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const item = getQueueItem(id);
  if (!item) {
    res.redirect('/admin?err=' + encodeURIComponent('Item no encontrado.'));
    return;
  }

  const missing = missingEnv();
  if (missing.length) {
    res.redirect('/admin?err=' + encodeURIComponent('Faltan variables: ' + missing.join(', ')));
    return;
  }

  if (!item.filePath || !fs.existsSync(item.filePath)) {
    updateQueueItem(id, { status: 'FAILED', lastError: 'Archivo no existe en servidor.' });
    res.redirect('/admin?err=' + encodeURIComponent('Archivo no existe.'));
    return;
  }

  updateQueueItem(id, { status: 'UPLOADING', lastError: null, publishId: null });

  try {
    const token = await getValidAccessToken({
      clientKey: TIKTOK_CLIENT_KEY,
      clientSecret: TIKTOK_CLIENT_SECRET,
    });
    if (!token.ok) {
      updateQueueItem(id, { status: 'FAILED', lastError: `TikTok token inválido: ${token.reason}` });
      res.redirect('/admin?err=' + encodeURIComponent('TikTok no conectado.'));
      return;
    }

    const result = await uploadVideoToInbox({
      accessToken: token.accessToken,
      filePath: item.filePath,
      pollMax: 20,
    });

    updateQueueItem(id, {
      status: 'SENT_TO_INBOX',
      publishId: result?.publishId || null,
      lastError: null,
      lastTikTokStatus: result?.status || null,
    });

    res.redirect('/admin?msg=' + encodeURIComponent('Subido a TikTok inbox/draft. Revisa la app de TikTok.'));
  } catch (error) {
    const details = error?.details || error?.response?.data || error?.message || String(error);
    updateQueueItem(id, { status: 'FAILED', lastError: JSON.stringify(details).slice(0, 2000) });
    res.redirect('/admin?err=' + encodeURIComponent('Error subiendo: ' + (error?.message || 'error')));
  }
});

app.listen(PORT, () => {
  console.log(`Server: ${BASE_URL}`);
  console.log(`Local: http://localhost:${PORT}`);
});
