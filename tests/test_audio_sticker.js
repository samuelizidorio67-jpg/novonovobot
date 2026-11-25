import assert from 'assert';
import { proto } from '@whiskeysockets/baileys';
import { queueManager } from '../src/queue/QueueManager.js';
import {
  installAudioStickerProto,
  unwrapAudioStickerMessage,
  sendAudioSticker
} from '../src/utils/audioStickerProto.js';

console.log('🧪 Iniciando testes do módulo audioStickerProto...');

// 1. Guarda idempotente e encode/decode protobuf de audioStickerMessage (134) + StickerMessage (24, 25, 26)
installAudioStickerProto();
installAudioStickerProto();

const samplePayload = {
  audioStickerMessage: {
    message: {
      stickerMessage: {
        url: 'https://mmg.whatsapp.net/s',
        mimetype: 'image/webp',
        width: 512,
        height: 512,
        isAnimated: true,
        premium: true,
        emojis: '🔥',
        audioMessage: {
          url: 'https://mmg.whatsapp.net/a',
          mimetype: 'audio/ogg; codecs=opus',
          seconds: 4
        }
      }
    }
  }
};

const encoded = proto.Message.encode(samplePayload).finish();
const decoded = proto.Message.decode(encoded);
const decodedUint8 = proto.Message.decode(new Uint8Array(encoded));
const decodedDelimited = proto.Message.decodeDelimited(
  proto.Message.encodeDelimited(samplePayload).finish()
);

for (const msg of [decoded, decodedUint8, decodedDelimited]) {
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.url, 'https://mmg.whatsapp.net/s');
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.mimetype, 'image/webp');
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.width, 512);
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.height, 512);
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.isAnimated, true);
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.premium, true);
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.emojis, '🔥');
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.audioMessage?.url, 'https://mmg.whatsapp.net/a');
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
  assert.strictEqual(msg.audioStickerMessage?.message?.stickerMessage?.audioMessage?.seconds, 4);
}

// 2. Roundtrip fromObject / toObject / verify e múltiplos campos + wrappers
assert.strictEqual(proto.Message.verify(samplePayload), null);
assert(
  proto.Message.verify({ audioStickerMessage: { message: { stickerMessage: { premium: 'nao-bool' } } } })?.includes('premium'),
  'verify deve rejeitar premium não booleano'
);
assert(
  proto.Message.verify({ audioStickerMessage: { message: { stickerMessage: { emojis: 123 } } } })?.includes('emojis'),
  'verify deve rejeitar emojis não string'
);
assert(
  proto.Message.verify({ audioStickerMessage: { message: { stickerMessage: { audioMessage: { seconds: 'invalido' } } } } })?.includes('audioMessage'),
  'verify deve validar audioMessage aninhado'
);

const fromObj = proto.Message.fromObject(samplePayload);
assert(fromObj instanceof proto.Message);
assert(fromObj.audioStickerMessage instanceof proto.Message.FutureProofMessage);
assert(fromObj.audioStickerMessage.message.stickerMessage instanceof proto.Message.StickerMessage);
assert(fromObj.audioStickerMessage.message.stickerMessage.audioMessage instanceof proto.Message.AudioMessage);

const roundtripFromObj = proto.Message.decode(proto.Message.encode(fromObj).finish());
const plainObj = proto.Message.toObject(roundtripFromObj, { oneofs: true });
assert.strictEqual(plainObj._audioStickerMessage, 'audioStickerMessage');
assert.strictEqual(plainObj.audioStickerMessage.message.stickerMessage.emojis, '🔥');
assert.strictEqual(plainObj.audioStickerMessage.message.stickerMessage.premium, true);
assert.strictEqual(plainObj.audioStickerMessage.message.stickerMessage._emojis, 'emojis');
assert.strictEqual(plainObj.audioStickerMessage.message.stickerMessage._audioMessage, 'audioMessage');
assert.strictEqual(plainObj.audioStickerMessage.message.stickerMessage.audioMessage.seconds, 4);

// Decode combinado: ephemeralMessage + messageContextInfo + contextInfo em StickerMessage
const wrappedMultiPayload = proto.Message.fromObject({
  ephemeralMessage: {
    message: {
      audioStickerMessage: {
        message: {
          stickerMessage: {
            url: 'https://mmg.whatsapp.net/s2',
            mimetype: 'image/webp',
            width: 512,
            height: 512,
            isAnimated: false,
            emojis: '🎧',
            contextInfo: {
              stanzaId: 'CTX_ID_1'
            },
            audioMessage: {
              url: 'https://mmg.whatsapp.net/a2',
              mimetype: 'audio/ogg; codecs=opus',
              seconds: 7
            }
          }
        }
      },
      messageContextInfo: {
        deviceListMetadataVersion: 2
      }
    }
  }
});
const decodedMulti = proto.Message.decode(proto.Message.encode(wrappedMultiPayload).finish());
const innerEphemeral = decodedMulti.ephemeralMessage.message;
assert.strictEqual(innerEphemeral.messageContextInfo.deviceListMetadataVersion, 2);
assert.strictEqual(innerEphemeral.audioStickerMessage.message.stickerMessage.contextInfo.stanzaId, 'CTX_ID_1');
assert.strictEqual(innerEphemeral.audioStickerMessage.message.stickerMessage.emojis, '🎧');
assert.strictEqual(innerEphemeral.audioStickerMessage.message.stickerMessage.audioMessage.seconds, 7);

// 3. unwrapAudioStickerMessage
const unwrapped = unwrapAudioStickerMessage(decoded);
assert(unwrapped !== null, 'unwrapAudioStickerMessage deve extrair audioStickerMessage decodificado');
assert.strictEqual(unwrapped.stickerMessage.emojis, '🔥');
assert.strictEqual(unwrapped.audioMessage.seconds, 4);

const unwrappedFromEphemeral = unwrapAudioStickerMessage(decodedMulti);
assert(unwrappedFromEphemeral !== null, 'unwrapAudioStickerMessage deve desembrulhar wrappers externos');
assert.strictEqual(unwrappedFromEphemeral.stickerMessage.emojis, '🎧');
assert.strictEqual(unwrappedFromEphemeral.audioMessage.seconds, 7);

const unwrappedWithoutAudio = unwrapAudioStickerMessage({
  audioStickerMessage: {
    message: {
      stickerMessage: { url: 'https://mmg.whatsapp.net/s-only' }
    }
  }
});
assert(unwrappedWithoutAudio !== null);
assert.strictEqual(unwrappedWithoutAudio.stickerMessage.url, 'https://mmg.whatsapp.net/s-only');
assert.strictEqual(unwrappedWithoutAudio.audioMessage, null);

assert.strictEqual(unwrapAudioStickerMessage({ stickerMessage: { url: 'https://mmg.whatsapp.net/plain' } }), null);
assert.strictEqual(unwrapAudioStickerMessage({ conversation: 'ola' }), null);
assert.strictEqual(unwrapAudioStickerMessage(null), null);

// 4. sendAudioSticker com socket mockado encapsulado pelo QueueManager
const origMinDelay = queueManager.minDelay;
const origMaxDelay = queueManager.maxDelay;
const origEnqueue = queueManager.enqueueMessage.bind(queueManager);

try {
  queueManager.minDelay = 0;
  queueManager.maxDelay = 0;

  const enqueueCalls = [];
  queueManager.enqueueMessage = (chatJid, sendFn, priority) => {
    enqueueCalls.push({ chatJid, priority });
    return origEnqueue(chatJid, sendFn, priority);
  };

  const uploads = [];
  const relayed = [];
  const mockRawSock = {
    user: { id: '5511999999999:1@s.whatsapp.net' },
    waUploadToServer: async (filePath, uploadOpts) => {
      uploads.push({ filePath, uploadOpts });
      if (uploadOpts.mediaType === 'sticker') {
        return { mediaUrl: 'https://mmg.whatsapp.net/sticker', directPath: '/v/sticker' };
      }
      return { mediaUrl: 'https://mmg.whatsapp.net/audio', directPath: '/v/audio' };
    },
    relayMessage: async (jid, message, options) => {
      relayed.push({ jid, message, options });
      return options.messageId;
    }
  };

  const wrappedSock = queueManager.wrapSocket(mockRawSock);
  const targetJid = '5511888888888@s.whatsapp.net';

  const sentMsg = await sendAudioSticker(wrappedSock, targetJid, {
    webpBuffer: Buffer.from('RIFF\x00\x00\x00\x00WEBP'),
    audioBuffer: Buffer.from('OggS\x00\x02'),
    durationSeconds: 4.4,
    isAnimated: true,
    emojis: '🎵',
    quoted: {
      key: { remoteJid: targetJid, id: 'QUOTED_1', fromMe: false },
      message: { conversation: 'manda figurinha' }
    }
  });

  assert(sentMsg?.key?.id, 'sendAudioSticker deve retornar fullMsg com key.id');
  assert.strictEqual(uploads.length, 2, 'Deve fazer upload separado do sticker e do áudio');
  assert.strictEqual(uploads[0].uploadOpts.mediaType, 'sticker');
  assert.strictEqual(uploads[1].uploadOpts.mediaType, 'audio');
  assert.strictEqual(enqueueCalls.length, 1, 'Deve passar por queueManager.enqueueMessage');
  assert.strictEqual(enqueueCalls[0].chatJid, targetJid);

  assert.strictEqual(relayed.length, 1);
  assert.strictEqual(relayed[0].jid, targetJid);
  assert.strictEqual(relayed[0].options.messageId, sentMsg.key.id);
  assert.deepStrictEqual(relayed[0].options.additionalAttributes, { mediatype: 'sticker' });

  // Roundtrip wire bytes do payload efetivamente enviado ao relayMessage
  const wireDecoded = proto.Message.decode(proto.Message.encode(relayed[0].message).finish());
  const sm = wireDecoded.audioStickerMessage?.message?.stickerMessage;
  assert(sm, 'Payload enviado deve decodificar stickerMessage dentro de audioStickerMessage');
  assert.strictEqual(sm.url, 'https://mmg.whatsapp.net/sticker');
  assert.strictEqual(sm.directPath, '/v/sticker');
  assert.strictEqual(sm.mimetype, 'image/webp');
  assert.strictEqual(sm.width, 512);
  assert.strictEqual(sm.height, 512);
  assert.strictEqual(sm.isAnimated, true);
  assert.strictEqual(sm.accessibilityLabel, '');
  assert.strictEqual(sm.emojis, '🎵');
  assert.strictEqual(sm.contextInfo?.stanzaId, 'QUOTED_1');
  assert.strictEqual(sm.contextInfo?.quotedMessage?.conversation, 'manda figurinha');
  assert.strictEqual(sm.audioMessage?.url, 'https://mmg.whatsapp.net/audio');
  assert.strictEqual(sm.audioMessage?.directPath, '/v/audio');
  assert.strictEqual(sm.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
  assert.strictEqual(sm.audioMessage?.seconds, 4);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sm.audioMessage, 'ptt'), false, 'audioMessage não deve enviar ptt');
  assert.strictEqual(sm.audioMessage?.ptt, null);

  // Envio sem emojis, sem quoted, duração mínima = 1 e isAnimated = false
  const sentSimple = await sendAudioSticker(mockRawSock, targetJid, {
    webpBuffer: Buffer.from('RIFF\x00\x00\x00\x00WEBP'),
    audioBuffer: Buffer.from('OggS\x00\x02'),
    durationSeconds: 0.2,
    isAnimated: false
  });
  assert(sentSimple?.key?.id);
  assert.strictEqual(relayed.length, 2);
  const wireSimple = proto.Message.decode(proto.Message.encode(relayed[1].message).finish());
  const smSimple = wireSimple.audioStickerMessage.message.stickerMessage;
  assert.strictEqual(smSimple.isAnimated, false);
  assert.strictEqual(smSimple.emojis, null);
  assert.strictEqual(smSimple.audioMessage.seconds, 1);

  // Propagação de erro do relayMessage
  const failingSock = {
    user: { id: '5511999999999:1@s.whatsapp.net' },
    waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/v/x' }),
    relayMessage: async () => {
      throw new Error('RELAY_FAIL');
    }
  };
  await assert.rejects(
    () => sendAudioSticker(failingSock, targetJid, {
      webpBuffer: Buffer.from('RIFF\x00\x00\x00\x00WEBP'),
      audioBuffer: Buffer.from('OggS\x00\x02'),
      durationSeconds: 2,
      isAnimated: false
    }),
    /RELAY_FAIL/
  );
} finally {
  queueManager.minDelay = origMinDelay;
  queueManager.maxDelay = origMaxDelay;
  queueManager.enqueueMessage = origEnqueue;
}

console.log('✅ Todos os testes de audioStickerProto passaram com sucesso!');
