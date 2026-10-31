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

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 14px;line-height:1.35}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .card{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
    input,textarea,select,button{font:inherit}
    input[type="text"],input[type="password"],textarea{width:100%;max-width:640px;padding:8px}
    small{color:#666}
    .ok{color:#0a7}
    .warn{color:#b60}
    .err{color:#b00}
    .tag{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #ddd;background:#fafafa}
    a{color:#06c}
    button{padding:8px 12px}
  </style>
</head>
<body>
  <h1>MHRP - TikTok Uploader (demo)</h1>
  ${bodyHtml}
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
  const statusTag = `<span class="tag">${escapeHtml(status)}</span>`;
  const publish = item.publishId ? `<div><small>publish_id: ${escapeHtml(item.publishId)}</small></div>` : '';
  const error = item.lastError ? `<div class="err"><small>${escapeHtml(item.lastError)}</small></div>` : '';

  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div>
        <div><strong>${fileName}</strong> ${statusTag}</div>
        ${caption ? `<div><small>${caption}</small></div>` : ''}
        ${publish}
        ${error}
      </div>
      <div class="row">
        <form method="post" action="/admin/item/${encodeURIComponent(item.id)}/approve">
          <button type="submit">Aprobar y subir</button>
        </form>
        <form method="post" action="/admin/item/${encodeURIComponent(item.id)}/reject">
          <button type="submit">Rechazar</button>
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
  const msg = req.query.msg ? `<p class="ok">${escapeHtml(req.query.msg)}</p>` : '';
  const err = req.query.err ? `<p class="err">${escapeHtml(req.query.err)}</p>` : '';
  const body = `
  <div class="card">
    <h2>Enviar video (usuario)</h2>
    <p>Sube un video a la web. Quedará pendiente hasta que un admin lo apruebe.</p>
    ${msg}${err}
    <form action="/submit" method="post" enctype="multipart/form-data">
      <label>Caption (se revisa en admin; en TikTok se puede editar al publicar):</label><br/>
      <input type="text" name="caption" maxlength="2200" /><br/><br/>
      <label>Archivo de video:</label><br/>
      <input type="file" name="videoFile" accept="video/*" required /><br/><br/>
      <button type="submit">Enviar</button>
    </form>
  </div>
  <div class="card">
    <h2>Panel admin</h2>
    <a href="/admin">Ir al panel</a>
  </div>`;
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
  const err = req.query.err ? `<p class="err">${escapeHtml(req.query.err)}</p>` : '';
  const body = `
  <div class="card">
    <h2>Login admin</h2>
    ${err}
    <form method="post" action="/admin/login">
      <label>Password:</label><br/>
      <input type="password" name="password" required /><br/><br/>
      <button type="submit">Entrar</button>
    </form>
  </div>`;
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
  const msg = req.query.msg ? `<p class="ok">${escapeHtml(req.query.msg)}</p>` : '';
  const err = req.query.err ? `<p class="err">${escapeHtml(req.query.err)}</p>` : '';
  const missing = missingEnv();
  const auth = getStoredTikTokAuth();

  let authBlock = '';
  if (missing.length) {
    authBlock = `<p class="err">Faltan variables: ${escapeHtml(missing.join(', '))}</p>`;
  } else if (!auth?.access_token) {
    authBlock = `<p class="warn">TikTok no está conectado.</p>
      <p><a href="/admin/connect">Conectar TikTok (admin)</a></p>`;
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
    authBlock = `<p class="ok">TikTok conectado como: <strong>${name}</strong></p>
      <p><a href="/admin/connect">Reconectar</a></p>`;
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
            const cover = v.cover_image_url ? `<img src="${escapeHtml(v.cover_image_url)}" style="width:90px;height:auto;border-radius:8px;border:1px solid #ddd" />` : '';
            return `<div class="row" style="align-items:center;gap:12px;margin:8px 0">
              ${cover}
              <div><div><strong>${title}</strong></div><small>${id}</small></div>
            </div>`;
          })
          .join('');
        videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3>${rows}</div>`;
      } else {
        videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3><p><small>No hay videos públicos o no hay acceso.</small></p></div>`;
      }
    }
  } catch (e) {
    videosHtml = `<div class="card"><h3>Últimos videos públicos (video.list)</h3><p class="warn"><small>No se pudo listar: ${escapeHtml(e?.message || 'error')}</small></p></div>`;
  }

  const body = `
  <div class="card">
    <h2>Estado</h2>
    ${msg}${err}
    ${authBlock}
    <form method="post" action="/admin/logout"><button type="submit">Cerrar sesión admin</button></form>
  </div>
  <div class="card">
    <h2>Cola pendiente</h2>
    <p><small>Solo se muestran PENDING y FAILED. Al aprobar, se sube a TikTok (inbox/draft) para revisión final y publicación desde TikTok.</small></p>
  </div>
  ${queueHtml}
  ${videosHtml}
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
