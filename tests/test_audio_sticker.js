import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import { proto } from '@whiskeysockets/baileys';
import { queueManager } from '../src/queue/QueueManager.js';
import {
  installAudioStickerProto,
  unwrapAudioStickerMessage,
  sendAudioSticker
} from '../src/utils/audioStickerProto.js';
import {
  probeMediaInfo,
  extractOggOpusAudio,
  convertVideoToSoundStickerWebp,
  convertImageToSoundStickerWebp
} from '../src/utils/audioStickerMedia.js';

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

console.log('🧪 Iniciando testes do módulo audioStickerMedia (FFmpeg)...');

const execFileAsync = promisify(execFile);

function assertIsWebpBuffer(buf, label) {
  assert(Buffer.isBuffer(buf), `${label}: resultado deve ser Buffer`);
  assert(buf.length > 12, `${label}: Buffer WebP deve ter mais que 12 bytes`);
  assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${label}: cabeçalho deve iniciar com RIFF`);
  assert.strictEqual(buf.subarray(8, 12).toString('ascii'), 'WEBP', `${label}: assinatura deve conter WEBP`);
}

const tmpDir = os.tmpdir();
const testSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const videoWithAudioPath = path.join(tmpDir, `test-stickersom-av-${testSuffix}.mp4`);
const silentVideoPath = path.join(tmpDir, `test-stickersom-silent-${testSuffix}.mp4`);
const audio12sPath = path.join(tmpDir, `test-stickersom-audio12s-${testSuffix}.mp3`);
const imagePngPath = path.join(tmpDir, `test-stickersom-img-${testSuffix}.png`);
const probedOggPath = path.join(tmpDir, `test-stickersom-extracted-${testSuffix}.ogg`);
const probedAudioOnlyOggPath = path.join(tmpDir, `test-stickersom-audioonly-${testSuffix}.ogg`);

try {
  // Gera vídeo MP4 de 7 s com vídeo (320x240) + áudio (440 Hz)
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=7',
    '-f', 'lavfi', '-i', 'sine=f=440:d=7',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    videoWithAudioPath
  ]);

  // Gera vídeo MP4 mudo de 3 s (320x240 sem áudio)
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    silentVideoPath
  ]);

  // Gera áudio MP3 de 12 s para validar limite padrão de 10 s
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'sine=f=523:d=12',
    '-c:a', 'libmp3lame',
    audio12sPath
  ]);

  // Gera imagem PNG sintética (640x360) para testar proporção 512x512
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=1',
    '-frames:v', '1',
    imagePngPath
  ]);

  // 1. probeMediaInfo em vídeo com áudio (~7s), vídeo mudo (~3s) e áudio puro (~12s)
  const avInfo = await probeMediaInfo(videoWithAudioPath);
  assert.strictEqual(avInfo.hasVideo, true, 'Vídeo com áudio deve ter hasVideo=true');
  assert.strictEqual(avInfo.hasAudio, true, 'Vídeo com áudio deve ter hasAudio=true');
  assert(
    avInfo.durationSeconds >= 6.5 && avInfo.durationSeconds <= 7.5,
    `Duração esperada ~7s, obtida: ${avInfo.durationSeconds}`
  );

  const silentInfo = await probeMediaInfo(silentVideoPath);
  assert.strictEqual(silentInfo.hasVideo, true, 'Vídeo mudo deve ter hasVideo=true');
  assert.strictEqual(silentInfo.hasAudio, false, 'Vídeo mudo deve ter hasAudio=false');
  assert(
    silentInfo.durationSeconds >= 2.5 && silentInfo.durationSeconds <= 3.5,
    `Duração esperada ~3s, obtida: ${silentInfo.durationSeconds}`
  );

  const audioOnlyInfo = await probeMediaInfo(audio12sPath);
  assert.strictEqual(audioOnlyInfo.hasVideo, false, 'Áudio puro deve ter hasVideo=false');
  assert.strictEqual(audioOnlyInfo.hasAudio, true, 'Áudio puro deve ter hasAudio=true');
  assert(
    audioOnlyInfo.durationSeconds >= 11.5 && audioOnlyInfo.durationSeconds <= 12.5,
    `Duração esperada ~12s, obtida: ${audioOnlyInfo.durationSeconds}`
  );

  // 2. extractOggOpusAudio: vídeo com áudio limitado a 5s e áudio puro limitado ao padrão 10s
  const oggBuffer = await extractOggOpusAudio(videoWithAudioPath, 5);
  assert(Buffer.isBuffer(oggBuffer), 'extractOggOpusAudio deve retornar Buffer');
  assert(oggBuffer.length > 0, 'extractOggOpusAudio deve retornar Buffer não vazio');
  assert.strictEqual(oggBuffer.subarray(0, 4).toString('ascii'), 'OggS', 'Áudio extraído deve começar com OggS');

  fs.writeFileSync(probedOggPath, oggBuffer);
  const oggInfo = await probeMediaInfo(probedOggPath);
  assert.strictEqual(oggInfo.hasAudio, true, 'OGG extraído deve possuir faixa de áudio');
  assert.strictEqual(oggInfo.hasVideo, false, 'OGG extraído não deve possuir faixa de vídeo');
  assert(oggInfo.durationSeconds <= 5.5, `OGG extraído deve respeitar limite de 5s (obtido ${oggInfo.durationSeconds})`);

  const oggAudioOnly = await extractOggOpusAudio(audio12sPath);
  assert.strictEqual(oggAudioOnly.subarray(0, 4).toString('ascii'), 'OggS');
  fs.writeFileSync(probedAudioOnlyOggPath, oggAudioOnly);
  const oggAudioOnlyInfo = await probeMediaInfo(probedAudioOnlyOggPath);
  assert(
    oggAudioOnlyInfo.durationSeconds >= 9.5 && oggAudioOnlyInfo.durationSeconds <= 10.5,
    `OGG de áudio puro deve respeitar limite padrão de 10s (obtido ${oggAudioOnlyInfo.durationSeconds})`
  );

  // 3. extractOggOpusAudio em vídeo mudo deve rejeitar com NO_AUDIO_STREAM
  await assert.rejects(
    () => extractOggOpusAudio(silentVideoPath, 5),
    (err) => err instanceof Error && err.message.includes('NO_AUDIO_STREAM')
  );

  // 4. convertVideoToSoundStickerWebp: WebP válido <= 490000 bytes
  const animWebp = await convertVideoToSoundStickerWebp(videoWithAudioPath, 5);
  assertIsWebpBuffer(animWebp, 'convertVideoToSoundStickerWebp');
  assert(animWebp.length <= 490000, `WebP animado deve ter <= 490000 bytes (obtido ${animWebp.length})`);

  // 5. convertImageToSoundStickerWebp: WebP válido <= 450*1024 bytes
  const staticWebp = await convertImageToSoundStickerWebp(imagePngPath);
  assertIsWebpBuffer(staticWebp, 'convertImageToSoundStickerWebp');
  assert(staticWebp.length <= 490000, `WebP estático deve ter <= 490000 bytes (obtido ${staticWebp.length})`);

  // 6. Nenhum temporário vazado pelo processo atual
  const leaked = fs.readdirSync(tmpDir).filter((name) => name.startsWith('stickersom-') && name.includes(`-${process.pid}-`));
  assert.deepStrictEqual(leaked, [], `Arquivos temporários vazados em os.tmpdir(): ${leaked.join(', ')}`);

  console.log('✅ Todos os testes de audioStickerMedia passaram com sucesso!');
} finally {
  for (const filePath of [
    videoWithAudioPath,
    silentVideoPath,
    audio12sPath,
    imagePngPath,
    probedOggPath,
    probedAudioOnlyOggPath
  ]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}
