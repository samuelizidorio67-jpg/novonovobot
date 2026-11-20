import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Cache em memória das últimas mídias de visualização única
// Chave: ID da mensagem (stanzaId)
// Valor: { id, from, sender, mediaType, content, timestamp }
const viewOnceCache = new Map();

// Mapeia o último ID de mensagem de visualização única por chat (remoteJid)
const lastViewOnceByChat = new Map();

const MAX_CACHE_SIZE = 150;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

export function toBuffer(val) {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (typeof val === 'string') return Buffer.from(val, 'base64');
  return Buffer.from(val);
}

/**
 * Desempacota uma mensagem para encontrar conteúdo de visualização única
 * Retorna { mediaType: 'image'|'video'|'audio', content: object } ou null
 */
export function extractViewOnce(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;

  let current = messageObj;
  let isVO = false;

  // Percorre wrappers conhecidos
  for (let i = 0; i < 6; i++) {
    if (!current || typeof current !== 'object') break;

    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.deviceSentMessage?.message) {
      current = current.deviceSentMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      isVO = true;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      isVO = true;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      isVO = true;
      continue;
    }
    break;
  }

  if (!current || typeof current !== 'object') return null;

  if (current.imageMessage && (isVO || current.imageMessage.viewOnce)) {
    return { mediaType: 'image', content: current.imageMessage };
  }
  if (current.videoMessage && (isVO || current.videoMessage.viewOnce)) {
    return { mediaType: 'video', content: current.videoMessage };
  }
  if (current.audioMessage && (isVO || current.audioMessage.viewOnce)) {
    return { mediaType: 'audio', content: current.audioMessage };
  }

  // Fallback: se estiver dentro de um wrapper viewOnce explícito
  if (isVO) {
    if (current.imageMessage) return { mediaType: 'image', content: current.imageMessage };
    if (current.videoMessage) return { mediaType: 'video', content: current.videoMessage };
    if (current.audioMessage) return { mediaType: 'audio', content: current.audioMessage };
  }

  return null;
}

/**
 * Registra uma mensagem que chegou no WhatsApp no cache de View Once
 */
export function recordIncomingViewOnce(msg) {
  if (!msg?.message || !msg?.key?.id) return;

  const vo = extractViewOnce(msg.message);
  if (!vo) return;

  const from = msg.key.remoteJid;
  const id = msg.key.id;
  const sender = msg.key.participant || msg.key.remoteJid;

  // Garante que o mediaKey seja mantido como Buffer intacto
  if (vo.content.mediaKey) {
    vo.content.mediaKey = toBuffer(vo.content.mediaKey);
  }

  viewOnceCache.set(id, {
    id,
    from,
    sender,
    mediaType: vo.mediaType,
    content: vo.content,
    key: msg.key,
    timestamp: Date.now()
  });

  if (from) {
    lastViewOnceByChat.set(from, id);
  }

  // Limpa entradas antigas se passar do limite
  if (viewOnceCache.size > MAX_CACHE_SIZE) {
    const oldestKey = viewOnceCache.keys().next().value;
    viewOnceCache.delete(oldestKey);
  }
}

/**
 * Busca uma mídia de visualização única para o comando /ver:
 * 1. Pela mensagem citada (stanzaId no cache ou no quotedMessage)
 * 2. Pela última mídia de visualização única recebida no chat
 * 3. Pela própria mensagem se enviada como visualização única
 */
export function findViewOnce(msg, from, contextInfo) {
  const stanzaId = contextInfo?.stanzaId;

  // 1. Tenta pelo ID da mensagem citada no cache
  if (stanzaId && viewOnceCache.has(stanzaId)) {
    return viewOnceCache.get(stanzaId);
  }

  // 2. Tenta extrair diretamente do quotedMessage recebido
  const quoted = contextInfo?.quotedMessage;
  if (quoted) {
    const voQuoted = extractViewOnce(quoted);
    if (voQuoted && voQuoted.content) {
      const mediaKey = voQuoted.content.mediaKey;
      const hasKey = mediaKey && (
        Buffer.isBuffer(mediaKey) ? mediaKey.length > 0 :
        typeof mediaKey === 'string' ? mediaKey.trim().length > 0 :
        (mediaKey.byteLength ?? mediaKey.length ?? 0) > 0
      );
      if (hasKey) {
        return {
          id: stanzaId || msg.key.id,
          from,
          sender: contextInfo.participant || from,
          mediaType: voQuoted.mediaType,
          content: voQuoted.content,
          key: { remoteJid: from, id: stanzaId || msg.key.id, participant: contextInfo.participant }
        };
      }
    }
  }

  // 3. Se a própria mensagem for uma visualização única (ex: /ver na legenda)
  const directVO = extractViewOnce(msg.message);
  if (directVO) {
    return {
      id: msg.key.id,
      from,
      sender: msg.key.participant || from,
      mediaType: directVO.mediaType,
      content: directVO.content,
      key: msg.key
    };
  }

  // 4. Fallback: pega a última visualização única recebida no chat
  if (from && lastViewOnceByChat.has(from)) {
    const lastId = lastViewOnceByChat.get(from);
    const cached = viewOnceCache.get(lastId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      return cached;
    }
  }

  return null;
}

/**
 * Faz o download da mídia descriptografando diretamente
 */
export async function downloadViewOnceFile(mediaType, content) {
  const mediaKey = toBuffer(content.mediaKey);
  if (!mediaKey || mediaKey.length === 0) {
    throw new Error('MISSING_MEDIA_KEY');
  }

  const stream = await downloadContentFromMessage({
    mediaKey: mediaKey,
    directPath: content.directPath,
    url: content.url
  }, mediaType);

  let ext = 'bin';
  if (mediaType === 'image') ext = 'jpg';
  else if (mediaType === 'video') ext = 'mp4';
  else if (mediaType === 'audio') ext = 'mp3';

  const filePath = path.join(os.tmpdir(), `viewonce-${Date.now()}.${ext}`);
  const writeStream = fs.createWriteStream(filePath);

  for await (const chunk of stream) {
    writeStream.write(chunk);
  }
  writeStream.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  return filePath;
}
