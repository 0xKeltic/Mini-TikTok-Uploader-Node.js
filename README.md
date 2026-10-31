# Mini TikTok Uploader (MHRP) - Demo

App Node.js/Express para un flujo moderado por admin:

- Usuarios suben un video a la web → queda `PENDING`.
- Un admin aprueba desde `/admin` → el servidor sube el archivo a TikTok usando **Content Posting API (video.upload)** como **inbox/draft**.
- Opcional: se muestran los últimos videos públicos del perfil (scope `video.list`).

## Requisitos

- TikTok Developer App con productos: **Login Kit** + **Content Posting API**
- Scopes solicitados: `user.info.basic`, `video.upload`, `video.list`
- Redirect URI (HTTPS) registrado en Login Kit, por ejemplo:
  - `https://mh-rp.net/auth/tiktok/callback`

## Configuración

1. Copia `.env.example` a `.env` y rellena:
   - `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
   - `TIKTOK_REDIRECT_URI` (exacto al registrado en TikTok)
   - `ADMIN_PASSWORD`, `SESSION_SECRET`
   - `BASE_URL` (si estás detrás de HTTPS/proxy, pon el dominio)

2. Instala y arranca:

```bash
npm install
npm start
```

## Uso (para grabar el demo de App Review)

1. Abre la web y sube un video como usuario:
   - `GET /` → formulario → `POST /submit`

2. Entra como admin:
   - `GET /admin` → login con `ADMIN_PASSWORD`

3. Conecta TikTok (solo admin):
   - `GET /admin/connect`

4. Aprueba el video:
   - En la cola `PENDING`, pulsa **Aprobar y subir**
   - Resultado esperado: `SENT_TO_INBOX` y mensaje “Subido a TikTok inbox/draft”.

5. (Opcional) Muestra “Últimos videos públicos”:
   - Se carga en `/admin` desde `video.list` si hay token válido.

## Notas

- Los tokens y la cola se guardan en `storage/` (se crea en runtime) y no se suben a Git.
- `video.list` solo devuelve videos **públicos**. Un video en draft/inbox no aparece hasta que se publique.

