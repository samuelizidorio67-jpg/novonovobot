import { downloadMediaMessage as baileysDownload } from '@whiskeysockets/baileys';
import axios from 'axios';
import ytdl from 'youtube-dl-exec';
import { execFile } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import yts from 'yt-search';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { DATA_DIR, COOKIES_PATH, IG_COOKIES_PATH } from '../config/paths.js';

import { DEFAULT_COOKIES } from './defaultCookies.js';

// Instâncias públicas do Piped (busca + streams sem bloqueio de datacenter).
// A ordem importa: tenta a primeira que responder. Instâncias do Piped
// caem/voltem com frequência — por isso há descoberta dinâmica abaixo e
// validação de streams (respostas só com espelho LBRY são descartadas).
// Sobrescreva com PIPED_INSTANCES="https://...,https://..." no .env.
const PIPED_INSTANCES = (process.env.PIPED_INSTANCES
  ? process.env.PIPED_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'https://api.piped.private.coffee',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.reallyaweso.me',
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.leptons.xyz',
      'https://pipedapi-libre.kavin.rocks',
      'https://piped-api.privacy.com.de',
      'https://api.piped.yt',
      'https://pipedapi.owo.si',
      'https://pipedapi.ducks.party',
      'https://piped-api.codespace.cz',
      'https://pipedapi.nosebs.ru',
      'https://pipedapi.orangenet.cc',
      'https://pipedapi.darkness.services',
    ]);

// Cache da descoberta dinâmica de instâncias (evita 1 request por comando, inclusive quando falha)
let pipedDiscoveryCache = { at: 0, list: [], failedAt: 0 };

// Tenta descobrir instâncias saudáveis via API pública do Piped.
// Best-effort: se falhar, usa a lista estática acima e respeita cooldown.
async function discoverPipedInstances() {
  const now = Date.now();
  if (now - pipedDiscoveryCache.at < 6 * 60 * 60 * 1000 && pipedDiscoveryCache.list.length) {
    return pipedDiscoveryCache.list;
  }
  if (pipedDiscoveryCache.failedAt && now - pipedDiscoveryCache.failedAt < 15 * 60 * 1000) {
    return [];
  }
  try {
    const res = await axios.get('https://piped-instances.kavin.rocks/filtered', { timeout: 4000 });
    const live = (Array.isArray(res.data) ? res.data : [])
      .filter((i) => i?.api_url)
      .map((i) => i.api_url.replace(/\/$/, ''));
    if (live.length) {
      pipedDiscoveryCache = { at: now, list: live, failedAt: 0 };
      console.log(`[piped] 🔍 Descobertas ${live.length} instâncias saudáveis.`);
      return live;
    }
  } catch (err) {
    pipedDiscoveryCache.failedAt = now;
    console.warn(`⚠️ Descoberta de instâncias Piped falhou, usando lista estática: ${err.message?.slice(0, 80)}`);
  }
  return [];
}

// Última instância que funcionou: vai na frente nas próximas tentativas.
let basePipedBoa = null;

async function getPipedBases() {
  const discovered = await discoverPipedInstances();
  const merged = [...discovered];
  for (const b of PIPED_INSTANCES) {
    if (!merged.includes(b)) merged.push(b);
  }
  if (basePipedBoa) {
    const semRepetir = merged.filter((b) => b !== basePipedBoa);
    return [basePipedBoa, ...semRepetir];
  }
  return merged;
}

// Streams vindos de espelho LBRY (odycdn) não são o áudio original do
// YouTube e costumam falhar — só aceita googlevideo ou proxy do Piped.
function isUsableStreamUrl(url = '') {
  if (!url) return false;
  if (/odycdn\.com|lbry|phantom/i.test(url)) return false;
  return /googlevideo\.com|pipedproxy|proxy\.piped|piped\.video/i.test(url) || url.startsWith('https://');
}

// Instâncias públicas do Invidious (segundo fallback de busca/streams).
const INVIDIOUS_INSTANCES = (process.env.INVIDIOUS_INSTANCES
  ? process.env.INVIDIOUS_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'https://inv.nadeko.net',
      'https://invidious.privacyredirect.in',
      'https://iv.melmac.space',
    ]);

// Instância do Cobalt (fallback opcional). As instâncias públicas mudam e
// muitas exigem chave — por isso SÓ é usada quando configurada.
// Para ativar: hospede sua instância (ou use uma liberada) e defina
// COBALT_API_URL no Railway, ex: https://sua-instancia.com
// Se a instância exigir autenticação, defina também COBALT_API_KEY.
const COBALT_API_URL = (process.env.COBALT_API_URL || '').trim().replace(/\/$/, '');
const COBALT_API_KEY = (process.env.COBALT_API_KEY || '').trim();

// Provider de PO Token (bgutil). Em 2026 o YouTube exige prova de origem para
// vários clientes; sem isso o cookie morre rápido e vem "Sign in to confirm
// you're not a bot". O plugin já vem instalado na imagem; aqui só apontamos
// para o servidor, quando existir (ex: http://127.0.0.1:4416).
const POT_PROVIDER_URL = (process.env.POT_PROVIDER_URL || '').trim().replace(/\/$/, '');


export function extractVideoId(input) {
  const m = String(input || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#&\s]*&)*v=|shorts\/|v\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Formata segundos em "Xh Ym Zs"
export function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

// Formata milissegundos em tempo legível
export function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days} dia(s)`;
  if (hours > 0) return `${hours} hora(s)`;
  if (minutes > 0) return `${minutes} minuto(s)`;
  return `${seconds} segundo(s)`;
}

// Baixa uma mídia de uma mensagem do WhatsApp e retorna o caminho do arquivo temporário
export async function downloadWhatsAppMedia(message, messageType) {
  try {
    const buffer = await baileysDownload(message, 'buffer', {});

    let ext = 'bin';
    if (messageType === 'image') ext = 'jpg';
    else if (messageType === 'video') ext = 'mp4';
    else if (messageType === 'audio') ext = 'mp3';
    else if (messageType === 'sticker') ext = 'webp';

    const tempFile = path.join(os.tmpdir(), `wa-media-${Date.now()}.${ext}`);
    fs.writeFileSync(tempFile, buffer);
    return tempFile;
  } catch (error) {
    if (error?.message?.includes('Cannot derive from empty media key')) {
      console.warn('A mídia recebida não contém uma mediaKey disponível.');
    } else {
      console.error('Erro ao baixar mídia do WhatsApp:', error);
    }
    throw error;
  }
}

const YT_DLP_MAX_AGE_DAYS = 14;
const YT_DLP_UPDATE_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const AUTH_COOKIE_NAMES = new Set([
  'LOGIN_INFO',
  'SID',
  'HSID',
  'SSID',
  'SAPISID',
  'APISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
]);
const ESSENTIAL_AUTH_COOKIE_NAMES = new Set(['LOGIN_INFO', 'SID']);

let cachedYtDlpVersionInfo = { path: null, version: null, checkedAt: 0 };
let ytDlpUpdatePromise = null;
let lastSyncedCookiesContent = null;

export function getYtDlpBinaryAssetForPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    return 'yt-dlp.exe';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  }
  if (platform === 'darwin') {
    return 'yt-dlp_macos';
  }
  return 'yt-dlp';
}

export function getManagedYtDlpPath() {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(DATA_DIR, '.bin', binName);
}

// Determina o melhor binário do yt-dlp disponível (prioriza binário gerenciado atualizado)
export function getBestYtDlpPath() {
  const custom = (process.env.YTDLP_PATH || '').trim();
  if (custom && fs.existsSync(custom)) {
    return custom;
  }
  const managed = getManagedYtDlpPath();
  try {
    if (fs.existsSync(managed) && fs.statSync(managed).size > 1_000_000) {
      return managed;
    }
  } catch (_) {}
  if (fs.existsSync('/usr/local/bin/yt-dlp')) {
    return '/usr/local/bin/yt-dlp';
  }
  if (process.platform !== 'win32') {
    return 'yt-dlp';
  }
  if (fs.existsSync(ytdl.constants.YOUTUBE_DL_PATH)) {
    return ytdl.constants.YOUTUBE_DL_PATH;
  }
  return 'yt-dlp';
}

export function needsYtDlpUpdateFromError(errMessage = '') {
  return /addOnDisposeCallback|Signature solving failed|n challenge solving failed|The page needs to be reloaded|older than 90 days|Requested format is not available|Only images are available/i.test(String(errMessage || ''));
}

function isYtDlpVersionStale(versionStr, maxAgeDays = YT_DLP_MAX_AGE_DAYS) {
  const m = String(versionStr || '').trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return false;
  const releasedAt = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(releasedAt)) return false;
  const ageDays = (Date.now() - releasedAt) / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

function readYtDlpVersion(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim().split(/\s+/)[0] || null);
    });
  });
}

function trySelfUpdateBinary(binPath) {
  return new Promise((resolve) => {
    if (!binPath || binPath.startsWith('/nix/store')) return resolve(false);
    try {
      if (path.isAbsolute(binPath)) {
        fs.accessSync(binPath, fs.constants.W_OK);
      }
    } catch (_) {
      return resolve(false);
    }
    execFile(binPath, ['-U'], { timeout: 45000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[yt-dlp] ⚠️ Auto-update via -U falhou (${binPath}): ${(stderr || err.message || '').slice(0, 120)}`);
        return resolve(false);
      }
      const out = `${stdout || ''}\n${stderr || ''}`;
      if (/Updated yt-dlp to|yt-dlp is up to date/i.test(out)) {
        console.log(`[yt-dlp] 🔄 ${out.trim().split('\n').pop()}`);
        return resolve(true);
      }
      resolve(false);
    });
  });
}

async function downloadStandaloneYtDlp(targetPath) {
  const asset = getYtDlpBinaryAssetForPlatform();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${Date.now()}`;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 45000,
      maxContentLength: 80 * 1024 * 1024,
      maxBodyLength: 80 * 1024 * 1024,
      headers: { 'User-Agent': 'serie-bot-whatsapp' },
    });
    const buf = Buffer.from(res.data);
    if (buf.length < 1_000_000) {
      throw new Error(`binário baixado muito pequeno (${buf.length} bytes)`);
    }
    fs.writeFileSync(tmpPath, buf);
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpPath, '755');
    }
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch (_) {}
    }
    fs.renameSync(tmpPath, targetPath);
    const version = await readYtDlpVersion(targetPath);
    console.log(`[yt-dlp] ✅ Binário atualizado em ${targetPath} (versão ${version || 'recente'}).`);
    return Boolean(version);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    console.warn(`[yt-dlp] ⚠️ Não foi possível baixar atualização de ${url}: ${err.message?.slice(0, 120)}`);
    return false;
  }
}

export async function ensureLatestYtDlp({ force = false } = {}) {
  if (process.env.YTDLP_AUTO_UPDATE === '0') return false;
  if (ytDlpUpdatePromise) return ytDlpUpdatePromise;

  const now = Date.now();
  const currentPath = getBestYtDlpPath();
  if (!force && cachedYtDlpVersionInfo.path === currentPath && now - cachedYtDlpVersionInfo.checkedAt < YT_DLP_UPDATE_CHECK_COOLDOWN_MS) {
    if (!isYtDlpVersionStale(cachedYtDlpVersionInfo.version)) {
      return false;
    }
  }

  ytDlpUpdatePromise = (async () => {
    try {
      const version = await readYtDlpVersion(currentPath);
      cachedYtDlpVersionInfo = { path: currentPath, version, checkedAt: Date.now() };
      if (!force && version && !isYtDlpVersionStale(version)) {
        return false;
      }

      if (version) {
        console.log(`[yt-dlp] 🔄 Versão atual (${version}) desatualizada ou falhou desafio JS — buscando versão recente...`);
      }

      if (await trySelfUpdateBinary(currentPath)) {
        const updatedVer = await readYtDlpVersion(currentPath);
        cachedYtDlpVersionInfo = { path: currentPath, version: updatedVer, checkedAt: Date.now() };
        return updatedVer !== version;
      }

      const managedPath = getManagedYtDlpPath();
      if (await downloadStandaloneYtDlp(managedPath)) {
        const updatedVer = await readYtDlpVersion(managedPath);
        cachedYtDlpVersionInfo = { path: managedPath, version: updatedVer, checkedAt: Date.now() };
        return true;
      }
      return false;
    } finally {
      ytDlpUpdatePromise = null;
    }
  })();

  return ytDlpUpdatePromise;
}

// Executa o binário do yt-dlp com garantias de permissão e suporte a fallback de cookies
function runYtDlpExecFile(args) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = getBestYtDlpPath();

    if (process.platform !== 'win32' && fs.existsSync(ytDlpPath)) {
      try {
        fs.chmodSync(ytDlpPath, '755');
      } catch (_) {}
    }

    execFile(ytDlpPath, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errStr = stderr || error.message;
        console.error('[yt-dlp error]', errStr);
        if (errStr.includes("python3': No such file or directory") || errStr.includes("python3: not found")) {
          return reject(new Error('Python 3 não está instalado no ambiente do servidor.'));
        }
        return reject(new Error(errStr));
      }
      resolve(stdout);
    });
  });
}

function stripOuterQuotes(value) {
  const s = value.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function formatNetscapeLines(records) {
  if (!records.length) return null;
  const lines = ['# Netscape HTTP Cookie File', '# Normalizado automaticamente pelo bot', ''];
  for (const r of records) {
    lines.push([r.domain, r.includeSubdomains, r.path, r.secure, r.expiry, r.name, r.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function parseNetscapeRecords(text) {
  const records = [];
  const rawLines = text.split(/\r?\n/);

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tabParts = rawLine.replace(/\r$/, '').split('\t');
    if (tabParts.length >= 7 && tabParts[0].trim() && tabParts[5].trim()) {
      records.push({
        domain: tabParts[0].trim(),
        includeSubdomains: /^true$/i.test(tabParts[1].trim()) ? 'TRUE' : 'FALSE',
        path: tabParts[2].trim() || '/',
        secure: /^true$/i.test(tabParts[3].trim()) ? 'TRUE' : 'FALSE',
        expiry: String(Math.floor(Number(tabParts[4].trim())) || 0),
        name: tabParts[5].trim(),
        value: tabParts.slice(6).join('\t').trim(),
      });
      continue;
    }

    const spaceMatch = line.match(/^([^\s#]+)\s+(TRUE|FALSE)\s+(\/\S*)\s+(TRUE|FALSE)\s+(\d+)\s+([^\s\t]+)\s+([^\s\t]+)$/i);
    if (spaceMatch) {
      records.push({
        domain: spaceMatch[1],
        includeSubdomains: spaceMatch[2].toUpperCase(),
        path: spaceMatch[3],
        secure: spaceMatch[4].toUpperCase(),
        expiry: spaceMatch[5],
        name: spaceMatch[6],
        value: spaceMatch[7],
      });
    }
  }

  // Fallback para quando o painel colapsou todas as linhas do cookies.txt em 1 linha separada por espaços
  if (!records.length) {
    const collapsedRegex = /((?:\.?[a-z0-9-]+\.)+[a-z]{2,})\s+(TRUE|FALSE)\s+(\/\S*)\s+(TRUE|FALSE)\s+(\d+)\s+([^\s\t]+)\s+([^\s\t]+)/gi;
    let m;
    while ((m = collapsedRegex.exec(text)) !== null) {
      records.push({
        domain: m[1],
        includeSubdomains: m[2].toUpperCase(),
        path: m[3],
        secure: m[4].toUpperCase(),
        expiry: m[5],
        name: m[6],
        value: m[7],
      });
    }
  }

  return records;
}

const lastSyncedCookiesByPath = new Map();

// Converte vários formatos de exportação de cookies para Netscape
// (o formato que o yt-dlp aceita). Aceita:
//  1) Netscape cru (inclusive colapsado em 1 linha ou com espaços no lugar de TABs)
//  2) Base64 do Netscape
//  3) JSON de extensões (Cookie-Editor/EditThisCookie): [{domain,name,value,...}]
//  4) Pares name=value (um por linha ou separados por ;)
//  5) Caminho para arquivo de cookies existente
export function normalizeCookiesToNetscape(raw, options = {}) {
  const {
    domainRegex = /youtube\.com|google\.com|youtu\.be/i,
    defaultDomain = '.youtube.com',
  } = options;

  if (!raw || typeof raw !== 'string') return null;
  let text = stripOuterQuotes(raw);
  if (!text) return null;

  // 5) Caminho para arquivo?
  if (!text.includes('\n') && !text.includes('\t') && text.length < 300) {
    try {
      if (fs.existsSync(text) && fs.statSync(text).isFile()) {
        text = stripOuterQuotes(fs.readFileSync(text, 'utf-8'));
      }
    } catch (_) {}
  }

  // 2) Base64?
  if (!text.includes('\t') && !text.includes('# Netscape') && !domainRegex.test(text) && text.length > 50) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8');
      if (domainRegex.test(decoded) || decoded.includes('Netscape')) {
        text = stripOuterQuotes(decoded);
      }
    } catch (_) {}
  }
  if (text.includes('\\n') || text.includes('\\t')) {
    text = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  // 1) Netscape (padrão, com espaços, ou colapsado em 1 linha)
  const netscapeRecords = parseNetscapeRecords(text);
  if (netscapeRecords.length) {
    const filtered = netscapeRecords.filter((r) => domainRegex.test(r.domain));
    return formatNetscapeLines(filtered.length ? filtered : netscapeRecords);
  }

  // 3) JSON de extensões?
  const cookies = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : parsed.cookies || parsed.data || [];
      for (const c of arr) {
        if (c && c.name && c.value !== undefined) {
          cookies.push({
            domain: c.domain || defaultDomain,
            path: c.path || '/',
            secure: c.secure === true || String(c.name).startsWith('__Secure-'),
            expiry: Number(c.expirationDate || c.expiry || 1893456000),
            name: String(c.name),
            value: String(c.value),
          });
        }
      }
    } catch (_) {}
  }

  // 4) Pares name=value?
  if (!cookies.length && /[A-Za-z0-9_-]+\s*=\s*[^;\s\n]+/.test(text) && !text.includes('\t')) {
    const pairs = text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (name && value && !/^(domain|path|expires|max-age|secure|samesite)$/i.test(name)) {
          cookies.push({ domain: defaultDomain, path: '/', secure: name.startsWith('__Secure-') || defaultDomain.includes('instagram'), expiry: 1893456000, name, value });
        }
      }
    }
  }

  const matchingCookies = cookies.filter((c) => domainRegex.test(c.domain || ''));
  const source = matchingCookies.length ? matchingCookies : cookies;
  if (!source.length) return null;

  return formatNetscapeLines(
    source.map((c) => ({
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      includeSubdomains: 'TRUE',
      path: c.path || '/',
      secure: c.secure ? 'TRUE' : 'FALSE',
      expiry: String(Math.floor(c.expiry) || 1893456000),
      name: c.name,
      value: c.value,
    }))
  );
}

function parseValidCookieNames(content, domainRegex) {
  const nowSec = Math.floor(Date.now() / 1000);
  const validNames = new Set();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = rawLine.replace(/\r$/, '').split('\t');
    if (parts.length < 7) continue;

    const domain = parts[0].trim();
    const expiry = Number(parts[4].trim());
    const name = parts[5].trim();
    const value = parts.slice(6).join('\t').trim();

    if (!domainRegex.test(domain) || !name || !value) continue;
    if (Number.isFinite(expiry) && expiry > 0 && expiry < nowSec) continue;

    validNames.add(name);
  }

  return validNames;
}

// Valida estritamente se o conteúdo Netscape possui linhas reais, não-expiradas e com tokens de sessão do YouTube
export function isValidNetscapeCookiesContent(content) {
  if (!content || typeof content !== 'string') return false;
  if (DEFAULT_COOKIES && content.trim() === DEFAULT_COOKIES.trim()) {
    return false;
  }

  const validNames = parseValidCookieNames(content, /youtube\.com|google\.com|youtu\.be/i);
  const validAuthNames = new Set([...validNames].filter((name) => AUTH_COOKIE_NAMES.has(name)));

  if (!validAuthNames.size) return false;
  for (const essential of ESSENTIAL_AUTH_COOKIE_NAMES) {
    if (validAuthNames.has(essential)) return true;
  }
  return validAuthNames.has('__Secure-1PSID') && validAuthNames.has('__Secure-1PAPISID');
}

// Valida estritamente se o arquivo de cookies possui sessão válida do Instagram
export function isValidInstagramCookiesContent(content) {
  if (!content || typeof content !== 'string') return false;
  const validNames = parseValidCookieNames(content, /instagram\.com/i);
  return validNames.has('sessionid') || (validNames.has('ds_user_id') && validNames.has('csrftoken'));
}

function syncCookiesFromEnv({ envVar, filePath, domainRegex, defaultDomain, domainHint, label }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const rawEnv = process.env[envVar];
  if (!rawEnv || !rawEnv.trim()) return;

  try {
    const netscape = normalizeCookiesToNetscape(rawEnv, { domainRegex, defaultDomain });
    if (netscape && domainRegex.test(netscape)) {
      if (lastSyncedCookiesByPath.get(filePath) !== netscape) {
        const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
        if (existing !== netscape) {
          fs.writeFileSync(filePath, netscape, 'utf-8');
          console.log(`[yt-dlp] ✅ Cookies do ${label} sincronizados a partir de ${envVar} (${netscape.length} bytes).`);
        }
        lastSyncedCookiesByPath.set(filePath, netscape);
      }
    } else {
      const raw = rawEnv.trim();
      let domains = '';
      try {
        domains = [...new Set(raw.split('\n').map((l) => (l.split('\t')[0] || '').trim()).filter((s) => s && s.includes('.') && !s.startsWith('#')))].slice(0, 6).join(', ');
      } catch (_) {}
      console.warn(`[yt-dlp] ⚠️ ${envVar} ignorado: formato não reconhecido (${raw.length} chars, tabs=${raw.includes('\t')}, json=${/^[[{]/.test(raw)}${domains ? `, dominios=[${domains}]` : ''}). Exporte com "Get cookies.txt LOCALLY" logado em ${domainHint}.`);
    }
  } catch (err) {
    console.error(`❌ Erro ao escrever ${envVar} em ${path.basename(filePath)}:`, err);
  }
}

// Sincroniza cookies REAIS vindos das variáveis de ambiente.
function ensureValidCookiesFile() {
  syncCookiesFromEnv({
    envVar: 'YOUTUBE_COOKIES',
    filePath: COOKIES_PATH,
    domainRegex: /youtube\.com|google\.com|youtu\.be/i,
    defaultDomain: '.youtube.com',
    domainHint: 'youtube.com',
    label: 'YouTube',
  });
  syncCookiesFromEnv({
    envVar: 'INSTAGRAM_COOKIES',
    filePath: IG_COOKIES_PATH,
    domainRegex: /instagram\.com/i,
    defaultDomain: '.instagram.com',
    domainHint: 'instagram.com',
    label: 'Instagram',
  });
}
ensureValidCookiesFile();

// Adiciona diretório do deno ao PATH se existir
if (fs.existsSync('/root/.deno/bin') && !process.env.PATH.includes('/root/.deno/bin')) {
  process.env.PATH = `/root/.deno/bin:${process.env.PATH}`;
}

function checkValidCookies() {
  try {
    ensureValidCookiesFile();
    if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 200) {
      return isValidNetscapeCookiesContent(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    }
  } catch (_) {}
  return false;
}

function checkValidInstagramCookies() {
  try {
    ensureValidCookiesFile();
    if (fs.existsSync(IG_COOKIES_PATH) && fs.statSync(IG_COOKIES_PATH).size > 100) {
      return isValidInstagramCookiesContent(fs.readFileSync(IG_COOKIES_PATH, 'utf-8'));
    }
  } catch (_) {}
  return false;
}

// Monta os argumentos base do yt-dlp.
// IMPORTANTE: não força --user-agent manualmente. Um UA copiado que
// contradiz o player_client (ex: UA de Chrome com client android) é uma
// causa clássica do "Sign in to confirm you're not a bot". Deixa o yt-dlp
// escolher o UA correto para cada cliente.
function buildBaseArgs(withCookies = true, clientOverride = null) {
  const nodePath = process.execPath;

  const args = [
    '--no-playlist',
    '--force-ipv4',
    '--geo-bypass',
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '20',
    '--sleep-requests', '1',
    '--no-warnings',
  ];

  // Runtimes JavaScript para resolver desafios de assinatura / PO Token
  if (fs.existsSync('/root/.deno/bin/deno')) {
    args.push('--js-runtimes', 'deno:/root/.deno/bin/deno');
  }
  if (nodePath) {
    args.push('--js-runtimes', `node:${nodePath}`);
  } else {
    args.push('--js-runtimes', 'node');
  }

  if (clientOverride) {
    args.push('--extractor-args', `youtube:player_client=${clientOverride}`);
  }

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (withCookies && checkValidCookies() && fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  }

  // PO Token: só quando o servidor do provider estiver configurado.
  if (POT_PROVIDER_URL) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`);
    args.push('--extractor-args', 'youtube:fetch_pot=always');
  }

  return args;
}

function isYoutubeTargetUrl(url) {
  return /youtube\.com|youtu\.be|music\.youtube\.com/i.test(String(url || ''));
}

// Planeja as tentativas do yt-dlp respeitando compatibilidade de cookies:
// - Com cookies: cliente padrão (tv_samsung/web_embedded/web) vem PRIMEIRO,
//   seguido de web_embedded e mweb. Clientes que rejeitam cookies
//   (tv_simply, android, android_vr, ios) ou forçam SABR (web_safari) nunca
//   são combinados com cookies.
export function buildYtDlpAttempts(url, hasCookies) {
  if (!isYoutubeTargetUrl(url)) {
    return [{ name: 'direto', withCookies: false, client: null }];
  }

  const attempts = [];
  if (hasCookies) {
    attempts.push({ name: 'padrao + cookies', withCookies: true, client: null });
    attempts.push({ name: 'web_embedded + cookies', withCookies: true, client: 'web_embedded' });
    attempts.push({ name: 'mweb + cookies', withCookies: true, client: 'mweb' });
  }

  attempts.push({ name: 'padrao (sem cookies)', withCookies: false, client: null });
  attempts.push({ name: 'web_embedded (sem cookies)', withCookies: false, client: 'web_embedded' });
  attempts.push({ name: 'tv_simply (sem cookies)', withCookies: false, client: 'tv_simply' });
  attempts.push({ name: 'mweb (sem cookies)', withCookies: false, client: 'mweb' });
  return attempts;
}

// Executa o download com retentativas e auto-atualização do yt-dlp quando necessário.
async function downloadWithYtDlp(url, specificArgs) {
  await ensureLatestYtDlp();

  const hasCookies = checkValidCookies();
  if (hasCookies && isYoutubeTargetUrl(url)) {
    console.log('[yt-dlp] Usando cookies autenticados do YouTube.');
  }

  const attempts = buildYtDlpAttempts(url, hasCookies);
  let lastError = null;
  let cookiesInvalidos = false;
  let retriedAfterUpdate = false;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.withCookies && cookiesInvalidos) continue;

    try {
      const args = [url, ...buildBaseArgs(attempt.withCookies, attempt.client), ...specificArgs];
      return await runYtDlpExecFile(args);
    } catch (err) {
      lastError = err;
      const errMsg = err.message || '';
      console.warn(`⚠️ Tentativa ${i + 1} (${attempt.name}) falhou: ${errMsg.slice(0, 120)}`);

      if (!retriedAfterUpdate && needsYtDlpUpdateFromError(errMsg)) {
        retriedAfterUpdate = true;
        const updated = await ensureLatestYtDlp({ force: true });
        if (updated) {
          i -= 1;
          continue;
        }
      }

      if (attempt.withCookies && /cookies are no longer valid|Sign in to confirm|Please sign in/i.test(errMsg)) {
        cookiesInvalidos = true;
        console.warn('[yt-dlp] ⚠️ Cookies inválidos/expirados — seguindo sem cookies.');
      }
    }
  }

  const errStr = lastError?.message || '';
  if (/Sign in to confirm you['’]re not a bot|\b429\b/i.test(errStr)) {
    throw new Error('O YouTube exigiu login no servidor. Caso persista, atualize a variável YOUTUBE_COOKIES no Railway.');
  }
  throw lastError || new Error('Não foi possível realizar o download após várias tentativas.');
}

// Busca no Piped em lotes paralelos com timeout curto
async function pipedSearch(query) {
  const bases = await getPipedBases();
  for (let i = 0; i < bases.length; i += 4) {
    const lote = bases.slice(i, i + 4);
    const results = await Promise.all(
      lote.map(async (base) => {
        try {
          const res = await axios.get(`${base}/search`, {
            params: { q: query, filter: 'videos' },
            timeout: 4500,
          });
          const items = res.data?.items || res.data?.data || [];
          const first = items.find((item) => item?.url && (item.url.includes('watch?v=') || item.type === 'stream'));
          if (!first) return null;
          const videoId = extractVideoId(`https://x${first.url}`) || String(first.url).split('v=')[1]?.slice(0, 11);
          if (!videoId) return null;
          return {
            url: `https://www.youtube.com/watch?v=${videoId}`,
            videoId,
            title: first.title || query,
            duration: first.duration ? String(first.duration) : '',
            views: first.views || 0,
            author: first.uploaderName || first.uploader || 'YouTube',
          };
        } catch (_) {
          return null;
        }
      })
    );
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

// Busca no Invidious em paralelo com timeout curto
async function invidiousSearch(query) {
  const results = await Promise.all(
    INVIDIOUS_INSTANCES.map(async (base) => {
      try {
        const res = await axios.get(`${base}/api/v1/search`, {
          params: { q: query, type: 'video' },
          timeout: 4500,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const first = Array.isArray(res.data) ? res.data.find((item) => item?.videoId) : null;
        if (!first) return null;
        return {
          url: `https://www.youtube.com/watch?v=${first.videoId}`,
          videoId: first.videoId,
          title: first.title || query,
          duration: first.lengthSeconds ? `${Math.floor(first.lengthSeconds / 60)}:${String(first.lengthSeconds % 60).padStart(2, '0')}` : '',
          views: first.viewCount || 0,
          author: first.author || 'YouTube',
        };
      } catch (_) {
        return null;
      }
    })
  );
  return results.find(Boolean) || null;
}

// Detalhes de um videoId via Piped (quando yt-search está bloqueado)
async function pipedVideoDetails(videoId) {
  const bases = await getPipedBases();
  for (let i = 0; i < bases.length; i += 4) {
    const lote = bases.slice(i, i + 4);
    const results = await Promise.all(
      lote.map(async (base) => {
        try {
          const res = await axios.get(`${base}/streams/${videoId}`, { timeout: 4500 });
          if (!res.data?.title) return null;
          return {
            url: `https://www.youtube.com/watch?v=${videoId}`,
            videoId,
            title: res.data.title,
            duration: res.data.duration ? `${Math.floor(res.data.duration / 60)}:${String(Math.floor(res.data.duration % 60)).padStart(2, '0')}` : '',
            views: res.data.views || 0,
            author: res.data.uploader || 'YouTube',
          };
        } catch (_) {
          return null;
        }
      })
    );
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

// Metadados/busca via yt-dlp usando o cliente padrão (sem forçar web_safari, que sofre SABR)
export function buildYtDlpSearchArgs(target, withCookies = true) {
  const args = [target, ...buildBaseArgs(withCookies, null), '--ignore-no-formats-error', '--dump-json'];
  if (String(target || '').startsWith('ytsearch')) {
    args.push('--flat-playlist');
  }
  return args;
}

function parseFirstJson(stdout) {
  const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function ytdlpDuration(j) {
  if (j?.duration_string) return j.duration_string;
  if (j?.duration) {
    const m = Math.floor(j.duration / 60);
    const s = Math.floor(j.duration % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return '';
}

async function runYtDlpJsonQuery(target) {
  await ensureLatestYtDlp();
  const hasCookies = checkValidCookies();
  const cookieModes = hasCookies ? [true, false] : [false];

  let lastErr = null;
  for (const useCookies of cookieModes) {
    try {
      const stdout = await runYtDlpExecFile(buildYtDlpSearchArgs(target, useCookies));
      const parsed = parseFirstJson(stdout);
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// Detalhes de vídeo (título/canal) direto do yt-dlp
async function ytdlpVideoDetails(videoId) {
  try {
    const j = await runYtDlpJsonQuery(`https://www.youtube.com/watch?v=${videoId}`);
    if (!j?.title) return null;
    return {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      title: j.title,
      duration: ytdlpDuration(j),
      views: j.view_count || 0,
      author: j.uploader || j.channel || 'YouTube',
    };
  } catch (err) {
    console.warn(`⚠️ yt-dlp não resolveu metadados de ${videoId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// Busca por texto usando ytsearch1 do yt-dlp
async function ytdlpSearch(query) {
  try {
    const j = await runYtDlpJsonQuery(`ytsearch1:${query}`);
    if (!j?.id) return null;
    return {
      url: j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`,
      videoId: j.id,
      title: j.title || query,
      duration: ytdlpDuration(j),
      views: j.view_count || 0,
      author: j.uploader || j.channel || 'YouTube',
    };
  } catch (err) {
    console.warn(`⚠️ yt-dlp não conseguiu buscar "${query}": ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// Extrai ID ou resolve URL / busca do YouTube (com fallbacks rápidos e anti-bloqueio)
async function resolveYoutubeInfo(query) {
  const cleanQuery = query.trim();
  const videoId = extractVideoId(cleanQuery);

  if (videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      const videoDetails = await yts({ videoId });
      if (videoDetails && videoDetails.title) {
        return {
          url,
          videoId,
          title: videoDetails.title,
          duration: videoDetails.timestamp || '',
          views: videoDetails.views || 0,
          author: videoDetails.author?.name || 'YouTube'
        };
      }
    } catch (err) {
      console.warn('⚠️ yts bloqueado para videoId, tentando yt-dlp/Piped:', videoId, err.message?.slice(0, 80));
    }
    const viaYtDlp = await ytdlpVideoDetails(videoId);
    if (viaYtDlp) return viaYtDlp;
    const piped = await pipedVideoDetails(videoId);
    if (piped) return piped;
    return { url, videoId, title: 'Áudio do YouTube', duration: '', views: 0, author: 'YouTube' };
  }

  // Busca por texto: yt-search primeiro, depois yt-dlp (--flat-playlist), depois Piped/Invidious
  try {
    const searchResult = await yts(cleanQuery);
    const video = searchResult.videos ? searchResult.videos[0] : searchResult;
    if (video?.url) {
      return {
        url: video.url,
        videoId: extractVideoId(video.url),
        title: video.title || cleanQuery,
        duration: video.timestamp || '',
        views: video.views || 0,
        author: video.author?.name || 'YouTube'
      };
    }
  } catch (err) {
    console.warn('⚠️ yt-search bloqueado, tentando yt-dlp/Piped/Invidious:', err.message?.slice(0, 100));
  }

  const viaYtDlp = await ytdlpSearch(cleanQuery);
  if (viaYtDlp) {
    console.log(`[busca] ✅ Resolvido via yt-dlp: ${viaYtDlp.title}`);
    return viaYtDlp;
  }
  const piped = await pipedSearch(cleanQuery);
  if (piped) {
    console.log(`[busca] ✅ Resolvido via Piped: ${piped.title}`);
    return piped;
  }
  const inv = await invidiousSearch(cleanQuery);
  if (inv) {
    console.log(`[busca] ✅ Resolvido via Invidious: ${inv.title}`);
    return inv;
  }
  throw new Error('Nenhum vídeo encontrado para esta busca (YouTube bloqueou todas as fontes de pesquisa).');
}

// Baixa um stream remoto para arquivo temporário
async function downloadStreamToFile(streamUrl, tmpFile, referer = 'https://www.youtube.com/') {
  const res = await axios.get(streamUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 120 * 1024 * 1024,
    maxBodyLength: 120 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: referer,
    },
  });
  fs.writeFileSync(tmpFile, Buffer.from(res.data));
  return tmpFile;
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const bin = (ffmpegPath && fs.existsSync(ffmpegPath)) ? ffmpegPath : 'ffmpeg';
    execFile(bin, ['-y', '-i', inputPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', outputPath], (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

// Junta vídeo e áudio separados (streams "videoOnly" do Piped) num mp4.
function muxVideoAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const bin = (ffmpegPath && fs.existsSync(ffmpegPath)) ? ffmpegPath : 'ffmpeg';
    execFile(
      bin,
      ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath],
      (err) => (err ? reject(err) : resolve(outputPath))
    );
  });
}

// Streams de áudio utilizáveis, preferindo os proxiados pela instância
// (URLs googlevideo podem estar presas ao IP da instância e dar 403).
function streamsDeAudio(data) {
  return (data?.audioStreams || [])
    .filter((s) => s?.url && isUsableStreamUrl(s.url))
    .sort((a, b) => {
      const proxiado = (u) => (/googlevideo\.com/i.test(u) ? 0 : 1);
      const dif = proxiado(b.url) - proxiado(a.url);
      return dif !== 0 ? dif : (b.bitrate || 0) - (a.bitrate || 0);
    });
}

// Streams de vídeo mp4, preferindo progressivo (com áudio embutido).
function streamsDeVideo(data) {
  const todos = (data?.videoStreams || []).filter((s) => s?.url && isUsableStreamUrl(s.url));
  const progressivos = todos.filter((s) => s.videoOnly === false && (s.mimeType || '').includes('mp4'));
  const pool = progressivos.length ? progressivos : todos.filter((s) => (s.mimeType || '').includes('mp4'));
  return pool.sort((a, b) => (a.height || 0) - (b.height || 0));
}

async function baixarAudioViaPiped(data, base) {
  let lastErr = null;
  for (const stream of streamsDeAudio(data)) {
    const rawTmp = path.join(os.tmpdir(), `piped-raw-${Date.now()}.tmp`);
    const mp3Tmp = path.join(os.tmpdir(), `yt-audio-${Date.now()}.mp3`);
    try {
      await downloadStreamToFile(stream.url, rawTmp, base);
      try {
        await convertToMp3(rawTmp, mp3Tmp);
        try { fs.unlinkSync(rawTmp); } catch (_) {}
      } catch (_) {
        fs.renameSync(rawTmp, mp3Tmp);
      }
      return mp3Tmp;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(rawTmp); } catch (_) {}
    }
  }
  throw lastErr || new Error('nenhum stream de áudio pôde ser baixado');
}

async function baixarVideoViaPiped(data, base) {
  let lastErr = null;
  const audio = streamsDeAudio(data)[0];

  for (const stream of streamsDeVideo(data)) {
    const tmpFile = path.join(os.tmpdir(), `yt-video-${Date.now()}.mp4`);
    try {
      await downloadStreamToFile(stream.url, tmpFile, base);

      // Stream "videoOnly": baixa o áudio e junta, senão o vídeo sai mudo.
      if (stream.videoOnly === true && audio) {
        const audioTmp = path.join(os.tmpdir(), `piped-audio-${Date.now()}.tmp`);
        const muxed = path.join(os.tmpdir(), `yt-video-mux-${Date.now()}.mp4`);
        await downloadStreamToFile(audio.url, audioTmp, base);
        await muxVideoAudio(tmpFile, audioTmp, muxed);
        try { fs.unlinkSync(tmpFile); fs.unlinkSync(audioTmp); } catch (_) {}
        return muxed;
      }

      return tmpFile;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
  throw lastErr || new Error('nenhum stream de vídeo pôde ser baixado');
}

// Fallback 1: baixa áudio/vídeo via Piped (backend fora do IP bloqueado).
async function downloadViaPiped(info, kind = 'audio') {
  const videoId = info.videoId || extractVideoId(info.url);
  if (!videoId) throw new Error('Piped: sem videoId');

  const bases = await getPipedBases();
  let lastErr = null;

  for (let i = 0; i < bases.length; i += 4) {
    const lote = bases.slice(i, i + 4);
    const respostas = await Promise.all(
      lote.map(async (base) => {
        try {
          const res = await axios.get(`${base}/streams/${videoId}`, { timeout: 4500 });
          return { base, data: res.data };
        } catch (err) {
          return { base, erro: err };
        }
      })
    );

    for (const resposta of respostas) {
      if (!resposta.data) {
        lastErr = resposta.erro;
        console.warn(`⚠️ Piped ${resposta.base} falhou: ${resposta.erro?.message?.slice(0, 80)}`);
        continue;
      }

      const { base, data } = resposta;
      const audio = streamsDeAudio(data);
      const video = streamsDeVideo(data);

      if (kind === 'audio' && !audio.length) {
        lastErr = new Error('sem audioStreams utilizáveis (só espelho LBRY?)');
        continue;
      }
      if (kind === 'video' && !video.length) {
        lastErr = new Error('sem videoStreams utilizáveis (só espelho LBRY?)');
        continue;
      }

      try {
        const filePath = kind === 'audio'
          ? await baixarAudioViaPiped(data, base)
          : await baixarVideoViaPiped(data, base);

        basePipedBoa = base;
        console.log(`[download] ✅ ${kind === 'audio' ? 'Áudio' : 'Vídeo'} via Piped (${base})`);
        return {
          filePath,
          title: data.title || info.title,
          duration: info.duration,
          views: data.views ?? info.views,
          author: data.uploader || info.author,
          url: info.url
        };
      } catch (err) {
        lastErr = err;
        console.warn(`⚠️ Piped ${base} respondeu, mas o download falhou: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  throw lastErr || new Error('Piped: todas as instâncias falharam');
}

// Fallback 2: baixa via Cobalt API (somente quando COBALT_API_URL configurada)
async function downloadViaCobalt(info, kind = 'audio') {
  if (!COBALT_API_URL) {
    throw new Error('Cobalt não configurado (defina COBALT_API_URL no Railway)');
  }
  const body = kind === 'audio'
    ? { url: info.url, downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '128', filenameStyle: 'basic' }
    : { url: info.url, downloadMode: 'auto', videoQuality: '720', youtubeVideoCodec: 'h264', filenameStyle: 'basic' };
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (COBALT_API_KEY) headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
  const res = await axios.post(COBALT_API_URL, body, {
    timeout: 30000,
    headers,
  });
  const data = res.data;
  const fileUrl = data?.url || data?.tunnel?.[0];
  if (data?.status === 'error' || !fileUrl) {
    throw new Error(`Cobalt: ${data?.error?.code || data?.text || 'sem URL de download'}`);
  }
  const tmpFile = path.join(os.tmpdir(), kind === 'audio' ? `yt-audio-${Date.now()}.mp3` : `yt-video-${Date.now()}.mp4`);
  await downloadStreamToFile(fileUrl, tmpFile, COBALT_API_URL);
  console.log(`[download] ✅ Via Cobalt (${COBALT_API_URL})`);
  return { filePath: tmpFile, title: info.title, duration: info.duration, views: info.views, author: info.author, url: info.url };
}

const MAX_WHATSAPP_VIDEO_BYTES = 95 * 1024 * 1024;
const MAX_TRANSCODE_INPUT_BYTES = 45 * 1024 * 1024;

function probeVideoCodec(inputPath) {
  const bin = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : (ffmpegPath || 'ffmpeg');
  return new Promise((resolve) => {
    execFile(bin, ['-i', inputPath], { timeout: 10000 }, (_err, _stdout, stderr) => {
      const out = String(stderr || '');
      const m = out.match(/Stream #\d+:\d+.*:\s*Video:\s*([a-zA-Z0-9_]+)/);
      resolve(m ? m[1].toLowerCase() : null);
    });
  });
}

async function finalizeWhatsappVideo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Arquivo de vídeo não foi gerado');
  }
  const size = fs.statSync(filePath).size;
  if (size < 1000) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw new Error('Arquivo de vídeo baixado está vazio ou corrompido');
  }
  if (size > MAX_WHATSAPP_VIDEO_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw new Error(`Vídeo excede o limite de envio do WhatsApp (${mb} MB)`);
  }

  const codec = await probeVideoCodec(filePath);
  if (codec && codec !== 'h264' && size <= MAX_TRANSCODE_INPUT_BYTES) {
    console.log(`[video] 🔄 Convertendo codec ${codec} para H.264 compatível com WhatsApp...`);
    return await ensureWhatsAppCompatibleVideo(filePath);
  }
  return filePath;
}

function buildYoutubeFailureError(primaryErr, kind) {
  const msg = primaryErr?.message || '';
  const label = kind === 'audio' ? 'áudio' : 'vídeo';
  if (/does not pass filter \(!is_live\)|is_live/i.test(msg)) {
    return new Error('Transmissões ao vivo (live) não podem ser baixadas.');
  }
  if (/limite de envio do WhatsApp/i.test(msg)) {
    return new Error(msg);
  }
  const cookiesHint = checkValidCookies()
    ? ''
    : ' Sem cookies válidos no servidor: exporte o cookies.txt (extensão "Get cookies.txt LOCALLY", logado no YouTube) e cole em YOUTUBE_COOKIES no Railway.';
  if (/not a bot|\b429\b|LOGIN_REQUIRED|exigiu login/i.test(msg)) {
    return new Error(`O YouTube bloqueou o IP do servidor.${cookiesHint}`);
  }
  return new Error(`Não foi possível baixar o ${label}: ${msg.slice(0, 140)}.${cookiesHint}`);
}

// Cadeia unificada do YouTube: yt-dlp local → Piped → Cobalt (quando configurado).
async function downloadYoutubeMedia(query, kind = 'audio') {
  const info = await resolveYoutubeInfo(query);
  const isAudio = kind === 'audio';
  const tmpFile = path.join(os.tmpdir(), isAudio ? `yt-audio-${Date.now()}.mp3` : `yt-video-${Date.now()}.mp4`);
  const specificArgs = isAudio
    ? [
        '--match-filter', '!is_live',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--output', tmpFile
      ]
    : [
        '--match-filter', '!is_live',
        '--format', 'bestvideo[height<=720][vcodec^=avc1][ext=mp4][filesize<?58M]+bestaudio[ext=m4a]/bestvideo[height<=480][vcodec^=avc1][ext=mp4][filesize<?58M]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=720]/best',
        '--merge-output-format', 'mp4',
        '--output', tmpFile
      ];

  let ytDlpError = null;
  try {
    await downloadWithYtDlp(info.url, specificArgs);
    const finalPath = isAudio ? tmpFile : await finalizeWhatsappVideo(tmpFile);
    return { filePath: finalPath, title: info.title, duration: info.duration, views: info.views, author: info.author, url: info.url };
  } catch (error) {
    ytDlpError = error;
    if (/does not pass filter \(!is_live\)|limite de envio do WhatsApp/i.test(error?.message || '')) {
      throw buildYoutubeFailureError(error, kind);
    }
    console.warn(`⚠️ yt-dlp falhou no ${isAudio ? 'áudio' : 'vídeo'}, tentando Piped:`, error.message?.slice(0, 120));
  }

  let pipedError = null;
  try {
    const res = await downloadViaPiped(info, kind);
    if (!isAudio) res.filePath = await finalizeWhatsappVideo(res.filePath);
    return res;
  } catch (error) {
    pipedError = error;
    if (COBALT_API_URL) {
      console.warn(`⚠️ Piped falhou no ${isAudio ? 'áudio' : 'vídeo'}, tentando Cobalt:`, error.message?.slice(0, 120));
    }
  }

  if (COBALT_API_URL) {
    try {
      const res = await downloadViaCobalt(info, kind);
      if (!isAudio) res.filePath = await finalizeWhatsappVideo(res.filePath);
      return res;
    } catch (error) {
      console.error(`Erro no downloadYoutube${isAudio ? 'Audio' : 'Video'} (todas as fontes falharam):`, error.message?.slice(0, 200));
      throw buildYoutubeFailureError(ytDlpError || error, kind);
    }
  }

  const finalErr = ytDlpError || pipedError;
  console.error(`Erro no downloadYoutube${isAudio ? 'Audio' : 'Video'} (todas as fontes falharam):`, finalErr?.message?.slice(0, 200));
  throw buildYoutubeFailureError(finalErr, kind);
}

export async function downloadYoutubeAudio(query) {
  return downloadYoutubeMedia(query, 'audio');
}

export async function downloadYoutubeVideo(query) {
  return downloadYoutubeMedia(query, 'video');
}

let tikwmQueuePromise = Promise.resolve();
let lastTikwmRequestAt = 0;
const TIKWM_MIN_INTERVAL_MS = 1250;

export function resetTikWmThrottleForTest() {
  tikwmQueuePromise = Promise.resolve();
  lastTikwmRequestAt = 0;
}

// Serializa chamadas ao TikWM (limite gratuito de 1 req/s) e faz retry em caso de rate-limit
export function callTikWmApi(url, fetchFn = axios.get) {
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const waitMs = Math.max(0, lastTikwmRequestAt + TIKWM_MIN_INTERVAL_MS - Date.now());
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      lastTikwmRequestAt = Date.now();

      const res = await fetchFn(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 15000 });
      const data = res?.data;
      if (data && data.code === -1 && /limit|second|too many/i.test(String(data.msg || ''))) {
        console.warn(`[tikwm] ⚠️ Rate limit (${data.msg}), aguardando para tentar novamente...`);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }
      return data;
    }
    throw new Error('TikWM atingiu o limite de requisições por segundo.');
  };

  const task = tikwmQueuePromise.then(run, run);
  tikwmQueuePromise = task.catch(() => {});
  return task;
}

export function isTikTokPhotoSlideshow(data) {
  if (!data || !Array.isArray(data.images) || data.images.length === 0) return false;
  const playUrl = String(data.play || '');
  return !data.hdplay && (!playUrl || /\.mp3(\?|$)/i.test(playUrl) || Number(data.duration || 0) === 0);
}

// Busca e baixa vídeo do TikTok sem marca d'água
export async function downloadTiktokVideo(url) {
  let primaryError = null;

  // 1) TikWM (com throttle global contra "1 request/second")
  try {
    const resData = await callTikWmApi(url);

    if (resData && resData.code === 0 && isTikTokPhotoSlideshow(resData.data)) {
      throw new Error('Este link do TikTok é um carrossel de fotos (sem vídeo). Use /play para baixar o áudio.');
    }

    if (resData && resData.code === 0 && (resData.data?.play || resData.data?.hdplay || resData.data?.wmplay)) {
      const title = resData.data.title || 'Vídeo do TikTok';
      const author = resData.data.author?.nickname || resData.data.author?.unique_id || 'TikTok User';
      const candidates = [resData.data.play, resData.data.hdplay, resData.data.wmplay].filter(Boolean);
      let lastErr = null;
      for (const videoUrl of candidates) {
        try {
          const tmpFile = path.join(os.tmpdir(), `tt-video-${Date.now()}.mp4`);
          await downloadStreamToFile(videoUrl, tmpFile, 'https://www.tiktok.com/');
          const finalPath = await finalizeWhatsappVideo(tmpFile);
          console.log('[download] ✅ Vídeo do TikTok via TikWM');
          return { filePath: finalPath, title, author, url };
        } catch (err) {
          lastErr = err;
          console.warn(`⚠️ TikWM CDN falhou (${String(videoUrl).slice(0, 60)}...): ${err.message?.slice(0, 100)}`);
        }
      }
      if (lastErr) throw lastErr;
    } else {
      const msg = resData?.msg || 'resposta sem mídia';
      primaryError = new Error(msg);
      console.warn('⚠️ TikWM não resolveu o link:', msg);
    }
  } catch (err) {
    if (/carrossel de fotos|limite de envio do WhatsApp/i.test(err?.message || '')) {
      throw err;
    }
    primaryError = err;
    console.warn('⚠️ Falha no TikWM API para vídeo, tentando Cobalt/yt-dlp...', err.message?.slice(0, 120));
  }

  // 2) Cobalt (quando configurado)
  if (COBALT_API_URL) {
    try {
      const res = await downloadViaCobalt({ url, title: 'Vídeo do TikTok', author: 'TikTok' }, 'video');
      res.filePath = await finalizeWhatsappVideo(res.filePath);
      return res;
    } catch (err) {
      console.warn('⚠️ Cobalt falhou no TikTok, tentando via yt-dlp...', err.message?.slice(0, 120));
    }
  }

  // 3) Fallback via yt-dlp (prefere H.264 para evitar bytevc1/H.265 incompatível com WhatsApp)
  try {
    const tmpBase = path.join(os.tmpdir(), `tt-video-${Date.now()}`);
    const specificArgs = [
      '--format', 'best[vcodec^=h264][ext=mp4]/best[vcodec^=avc1][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', `${tmpBase}.mp4`
    ];
    await downloadWithYtDlp(url, specificArgs);
    const produced = [`${tmpBase}.mp4`].find((f) => fs.existsSync(f) && fs.statSync(f).size > 1000)
      || fs.readdirSync(os.tmpdir()).map((f) => path.join(os.tmpdir(), f))
        .find((f) => f.startsWith(`${tmpBase}.`) && fs.statSync(f).size > 1000);
    if (!produced) throw new Error('yt-dlp concluiu mas não gerou arquivo de vídeo');
    const finalPath = await finalizeWhatsappVideo(produced);
    return {
      filePath: finalPath,
      title: 'Vídeo do TikTok',
      author: 'TikTok',
      url
    };
  } catch (error) {
    const errMsg = primaryError?.message || error?.message || '';
    console.error('Erro no downloadTiktokVideo (todas as fontes falharam):', error.message?.slice(0, 200));
    throw new Error(`Não foi possível baixar o vídeo do TikTok (${errMsg.slice(0, 110)})`);
  }
}

// Busca e baixa áudio do TikTok (MP3)
export async function downloadTiktokAudio(url) {
  let primaryError = null;

  // 1) TikWM (music -> play)
  try {
    const resData = await callTikWmApi(url);

    if (resData && resData.code === 0 && (resData.data?.music || resData.data?.play)) {
      const title = resData.data.title || resData.data.music_info?.title || 'Áudio do TikTok';
      const author = resData.data.author?.nickname || 'TikTok';
      const candidates = [resData.data.music, resData.data.play].filter(Boolean);
      let lastErr = null;
      for (const audioUrl of candidates) {
        try {
          const rawTmp = path.join(os.tmpdir(), `tt-raw-${Date.now()}.tmp`);
          await downloadStreamToFile(audioUrl, rawTmp, 'https://www.tiktok.com/');
          const tmpFile = path.join(os.tmpdir(), `tt-audio-${Date.now()}.mp3`);
          try {
            await convertToMp3(rawTmp, tmpFile);
            try { fs.unlinkSync(rawTmp); } catch (_) {}
          } catch (_) {
            fs.renameSync(rawTmp, tmpFile);
          }
          if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 1000) {
            throw new Error('arquivo baixado vazio ou inválido');
          }
          console.log('[download] ✅ Áudio do TikTok via TikWM');
          return { filePath: tmpFile, title, author, url };
        } catch (err) {
          lastErr = err;
          console.warn(`⚠️ TikWM áudio falhou: ${err.message?.slice(0, 100)}`);
        }
      }
      if (lastErr) throw lastErr;
    } else {
      const msg = resData?.msg || 'resposta sem áudio';
      primaryError = new Error(msg);
      console.warn('⚠️ TikWM não resolveu o link de áudio:', msg);
    }
  } catch (err) {
    primaryError = err;
    console.warn('⚠️ Falha no TikWM API para áudio, tentando Cobalt/yt-dlp...', err.message?.slice(0, 120));
  }

  // 2) Cobalt
  if (COBALT_API_URL) {
    try {
      return await downloadViaCobalt({ url, title: 'Áudio do TikTok', author: 'TikTok' }, 'audio');
    } catch (err) {
      console.warn('⚠️ Cobalt falhou no áudio do TikTok, tentando via yt-dlp...', err.message?.slice(0, 120));
    }
  }

  // 3) Fallback via yt-dlp
  try {
    const tmpBase = path.join(os.tmpdir(), `tt-audio-${Date.now()}`);
    const specificArgs = [
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--output', `${tmpBase}.mp3`
    ];
    await downloadWithYtDlp(url, specificArgs);
    const produced = [`${tmpBase}.mp3`].find((f) => fs.existsSync(f) && fs.statSync(f).size > 1000)
      || fs.readdirSync(os.tmpdir()).map((f) => path.join(os.tmpdir(), f))
        .find((f) => f.startsWith(`${tmpBase}.`) && fs.statSync(f).size > 1000);
    if (!produced) throw new Error('yt-dlp concluiu mas não gerou arquivo de áudio');
    return {
      filePath: produced,
      title: 'Áudio do TikTok',
      author: 'TikTok',
      url
    };
  } catch (error) {
    const errMsg = primaryError?.message || error?.message || '';
    console.error('Erro no downloadTiktokAudio (todas as fontes falharam):', error.message?.slice(0, 200));
    throw new Error(`Não foi possível baixar o áudio do TikTok (${errMsg.slice(0, 110)})`);
  }
}

// Garante que o vídeo seja codificado em H.264 + AAC + yuv420p com +faststart para reproduzir perfeitamente no WhatsApp
export async function ensureWhatsAppCompatibleVideo(inputPath) {
  const outputPath = path.join(os.tmpdir(), `wa-compat-${Date.now()}.mp4`);
  const bin = (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : (ffmpegPath || 'ffmpeg'));

  return new Promise((resolve) => {
    execFile(
      bin,
      [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '24',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
      ],
      { timeout: 90000 },
      (error) => {
        if (error) {
          console.warn('⚠️ Transcodificação para WhatsApp ignorada/falhou, usando vídeo original:', error.message);
          return resolve(inputPath);
        }
        try {
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            try { fs.unlinkSync(inputPath); } catch (_) {}
            return resolve(outputPath);
          }
        } catch (_) {}
        resolve(inputPath);
      }
    );
  });
}

export function buildInstagramYtDlpAttempts(hasIgCookies) {
  const attempts = [];
  if (hasIgCookies) {
    attempts.push({ name: 'ig + cookies', withCookies: true, impersonate: false });
  }
  attempts.push({ name: 'ig padrão', withCookies: false, impersonate: false });
  attempts.push({ name: 'ig impersonate chrome', withCookies: false, impersonate: true });
  return attempts;
}

function buildInstagramBaseArgs(withCookies, impersonate) {
  const args = [
    '--no-playlist',
    '--force-ipv4',
    '--geo-bypass',
    '--retries', '2',
    '--socket-timeout', '20',
    '--no-warnings',
  ];
  if (impersonate) {
    args.push('--impersonate', 'chrome');
  }
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
  }
  if (withCookies && checkValidInstagramCookies() && fs.existsSync(IG_COOKIES_PATH)) {
    args.push('--cookies', IG_COOKIES_PATH);
  }
  return args;
}

function buildInstagramFailureError(primaryErr, kind) {
  const msg = String(primaryErr?.message || '');
  const label = kind === 'audio' ? 'áudio' : 'vídeo';
  const hasIgCookies = checkValidInstagramCookies();
  if (/rate-limit|login page|not granting access|require_login|cookies/i.test(msg)) {
    const hint = hasIgCookies
      ? 'Os cookies em INSTAGRAM_COOKIES expiraram ou o IP sofreu rate-limit — renove INSTAGRAM_COOKIES ou configure COBALT_API_URL.'
      : 'O Instagram bloqueou o acesso anônimo no IP do servidor — configure INSTAGRAM_COOKIES (cookies do instagram.com) ou COBALT_API_URL no Railway.';
    return new Error(hint);
  }
  if (/There is no video in this post/i.test(msg)) {
    return new Error('Esta publicação do Instagram contém apenas foto(s), não vídeo.');
  }
  return new Error(`Não foi possível baixar o ${label} do Instagram (${msg.slice(0, 120) || 'publicação privada ou indisponível'}).`);
}

async function downloadInstagramMedia(url, kind = 'video') {
  await ensureLatestYtDlp();
  const cleanUrl = String(url || '').split('?')[0].trim();
  const isAudio = kind === 'audio';
  const tmpFile = path.join(os.tmpdir(), isAudio ? `ig-audio-${Date.now()}.mp3` : `ig-raw-${Date.now()}.mp4`);
  const mediaArgs = isAudio
    ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--output', tmpFile]
    : ['--format', 'best[vcodec^=h264][ext=mp4]/best[vcodec^=avc1][ext=mp4]/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', '--merge-output-format', 'mp4', '--output', tmpFile];

  const hasIgCookies = checkValidInstagramCookies();
  const attempts = buildInstagramYtDlpAttempts(hasIgCookies);
  let ytDlpError = null;

  for (const attempt of attempts) {
    try {
      await runYtDlpExecFile([cleanUrl, ...buildInstagramBaseArgs(attempt.withCookies, attempt.impersonate), ...mediaArgs]);
      if (isAudio) {
        return { filePath: tmpFile, title: 'Áudio do Instagram', author: 'Instagram', url: cleanUrl };
      }
      const finalFile = await finalizeWhatsappVideo(tmpFile);
      return { filePath: finalFile, title: 'Vídeo do Instagram', author: 'Instagram', url: cleanUrl };
    } catch (err) {
      ytDlpError = err;
      console.warn(`⚠️ Instagram (${attempt.name}) falhou: ${(err.message || '').slice(0, 120)}`);
    }
  }

  if (COBALT_API_URL) {
    try {
      const res = await downloadViaCobalt({ url: cleanUrl, title: isAudio ? 'Áudio do Instagram' : 'Vídeo do Instagram', author: 'Instagram' }, kind);
      if (!isAudio) res.filePath = await finalizeWhatsappVideo(res.filePath);
      return res;
    } catch (err) {
      console.warn('⚠️ Cobalt falhou no Instagram:', err.message?.slice(0, 120));
    }
  }

  console.error(`Erro no downloadInstagram${isAudio ? 'Audio' : 'Video'}:`, ytDlpError);
  throw buildInstagramFailureError(ytDlpError, kind);
}

// Busca e baixa vídeo do Instagram garantindo reprodução no WhatsApp
export async function downloadInstagramVideo(url) {
  return downloadInstagramMedia(url, 'video');
}

// Busca e baixa áudio do Instagram (MP3)
export async function downloadInstagramAudio(url) {
  return downloadInstagramMedia(url, 'audio');
}




