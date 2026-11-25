import {
  proto,
  generateWAMessageFromContent,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys';
import $protobuf from 'protobufjs/minimal.js';
import { queueManager } from '../queue/QueueManager.js';

const $Reader = $protobuf.Reader;
const $util = $protobuf.util;
const hasOwn = Object.prototype.hasOwnProperty;
const PATCH_MARKER = Symbol.for('bot.audioStickerProto.installed');

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'editedMessage',
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

function defineOptionalField(Prototype, fieldName) {
  if (!hasOwn.call(Prototype, fieldName)) {
    Prototype[fieldName] = null;
  }
  const oneOfName = `_${fieldName}`;
  if (!hasOwn.call(Prototype, oneOfName)) {
    Object.defineProperty(Prototype, oneOfName, {
      get: $util.oneOfGetter([fieldName]),
      set: $util.oneOfSetter([fieldName]),
      configurable: true
    });
  }
}

function scanExtraFields(reader, startPos, end, onField) {
  // Usa um Reader isolado sobre [startPos, end] para ler campos desconhecidos
  // que o decoder original do WAProto ignorou, sem corromper o cursor principal.
  const sec = $Reader.create(reader.buf);
  sec.pos = startPos;
  sec.len = end;
  while (sec.pos < sec.len) {
    const tag = sec.uint32();
    const handled = onField(tag >>> 3, sec);
    if (!handled) {
      sec.skipType(tag & 7);
    }
  }
}

function patchMessageProto() {
  const { Message } = proto;
  const FutureProofMessage = Message.FutureProofMessage;

  defineOptionalField(Message.prototype, 'audioStickerMessage');

  const origEncode = Message.encode;
  const origDecode = Message.decode;
  const origVerify = Message.verify;
  const origFromObject = Message.fromObject;
  const origToObject = Message.toObject;

  Message.encode = function encode(message, writer) {
    const w = origEncode.call(this, message, writer);
    if (message && message.audioStickerMessage != null && hasOwn.call(message, 'audioStickerMessage')) {
      FutureProofMessage.encode(
        message.audioStickerMessage,
        w.uint32(1074).fork()
      ).ldelim();
    }
    return w;
  };

  Message.decode = function decode(reader, length) {
    const r = reader instanceof $Reader ? reader : $Reader.create(reader);
    const startPos = r.pos;
    const end = length === undefined ? r.len : startPos + length;
    const message = origDecode.call(this, r, length);

    scanExtraFields(r, startPos, end, (fieldNo, sec) => {
      if (fieldNo === 134) {
        message.audioStickerMessage = FutureProofMessage.decode(sec, sec.uint32());
        return true;
      }
      return false;
    });

    return message;
  };

  Message.verify = function verify(message) {
    const err = origVerify.call(this, message);
    if (err) return err;
    if (message.audioStickerMessage != null && hasOwn.call(message, 'audioStickerMessage')) {
      const nestedErr = FutureProofMessage.verify(message.audioStickerMessage);
      if (nestedErr) return `audioStickerMessage.${nestedErr}`;
    }
    return null;
  };

  Message.fromObject = function fromObject(object) {
    if (object instanceof Message) return object;
    const message = origFromObject.call(this, object);
    if (object && object.audioStickerMessage != null) {
      if (typeof object.audioStickerMessage !== 'object') {
        throw TypeError('.proto.Message.audioStickerMessage: object expected');
      }
      message.audioStickerMessage = FutureProofMessage.fromObject(object.audioStickerMessage);
    }
    return message;
  };

  Message.toObject = function toObject(message, options) {
    const object = origToObject.call(this, message, options);
    if (message && message.audioStickerMessage != null && hasOwn.call(message, 'audioStickerMessage')) {
      object.audioStickerMessage = FutureProofMessage.toObject(message.audioStickerMessage, options);
      if (options && options.oneofs) {
        object._audioStickerMessage = 'audioStickerMessage';
      }
    }
    return object;
  };
}

function patchStickerMessageProto() {
  const { StickerMessage, AudioMessage } = proto.Message;

  defineOptionalField(StickerMessage.prototype, 'premium');
  defineOptionalField(StickerMessage.prototype, 'emojis');
  defineOptionalField(StickerMessage.prototype, 'audioMessage');

  const origEncode = StickerMessage.encode;
  const origDecode = StickerMessage.decode;
  const origVerify = StickerMessage.verify;
  const origFromObject = StickerMessage.fromObject;
  const origToObject = StickerMessage.toObject;

  StickerMessage.encode = function encode(message, writer) {
    const w = origEncode.call(this, message, writer);
    if (message) {
      if (message.premium != null && hasOwn.call(message, 'premium')) {
        w.uint32(192).bool(message.premium);
      }
      if (message.emojis != null && hasOwn.call(message, 'emojis')) {
        w.uint32(202).string(message.emojis);
      }
      if (message.audioMessage != null && hasOwn.call(message, 'audioMessage')) {
        AudioMessage.encode(message.audioMessage, w.uint32(210).fork()).ldelim();
      }
    }
    return w;
  };

  StickerMessage.decode = function decode(reader, length) {
    const r = reader instanceof $Reader ? reader : $Reader.create(reader);
    const startPos = r.pos;
    const end = length === undefined ? r.len : startPos + length;
    const message = origDecode.call(this, r, length);

    scanExtraFields(r, startPos, end, (fieldNo, sec) => {
      if (fieldNo === 24) {
        message.premium = sec.bool();
        return true;
      }
      if (fieldNo === 25) {
        message.emojis = sec.string();
        return true;
      }
      if (fieldNo === 26) {
        message.audioMessage = AudioMessage.decode(sec, sec.uint32());
        return true;
      }
      return false;
    });

    return message;
  };

  StickerMessage.verify = function verify(message) {
    const err = origVerify.call(this, message);
    if (err) return err;
    if (message.premium != null && hasOwn.call(message, 'premium')) {
      if (typeof message.premium !== 'boolean') {
        return 'premium: boolean expected';
      }
    }
    if (message.emojis != null && hasOwn.call(message, 'emojis')) {
      if (!$util.isString(message.emojis)) {
        return 'emojis: string expected';
      }
    }
    if (message.audioMessage != null && hasOwn.call(message, 'audioMessage')) {
      const nestedErr = AudioMessage.verify(message.audioMessage);
      if (nestedErr) return `audioMessage.${nestedErr}`;
    }
    return null;
  };

  StickerMessage.fromObject = function fromObject(object) {
    if (object instanceof StickerMessage) return object;
    const message = origFromObject.call(this, object);
    if (object) {
      if (object.premium != null) {
        message.premium = Boolean(object.premium);
      }
      if (object.emojis != null) {
        message.emojis = String(object.emojis);
      }
      if (object.audioMessage != null) {
        if (typeof object.audioMessage !== 'object') {
          throw TypeError('.proto.Message.StickerMessage.audioMessage: object expected');
        }
        message.audioMessage = AudioMessage.fromObject(object.audioMessage);
      }
    }
    return message;
  };

  StickerMessage.toObject = function toObject(message, options) {
    const object = origToObject.call(this, message, options);
    if (!message) return object;
    if (message.premium != null && hasOwn.call(message, 'premium')) {
      object.premium = message.premium;
      if (options && options.oneofs) object._premium = 'premium';
    }
    if (message.emojis != null && hasOwn.call(message, 'emojis')) {
      object.emojis = message.emojis;
      if (options && options.oneofs) object._emojis = 'emojis';
    }
    if (message.audioMessage != null && hasOwn.call(message, 'audioMessage')) {
      object.audioMessage = AudioMessage.toObject(message.audioMessage, options);
      if (options && options.oneofs) object._audioMessage = 'audioMessage';
    }
    return object;
  };
}

/**
 * Estende em runtime o WAProto do Baileys para suportar audioStickerMessage (campo 134)
 * e os campos premium (24), emojis (25) e audioMessage (26) em StickerMessage.
 */
export function installAudioStickerProto() {
  if (proto.Message[PATCH_MARKER]) return;
  patchMessageProto();
  patchStickerMessageProto();
  Object.defineProperty(proto.Message, PATCH_MARKER, {
    value: true,
    enumerable: false
  });
}

/**
 * Extrai stickerMessage e audioMessage de uma mensagem contendo audioStickerMessage,
 * atravessando wrappers externos como ephemeralMessage e viewOnceMessageV2.
 */
export function unwrapAudioStickerMessage(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;

  let current = messageObj;
  if (
    current.message &&
    !current.audioStickerMessage &&
    !current.stickerMessage &&
    !WRAPPER_KEYS.some((key) => current[key])
  ) {
    current = current.message;
  }

  let sawAudioStickerWrapper = false;
  for (let i = 0; i < 10 && current && typeof current === 'object'; i++) {
    if (current.audioStickerMessage?.message) {
      sawAudioStickerWrapper = true;
      current = current.audioStickerMessage.message;
      continue;
    }

    let unwrapped = false;
    for (const key of WRAPPER_KEYS) {
      if (current[key]?.message) {
        current = current[key].message;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }

  const stickerMessage = current?.stickerMessage;
  if (!stickerMessage || typeof stickerMessage !== 'object') return null;
  if (!sawAudioStickerWrapper && !stickerMessage.audioMessage) return null;

  return {
    stickerMessage,
    audioMessage: stickerMessage.audioMessage || null
  };
}

/**
 * Faz upload separado do WebP e do OGG/Opus e envia figurinha sonora nativa
 * via fila global do QueueManager com mediatype: 'sticker'.
 */
export async function sendAudioSticker(
  sock,
  jid,
  { webpBuffer, audioBuffer, durationSeconds, isAnimated = false, emojis, quoted } = {}
) {
  installAudioStickerProto();

  const rawSock = sock?._rawSock || sock;
  if (!rawSock || typeof rawSock.waUploadToServer !== 'function' || typeof rawSock.relayMessage !== 'function') {
    throw new Error('Socket inválido: waUploadToServer e relayMessage são obrigatórios para sendAudioSticker');
  }
  if (!jid) {
    throw new Error('JID de destino é obrigatório para sendAudioSticker');
  }

  const stickerPart = await prepareWAMessageMedia(
    { sticker: webpBuffer },
    { upload: rawSock.waUploadToServer, logger: rawSock.logger }
  );

  const audioPart = await prepareWAMessageMedia(
    {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: false,
      seconds: Math.max(1, Math.round(durationSeconds || 1))
    },
    { upload: rawSock.waUploadToServer, logger: rawSock.logger }
  );

  const audioMessage = proto.Message.AudioMessage.toObject(audioPart.audioMessage);
  // O WhatsApp exige AudioMessage embutido sem o campo ptt de nota de voz
  delete audioMessage.ptt;

  const stickerMessage = {
    ...proto.Message.StickerMessage.toObject(stickerPart.stickerMessage),
    width: 512,
    height: 512,
    isAnimated: Boolean(isAnimated),
    accessibilityLabel: '',
    audioMessage
  };

  const normalizedEmojis = Array.isArray(emojis) ? emojis.join('') : emojis;
  if (typeof normalizedEmojis === 'string' && normalizedEmojis.length > 0) {
    stickerMessage.emojis = normalizedEmojis;
  }

  // normalizeMessageContent do Baileys não desembrulha audioStickerMessage; aplicamos quoted
  // primeiro sobre stickerMessage para que contextInfo seja preservado dentro do wrapper.
  let finalStickerMessage = stickerMessage;
  if (quoted?.key && quoted?.message) {
    const quotedBase = generateWAMessageFromContent(
      jid,
      { stickerMessage },
      { userJid: rawSock.user?.id, quoted }
    );
    finalStickerMessage = quotedBase.message.stickerMessage;
  }

  const msgPayload = {
    audioStickerMessage: {
      message: {
        stickerMessage: finalStickerMessage
      }
    }
  };

  const fullMsg = generateWAMessageFromContent(jid, msgPayload, {
    userJid: rawSock.user?.id
  });

  return new Promise((resolve, reject) => {
    queueManager.enqueueMessage(jid, async () => {
      try {
        // getMediaType do Baileys retorna undefined para audioStickerMessage; forçamos mediatype: 'sticker'
        await rawSock.relayMessage(jid, fullMsg.message, {
          messageId: fullMsg.key.id,
          additionalAttributes: { mediatype: 'sticker' }
        });
        resolve(fullMsg);
      } catch (err) {
        reject(err);
      }
    });
  });
}
