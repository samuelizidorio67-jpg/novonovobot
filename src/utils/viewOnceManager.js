import { downloadContentFromMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Cache em memória das últimas mídias de visualização única
// Chave: ID da mensagem (stanzaId)
// Valor: { id, from, sender, mediaType, hkdfType, content, key, rawMessage, timestamp }
const viewOnceCache = new Map();

// Mapeia o último ID de mensagem de visualização única por chat (qualquer alias de JID)
const lastViewOnceByChat = new Map();

// Registra mensagens de visualização única que chegaram com <unavailable type="view_once"/>
const unavailableViewOnceIds = new Map();
const lastUnavailableByChat = new Map();

const MAX_CACHE_SIZE = 150;
const MAX_UNAVAILABLE_SIZE = 150;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const UNAVAILABLE_TTL_MS = 15 * 60 * 1000; // 15 minutos

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'businessMessage',
  'botInvokeMessage',
  'associatedChildMessage',
  'groupMentionedMessage',
  'lottieStickerMessage',
  'groupStatusMentionMessage',
  'groupStatusMessage',
  'limitSharingMessage',
  'botTaskMessage',
  'questionMessage'
];

const VIEW_ONCE_WRAPPER_KEYS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension'
];

export function toBuffer(val) {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
  if (val instanceof ArrayBuffer) return Buffer.from(val);
  if (ArrayBuffer.isView(val)) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  if (Array.isArray(val)) return Buffer.from(val);
  if (typeof val === 'string') {
    const trimmed = val.trim().replace(/^data:[^;]*;base64,/i, '');
    if (!trimmed) return null;
    return Buffer.from(trimmed, 'base64');
  }
  if (typeof val === 'object') {
    const numKeys = Object.keys(val)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numKeys.length > 0) {
      return Buffer.from(numKeys.map((k) => Number(val[k])));
    }
  }
  return null;
}

export function hasValidMediaKey(mediaKey) {
  const buf = toBuffer(mediaKey);
  return Boolean(buf && buf.length > 0);
}

function normalizeChatKey(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    return jidNormalizedUser(jid);
  } catch (_) {
    return jid.split(':')[0];
  }
}

export function collectChatKeys(msg, resolvedFrom = null) {
  const rawRemote = msg?.key?.remoteJid || '';
  const isGroup = rawRemote.endsWith('@g.us') || String(resolvedFrom || '').endsWith('@g.us');
  const rawCandidates = [resolvedFrom, rawRemote];

  if (!isGroup) {
    rawCandidates.push(
      msg?.key?.senderPn,
      msg?.key?.participantPn,
      msg?.key?.remoteJidAlt,
      msg?.key?.participantAlt,
      msg?.key?.senderLid,
      msg?.key?.participantLid
    );
  }

  const out = [];
  for (const cand of rawCandidates) {
    if (!cand || typeof cand !== 'string') continue;
    const norm = normalizeChatKey(cand);
    if (norm && !out.includes(norm)) out.push(norm);
    if (!out.includes(cand)) out.push(cand);
  }
  return out;
}

/**
 * Desempacota todos os wrappers conhecidos do Baileys/WhatsApp mantendo
 * a informação de se a mensagem passou por algum wrapper de visualização única.
 */
export function unwrapMessageContent(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') {
    return { content: null, isViewOnce: false };
  }

  let current = messageObj;
  let isViewOnce = false;

  for (let i = 0; i < 10; i++) {
    if (!current || typeof current !== 'object') break;

    let unwrapped = false;

    for (const key of VIEW_ONCE_WRAPPER_KEYS) {
      if (current[key]?.message) {
        current = current[key].message;
        isViewOnce = true;
        unwrapped = true;
        break;
      }
    }
    if (unwrapped) continue;

    for (const key of WRAPPER_KEYS) {
      if (current[key]?.message) {
        current = current[key].message;
        unwrapped = true;
        break;
      }
    }
    if (unwrapped) continue;

    if (current.editedMessage?.message?.protocolMessage?.editedMessage) {
      current = current.editedMessage.message.protocolMessage.editedMessage;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }

    break;
  }

  return { content: current, isViewOnce };
}

/**
 * Extrai o contextInfo da mensagem mesmo quando embrulhada em deviceSentMessage,
 * ephemeralMessage, businessMessage, botInvokeMessage ou editedMessage.
 */
export function extractContextInfo(msg) {
  if (!msg?.message || typeof msg.message !== 'object') return {};

  const { content: innerMsg } = unwrapMessageContent(msg.message);
  const preferredKeys = [
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'ptvMessage',
    'buttonsResponseMessage',
    'templateButtonReplyMessage',
    'interactiveResponseMessage',
    'listResponseMessage'
  ];

  for (const source of [innerMsg, msg.message]) {
    if (!source || typeof source !== 'object') continue;
    for (const k of preferredKeys) {
      if (source[k]?.contextInfo) return source[k].contextInfo;
    }
    for (const val of Object.values(source)) {
      if (val && typeof val === 'object' && val.contextInfo) {
        return val.contextInfo;
      }
    }
  }

  return {};
}

/**
 * Desempacota uma mensagem para encontrar conteúdo de visualização única.
 * Retorna { mediaType: 'image'|'video'|'audio'|'document', hkdfType: string, content: object } ou null
 */
export function extractViewOnce(messageObj, { allowUnwrappedMedia = false } = {}) {
  const { content: current, isViewOnce: isVO } = unwrapMessageContent(messageObj);
  if (!current || typeof current !== 'object') return null;

  const mediaCandidates = [
    ['imageMessage', 'image', 'image'],
    ['videoMessage', 'video', 'video'],
    ['ptvMessage', 'video', 'ptv'],
    ['audioMessage', 'audio', 'audio'],
    ['documentMessage', 'document', 'document']
  ];

  for (const [prop, mediaType, hkdfType] of mediaCandidates) {
    const media = current[prop];
    if (!media || typeof media !== 'object') continue;
    const isMediaVO = isVO || Boolean(media.viewOnce);
    const isStrippedQuotedMedia = allowUnwrappedMedia && prop !== 'documentMessage';
    if (isMediaVO || isStrippedQuotedMedia) {
      return { mediaType, hkdfType, content: media };
    }
  }

  return null;
}

/**
 * Registra que uma visualização única chegou como indisponível (<unavailable type="view_once"/>)
 */
export function recordUnavailableViewOnce(msg, resolvedFrom = null) {
  const id = msg?.key?.id;
  if (!id) return;
  const now = Date.now();

  unavailableViewOnceIds.set(id, { id, timestamp: now });
  if (unavailableViewOnceIds.size > MAX_UNAVAILABLE_SIZE) {
    const oldestKey = unavailableViewOnceIds.keys().next().value;
    unavailableViewOnceIds.delete(oldestKey);
  }

  for (const key of collectChatKeys(msg, resolvedFrom)) {
    lastUnavailableByChat.set(key, { id, timestamp: now });
  }
}

/**
 * Registra uma mensagem que chegou no WhatsApp no cache de View Once.
 * Retorna true se era visualização única e foi registrada.
 */
export function recordIncomingViewOnce(msg, resolvedFrom = null) {
  if (!msg?.message || !msg?.key?.id) return false;

  const vo = extractViewOnce(msg.message);
  if (!vo) return false;

  const id = msg.key.id;
  const chatKeys = collectChatKeys(msg, resolvedFrom);
  const from = chatKeys[0] || msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  // Garante que o mediaKey seja mantido como Buffer intacto
  if (vo.content.mediaKey) {
    vo.content.mediaKey = toBuffer(vo.content.mediaKey) || vo.content.mediaKey;
  }

  const now = Date.now();
  unavailableViewOnceIds.delete(id);

  viewOnceCache.set(id, {
    id,
    from,
    sender,
    mediaType: vo.mediaType,
    hkdfType: vo.hkdfType,
    content: vo.content,
    key: msg.key,
    rawMessage: msg.message,
    timestamp: now
  });

  for (const key of chatKeys) {
    lastViewOnceByChat.set(key, id);
    const unavail = lastUnavailableByChat.get(key);
    if (unavail && (unavail.id === id || unavail.timestamp <= now)) {
      lastUnavailableByChat.delete(key);
    }
  }

  // Limpa entradas antigas se passar do limite
  if (viewOnceCache.size > MAX_CACHE_SIZE) {
    const oldestKey = viewOnceCache.keys().next().value;
    viewOnceCache.delete(oldestKey);
  }

  return true;
}

/**
 * Busca uma mídia de visualização única para o comando /ver:
 * 1. Pela mensagem citada (stanzaId no cache ou no quotedMessage)
 * 2. Pela própria mensagem se enviada como visualização única
 * 3. Pela última mídia de visualização única recebida no chat (quando não há citação)
 */
export function findViewOnce(msg, chatKeysOrFrom, contextInfo) {
  const stanzaId = contextInfo?.stanzaId;
  const quoted = contextInfo?.quotedMessage;

  // 1. Tenta pelo ID da mensagem citada no cache
  if (stanzaId && viewOnceCache.has(stanzaId)) {
    return viewOnceCache.get(stanzaId);
  }

  // 2. Tenta extrair diretamente do quotedMessage recebido
  if (quoted) {
    const baseSender = contextInfo.participant || msg?.key?.remoteJid;
    const baseFrom = Array.isArray(chatKeysOrFrom) ? chatKeysOrFrom[0] : chatKeysOrFrom;
    const baseKey = { remoteJid: baseFrom || msg?.key?.remoteJid, id: stanzaId || msg?.key?.id, participant: contextInfo.participant };

    const voQuoted = extractViewOnce(quoted);
    if (voQuoted && voQuoted.content) {
      if (hasValidMediaKey(voQuoted.content.mediaKey)) {
        return {
          id: stanzaId || msg?.key?.id,
          from: baseFrom,
          sender: baseSender,
          mediaType: voQuoted.mediaType,
          hkdfType: voQuoted.hkdfType,
          content: voQuoted.content,
          key: baseKey,
          rawMessage: quoted
        };
      }
      // Citou explicitamente uma view-once mas veio sem mediaKey: não vazar mídia antiga do chat
      return {
        missingKey: true,
        unavailable: Boolean(stanzaId && unavailableViewOnceIds.has(stanzaId)),
        id: stanzaId
      };
    }

    // Fallback: Baileys/cliente pode ter removido o wrapper viewOnceMessageV2 ao citar
    const voStripped = extractViewOnce(quoted, { allowUnwrappedMedia: true });
    if (voStripped && voStripped.content && hasValidMediaKey(voStripped.content.mediaKey)) {
      return {
        id: stanzaId || msg?.key?.id,
        from: baseFrom,
        sender: baseSender,
        mediaType: voStripped.mediaType,
        hkdfType: voStripped.hkdfType,
        content: voStripped.content,
        key: baseKey,
        rawMessage: quoted
      };
    }
  }

  // 2.5 Se citou uma mensagem marcada como unavailable pelo WhatsApp
  if (stanzaId && unavailableViewOnceIds.has(stanzaId)) {
    return { missingKey: true, unavailable: true, id: stanzaId };
  }

  // 3. Se a própria mensagem for uma visualização única (ex: /ver na legenda)
  const directVO = extractViewOnce(msg?.message);
  if (directVO) {
    const baseFrom = Array.isArray(chatKeysOrFrom) ? chatKeysOrFrom[0] : chatKeysOrFrom;
    return {
      id: msg?.key?.id,
      from: baseFrom,
      sender: msg?.key?.participant || baseFrom,
      mediaType: directVO.mediaType,
      hkdfType: directVO.hkdfType,
      content: directVO.content,
      key: msg?.key,
      rawMessage: msg?.message
    };
  }

  // 4. Fallback: só pega a última do chat se o usuário NÃO citou outra mensagem
  if (!stanzaId && !quoted) {
    const candidateKeys = [
      ...(Array.isArray(chatKeysOrFrom) ? chatKeysOrFrom : [chatKeysOrFrom]),
      ...collectChatKeys(msg)
    ].filter(Boolean);

    const seen = new Set();
    let bestCached = null;
    let bestUnavail = null;

    for (const rawKey of candidateKeys) {
      for (const k of [rawKey, normalizeChatKey(rawKey)]) {
        if (!k || seen.has(k)) continue;
        seen.add(k);

        if (lastViewOnceByChat.has(k)) {
          const lastId = lastViewOnceByChat.get(k);
          const cached = viewOnceCache.get(lastId);
          if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            if (!bestCached || cached.timestamp > bestCached.timestamp) {
              bestCached = cached;
            }
          }
        }

        if (lastUnavailableByChat.has(k)) {
          const unavail = lastUnavailableByChat.get(k);
          if (unavail && (Date.now() - unavail.timestamp < UNAVAILABLE_TTL_MS)) {
            if (!bestUnavail || unavail.timestamp > bestUnavail.timestamp) {
              bestUnavail = unavail;
            }
          }
        }
      }
    }

    if (bestUnavail && (!bestCached || bestUnavail.timestamp > bestCached.timestamp)) {
      return { missingKey: true, unavailable: true, id: bestUnavail.id };
    }

    if (bestCached) {
      return bestCached;
    }
  }

  return null;
}

function getExtensionForMedia(mediaType, content = {}) {
  const mime = String(content?.mimetype || '').toLowerCase();
  if (mediaType === 'image') {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    return 'jpg';
  }
  if (mediaType === 'video') return 'mp4';
  if (mediaType === 'audio') {
    if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    return 'ogg';
  }
  if (mediaType === 'document') {
    const ext = path.extname(String(content?.fileName || '')).replace('.', '');
    if (ext) return ext;
  }
  return 'bin';
}

async function writeStreamToTempFile(stream, ext) {
  const filePath = path.join(os.tmpdir(), `viewonce-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  const writeStream = fs.createWriteStream(filePath);
  let bytesWritten = 0;

  try {
    for await (const chunk of stream) {
      bytesWritten += chunk.length;
      if (!writeStream.write(chunk)) {
        await new Promise((resolve) => writeStream.once('drain', resolve));
      }
    }
    writeStream.end();
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    if (bytesWritten === 0) {
      throw new Error('EMPTY_MEDIA_STREAM');
    }

    return filePath;
  } catch (err) {
    writeStream.destroy();
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw err;
  }
}

function buildDownloadInput(mediaKey, content) {
  const url = typeof content?.url === 'string' && content.url.startsWith('https://') ? content.url : undefined;
  const directPath = typeof content?.directPath === 'string' && content.directPath.length > 0 ? content.directPath : undefined;
  return { mediaKey, url, directPath };
}

/**
 * Faz o download da mídia descriptografando diretamente, com fallback de directPath e reupload
 */
export async function downloadViewOnceFile(mediaType, content, { sock = null, voData = null } = {}) {
  const mediaKey = toBuffer(content?.mediaKey);
  if (!mediaKey || mediaKey.length === 0) {
    throw new Error('MISSING_MEDIA_KEY');
  }

  const hkdfType = voData?.hkdfType || mediaType;
  const ext = getExtensionForMedia(mediaType, content);

  const tryDownload = async (input) => {
    if (!input.url && !input.directPath) {
      throw new Error('MISSING_MEDIA_URL');
    }
    const stream = await downloadContentFromMessage(input, hkdfType);
    return await writeStreamToTempFile(stream, ext);
  };

  const primary = buildDownloadInput(mediaKey, content);

  try {
    return await tryDownload(primary);
  } catch (firstErr) {
    // 1. Se a URL completa expirou/falhou mas existe directPath, tenta direto via directPath
    if (primary.url && primary.directPath) {
      try {
        return await tryDownload({ mediaKey, directPath: primary.directPath });
      } catch (_) {}
    }

    // 2. Tenta pedir reupload ao celular principal via Baileys updateMediaMessage
    if (sock?.updateMediaMessage && voData?.key) {
      try {
        const msgProp = hkdfType === 'ptv' ? 'ptvMessage' : `${mediaType}Message`;
        const waMsg = {
          key: voData.key,
          message: voData.rawMessage || { [msgProp]: { ...content, mediaKey } }
        };
        const updated = await sock.updateMediaMessage(waMsg);
        const refreshed = extractViewOnce(updated?.message, { allowUnwrappedMedia: true })?.content || content;
        const refreshedInput = buildDownloadInput(mediaKey, refreshed);
        if (refreshedInput.url || refreshedInput.directPath) {
          return await tryDownload(refreshedInput);
        }
      } catch (reuploadErr) {
        console.warn('⚠️ Reupload de mídia view-once falhou:', reuploadErr?.message || reuploadErr);
      }
    }

    throw firstErr;
  }
}
