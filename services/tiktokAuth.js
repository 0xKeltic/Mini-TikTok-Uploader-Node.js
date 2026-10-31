const axios = require('axios');
const crypto = require('crypto');
const { readJson, writeJson } = require('./storage');

const TIKTOK_TOKEN_FILE = 'tiktok.json';
const OAUTH_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const OAUTH_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

function getStoredTikTokAuth() {
  return readJson(TIKTOK_TOKEN_FILE, null);
}

function setStoredTikTokAuth(value) {
  writeJson(TIKTOK_TOKEN_FILE, value);
}

function buildAuthorizeUrl({ clientKey, redirectUri, scopes, state }) {
  const qs = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: scopes.join(','),
    redirect_uri: redirectUri,
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${qs.toString()}`;
}

function createState() {
  return crypto.randomBytes(16).toString('hex');
}

async function exchangeCodeForToken({ clientKey, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code: decodeURIComponent(code),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await axios.post(OAUTH_TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });

  return response.data;
}

async function refreshAccessToken({ clientKey, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await axios.post(OAUTH_TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });

  return response.data;
}

function normalizeTokenResponse(tokenResponse) {
  const nowMs = Date.now();
  const expiresInSec = Number(tokenResponse.expires_in || 0);
  const refreshExpiresInSec = Number(tokenResponse.refresh_expires_in || 0);
  const accessExpiresAtMs = expiresInSec ? nowMs + expiresInSec * 1000 : null;
  const refreshExpiresAtMs = refreshExpiresInSec
    ? nowMs + refreshExpiresInSec * 1000
    : null;

  return {
    token_type: tokenResponse.token_type || 'Bearer',
    scope: tokenResponse.scope || '',
    open_id: tokenResponse.open_id || null,
    access_token: tokenResponse.access_token || null,
    refresh_token: tokenResponse.refresh_token || null,
    expires_in: expiresInSec,
    refresh_expires_in: refreshExpiresInSec,
    access_expires_at_ms: accessExpiresAtMs,
    refresh_expires_at_ms: refreshExpiresAtMs,
    obtained_at_ms: nowMs,
  };
}

function isAccessTokenValid(auth, skewMs = 60_000) {
  if (!auth?.access_token) return false;
  if (!auth?.access_expires_at_ms) return true;
  return Date.now() + skewMs < auth.access_expires_at_ms;
}

async function getValidAccessToken({ clientKey, clientSecret }) {
  const stored = getStoredTikTokAuth();
  if (!stored) return { ok: false, reason: 'missing' };
  if (isAccessTokenValid(stored)) {
    return { ok: true, accessToken: stored.access_token, openId: stored.open_id, stored };
  }

  if (!stored.refresh_token) return { ok: false, reason: 'expired_no_refresh' };

  const refreshed = await refreshAccessToken({
    clientKey,
    clientSecret,
    refreshToken: stored.refresh_token,
  });

  const normalized = normalizeTokenResponse(refreshed);
  setStoredTikTokAuth(normalized);
  return { ok: true, accessToken: normalized.access_token, openId: normalized.open_id, stored: normalized };
}

async function fetchUserInfo({ accessToken, fields = ['open_id', 'display_name', 'avatar_url'] }) {
  const url = `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields.join(','))}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30_000,
  });
  return response.data;
}

module.exports = {
  buildAuthorizeUrl,
  createState,
  exchangeCodeForToken,
  fetchUserInfo,
  getStoredTikTokAuth,
  getValidAccessToken,
  normalizeTokenResponse,
  setStoredTikTokAuth,
};
