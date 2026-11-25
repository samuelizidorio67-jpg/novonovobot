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
import { unwrapMessageContent } from '../src/utils/viewOnceManager.js';
import {
  extractSoundStickerSources,
  extractUnstickerSource,
  processSoundStickerSources,
  processUnsticker,
  handleMediaCommands
} from '../src/commands/media.js';
import { handleMessages } from '../src/messageHandler.js';
import { CATEGORIAS, comandosDoMenu, buildMenu, buildLegendaMenu } from '../src/config/menu.js';

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

  console.log('🧪 Iniciando testes da Task 3 (/stickersom, /unsticker, unwrapMessageContent, menu e dispatcher)...');

  // 1. unwrapMessageContent com audioStickerMessage expõe stickerMessage
  const unwrappedMsgContent = unwrapMessageContent({
    audioStickerMessage: {
      message: {
        stickerMessage: { isAnimated: true }
      }
    }
  });
  assert.strictEqual(unwrappedMsgContent.isViewOnce, false);
  assert.strictEqual(unwrappedMsgContent.content?.stickerMessage?.isAnimated, true);

  const testChatJid = '120363040000000777@g.us';
  const testSenderJid = '5571999999888@s.whatsapp.net';

  // 2. extractSoundStickerSources: todas as validações e modos
  const voDirectRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'VO_DIRECT' },
    message: {
      viewOnceMessageV2: {
        message: {
          videoMessage: { caption: '/stickersom', seconds: 4 }
        }
      }
    }
  });
  assert.deepStrictEqual(voDirectRes, { error: 'VIEWONCE' });

  const voQuotedRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'VO_QUOTED' },
    message: {
      imageMessage: {
        caption: '/stickersom',
        contextInfo: {
          stanzaId: 'VO_AUDIO_1',
          quotedMessage: {
            viewOnceMessageV2: {
              message: { audioMessage: { seconds: 3 } }
            }
          }
        }
      }
    }
  });
  assert.deepStrictEqual(voQuotedRes, { error: 'VIEWONCE' });

  const noneRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'NO_MEDIA' },
    message: { conversation: '/stickersom' }
  });
  assert.deepStrictEqual(noneRes, { error: 'NONE' });

  const textQuotingAudioRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'TEXT_AUDIO' },
    message: {
      extendedTextMessage: {
        text: '/stickersom',
        contextInfo: {
          stanzaId: 'AUD_ONLY_1',
          quotedMessage: { audioMessage: { seconds: 3 } }
        }
      }
    }
  });
  assert.deepStrictEqual(textQuotingAudioRes, { error: 'NONE' });

  const tooLongDirectRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'LONG_DIRECT' },
    message: {
      videoMessage: { caption: '/stickersom', seconds: 20 }
    }
  });
  assert.deepStrictEqual(tooLongDirectRes, { error: 'VIDEO_TOO_LONG' });

  const tooLongQuotedRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'LONG_QUOTED' },
    message: {
      extendedTextMessage: {
        text: '/stickersom',
        contextInfo: {
          stanzaId: 'LONG_VID_1',
          quotedMessage: { videoMessage: { seconds: 20 } }
        }
      }
    }
  });
  assert.deepStrictEqual(tooLongQuotedRes, { error: 'VIDEO_TOO_LONG' });

  const needAudioNonAudioRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'IMG_TEXT' },
    message: {
      imageMessage: {
        caption: '/stickersom',
        contextInfo: {
          stanzaId: 'TXT_1',
          quotedMessage: { conversation: 'isso não é áudio' }
        }
      }
    }
  });
  assert.deepStrictEqual(needAudioNonAudioRes, { error: 'NEED_AUDIO' });

  const needAudioNoQuoteRes = extractSoundStickerSources({
    key: { remoteJid: testChatJid, id: 'IMG_NO_QUOTE' },
    message: {
      imageMessage: { caption: '/stickersom' }
    }
  });
  assert.deepStrictEqual(needAudioNoQuoteRes, { error: 'NEED_AUDIO' });

  const imgAudioMsg = {
    key: { remoteJid: testChatJid, id: 'IMG_AUD_1' },
    message: {
      ephemeralMessage: {
        message: {
          imageMessage: {
            caption: '/stickersom',
            url: 'https://mmg.whatsapp.net/img',
            contextInfo: {
              stanzaId: 'QUOTED_AUD_1',
              participant: testSenderJid,
              quotedMessage: {
                audioMessage: {
                  url: 'https://mmg.whatsapp.net/aud',
                  seconds: 6
                }
              }
            }
          }
        }
      }
    }
  };
  const imgAudioRes = extractSoundStickerSources(imgAudioMsg);
  assert.strictEqual(imgAudioRes.mode, 'image_audio');
  assert.strictEqual(imgAudioRes.imageMsg.message.imageMessage.url, 'https://mmg.whatsapp.net/img');
  assert.strictEqual(imgAudioRes.audioMsg.key.id, 'QUOTED_AUD_1');
  assert.strictEqual(imgAudioRes.audioMsg.key.participant, testSenderJid);
  assert.strictEqual(imgAudioRes.audioMsg.message.audioMessage.url, 'https://mmg.whatsapp.net/aud');

  const directVideoMsg = {
    key: { remoteJid: testChatJid, id: 'VID_DIRECT' },
    message: {
      videoMessage: { caption: '/stickersom', seconds: 8, url: 'https://mmg.whatsapp.net/v1' }
    }
  };
  const directVideoRes = extractSoundStickerSources(directVideoMsg);
  assert.strictEqual(directVideoRes.mode, 'video');
  assert.strictEqual(directVideoRes.videoMsg.message.videoMessage.url, 'https://mmg.whatsapp.net/v1');

  const quotedVideoMsg = {
    key: { remoteJid: testChatJid, id: 'VID_QUOTED_CMD' },
    message: {
      extendedTextMessage: {
        text: '/stickersom',
        contextInfo: {
          stanzaId: 'VID_QUOTED_1',
          participant: testSenderJid,
          quotedMessage: {
            videoMessage: { seconds: 5, url: 'https://mmg.whatsapp.net/v2' }
          }
        }
      }
    }
  };
  const quotedVideoRes = extractSoundStickerSources(quotedVideoMsg);
  assert.strictEqual(quotedVideoRes.mode, 'video');
  assert.strictEqual(quotedVideoRes.videoMsg.key.id, 'VID_QUOTED_1');
  assert.strictEqual(quotedVideoRes.videoMsg.message.videoMessage.url, 'https://mmg.whatsapp.net/v2');

  // 3. handleMediaCommands(..., 'stickersom', ...) respostas aviso nas validações
  const cmdSent = [];
  const cmdSock = {
    sendMessage: async (jid, content, options) => {
      cmdSent.push({ jid, content, options });
      return { key: { id: `CMD_SENT_${cmdSent.length}` } };
    }
  };

  for (const [label, msgCase, expectedPattern] of [
    ['sem mídia', { key: { remoteJid: testChatJid, id: 'C_NONE' }, message: { conversation: '/stickersom' } }, /^⚠️/],
    ['viewOnce', {
      key: { remoteJid: testChatJid, id: 'C_VO' },
      message: { viewOnceMessageV2: { message: { videoMessage: { caption: '/stickersom', seconds: 4 } } } }
    }, /\/ver/],
    ['vídeo > 15s', {
      key: { remoteJid: testChatJid, id: 'C_LONG' },
      message: { videoMessage: { caption: '/stickersom', seconds: 20 } }
    }, /15/],
    ['imagem sem áudio', {
      key: { remoteJid: testChatJid, id: 'C_NEED_AUD' },
      message: {
        imageMessage: {
          caption: '/stickersom',
          contextInfo: { stanzaId: 'T_1', quotedMessage: { conversation: 'texto' } }
        }
      }
    }, /áudio/i]
  ]) {
    cmdSent.length = 0;
    await handleMediaCommands(cmdSock, msgCase, 'stickersom', [], testSenderJid);
    assert.strictEqual(cmdSent.length, 1, `${label}: deve enviar exatamente 1 resposta`);
    assert(cmdSent[0].content.text.startsWith('⚠️'), `${label}: resposta deve ser aviso (⚠️), recebido: ${cmdSent[0].content.text}`);
    assert(expectedPattern.test(cmdSent[0].content.text), `${label}: texto inesperado: ${cmdSent[0].content.text}`);
  }

  // 4. Fluxo completo processSoundStickerSources (vídeo c/ áudio, vídeo mudo NO_AUDIO_STREAM, imagem+áudio e limpeza em finally)
  const animWebpFixturePath = path.join(tmpDir, `test-stickersom-anim-fix-${testSuffix}.webp`);
  const staticWebpFixturePath = path.join(tmpDir, `test-stickersom-static-fix-${testSuffix}.webp`);
  fs.writeFileSync(animWebpFixturePath, animWebp);
  fs.writeFileSync(staticWebpFixturePath, staticWebp);

  const origDelayMin = queueManager.minDelay;
  const origDelayMax = queueManager.maxDelay;
  try {
    queueManager.minDelay = 0;
    queueManager.maxDelay = 0;

    const createCopyDownloader = (fixtureMap) => {
      const createdCopies = [];
      const downloader = async (mediaMsg, mediaType) => {
        const srcPath = fixtureMap[mediaType];
        const copyPath = path.join(tmpDir, `test-dl-${mediaType}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${path.extname(srcPath)}`);
        fs.copyFileSync(srcPath, copyPath);
        createdCopies.push(copyPath);
        return copyPath;
      };
      return { downloader, createdCopies };
    };

    const flowSent = [];
    const flowRelayed = [];
    const flowRawSock = {
      user: { id: '5511999999999:1@s.whatsapp.net' },
      sendMessage: async (jid, content, options) => {
        flowSent.push({ jid, content, options });
        return { key: { id: `FLOW_${flowSent.length}` } };
      },
      waUploadToServer: async (filePath, opts) => ({
        mediaUrl: `https://mmg.whatsapp.net/${opts.mediaType}`,
        directPath: `/v/${opts.mediaType}`
      }),
      relayMessage: async (jid, message, options) => {
        flowRelayed.push({ jid, message, options });
        return options.messageId;
      }
    };
    const flowSock = queueManager.wrapSocket(flowRawSock);

    // 4a. Vídeo com áudio (7s -> cortado em 5s, isAnimated: true)
    const avDl = createCopyDownloader({ video: videoWithAudioPath });
    await processSoundStickerSources(
      flowSock,
      testChatJid,
      directVideoMsg,
      { mode: 'video', videoMsg: directVideoMsg },
      avDl.downloader
    );
    assert.strictEqual(flowRelayed.length, 1, 'Vídeo com áudio deve enviar 1 audioStickerMessage');
    const avDecoded = proto.Message.decode(proto.Message.encode(flowRelayed[0].message).finish());
    assert.strictEqual(avDecoded.audioStickerMessage?.message?.stickerMessage?.isAnimated, true);
    assert.strictEqual(avDecoded.audioStickerMessage?.message?.stickerMessage?.audioMessage?.seconds, 5);
    assert(avDl.createdCopies.every((p) => !fs.existsSync(p)), 'Arquivo temporário de vídeo deve ser removido no finally');

    // 4b. Vídeo mudo (NO_AUDIO_STREAM -> aviso orientando usar /sticker)
    flowSent.length = 0;
    flowRelayed.length = 0;
    const silentDl = createCopyDownloader({ video: silentVideoPath });
    await processSoundStickerSources(
      flowSock,
      testChatJid,
      directVideoMsg,
      { mode: 'video', videoMsg: directVideoMsg },
      silentDl.downloader
    );
    assert.strictEqual(flowRelayed.length, 0, 'Vídeo mudo não deve enviar audioStickerMessage');
    const lastSilentMsg = flowSent[flowSent.length - 1]?.content?.text || '';
    assert(lastSilentMsg.startsWith('⚠️'), `Vídeo mudo deve responder aviso (⚠️), obtido: ${lastSilentMsg}`);
    assert(lastSilentMsg.includes('/sticker'), `Vídeo mudo deve orientar a usar /sticker, obtido: ${lastSilentMsg}`);
    assert(silentDl.createdCopies.every((p) => !fs.existsSync(p)), 'Arquivo temporário de vídeo mudo deve ser removido no finally');

    // 4c. Imagem + áudio citado (12s -> cortado em 10s, isAnimated: false)
    flowSent.length = 0;
    flowRelayed.length = 0;
    const imgAudDl = createCopyDownloader({ image: imagePngPath, audio: audio12sPath });
    await processSoundStickerSources(
      flowSock,
      testChatJid,
      imgAudioMsg,
      imgAudioRes,
      imgAudDl.downloader
    );
    assert.strictEqual(flowRelayed.length, 1, 'Imagem + áudio deve enviar 1 audioStickerMessage');
    const imgAudDecoded = proto.Message.decode(proto.Message.encode(flowRelayed[0].message).finish());
    assert.strictEqual(imgAudDecoded.audioStickerMessage?.message?.stickerMessage?.isAnimated, false);
    assert.strictEqual(imgAudDecoded.audioStickerMessage?.message?.stickerMessage?.audioMessage?.seconds, 10);
    assert(imgAudDl.createdCopies.every((p) => !fs.existsSync(p)), 'Arquivos temporários de imagem e áudio devem ser removidos no finally');

    // 5. Suporte do /unsticker para audioStickerMessage recebida
    const quotedAudioStickerMsg = {
      key: { remoteJid: testChatJid, id: 'UNSTICKER_CMD_1' },
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: '/unsticker',
              contextInfo: {
                stanzaId: 'AS_QUOTED_1',
                participant: testSenderJid,
                quotedMessage: {
                  audioStickerMessage: {
                    message: {
                      stickerMessage: {
                        url: 'https://mmg.whatsapp.net/as-anim',
                        isAnimated: true,
                        audioMessage: { url: 'https://mmg.whatsapp.net/as-aud', seconds: 4 }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    const unstickerSource = extractUnstickerSource(quotedAudioStickerMsg);
    assert(unstickerSource !== null, 'extractUnstickerSource deve aceitar audioStickerMessage recebida');
    assert.strictEqual(unstickerSource.isAnimated, true);
    assert.strictEqual(unstickerSource.stickerMessage.message.stickerMessage.url, 'https://mmg.whatsapp.net/as-anim');

    // /unsticker sem figurinha via handleMediaCommands
    cmdSent.length = 0;
    await handleMediaCommands(cmdSock, { key: { remoteJid: testChatJid, id: 'U_NONE' }, message: { conversation: '/unsticker' } }, 'unsticker', [], testSenderJid);
    assert.strictEqual(cmdSent.length, 1);
    assert(cmdSent[0].content.text.startsWith('⚠️'));

    // Conversão real de audioStickerMessage animada via processUnsticker
    const unstickerSent = [];
    const unstickerSock = {
      sendMessage: async (jid, content, options) => {
        unstickerSent.push({ jid, content, options });
        if (content.video?.url) {
          assert(fs.existsSync(content.video.url), 'Arquivo MP4 convertido deve existir durante envio');
          assert(fs.statSync(content.video.url).size > 0, 'Arquivo MP4 convertido deve ser não vazio');
        }
        if (content.image?.url) {
          assert(fs.existsSync(content.image.url), 'Arquivo PNG convertido deve existir durante envio');
          assert(fs.statSync(content.image.url).size > 0, 'Arquivo PNG convertido deve ser não vazio');
        }
        return { key: { id: `UNS_${unstickerSent.length}` } };
      }
    };

    const animUnstickerDl = createCopyDownloader({ sticker: animWebpFixturePath });
    await processUnsticker(unstickerSock, testChatJid, quotedAudioStickerMsg, unstickerSource, animUnstickerDl.downloader);
    assert(unstickerSent.some((m) => m.content.video && m.content.gifPlayback === true), '/unsticker em audioStickerMessage animada deve enviar GIF/vídeo');
    assert(animUnstickerDl.createdCopies.every((p) => !fs.existsSync(p)), 'WebP baixado no /unsticker animado deve ser limpo no finally');

    const staticAudioStickerSource = extractUnstickerSource({
      key: { remoteJid: testChatJid, id: 'UNSTICKER_CMD_2' },
      message: {
        extendedTextMessage: {
          text: '/unsticker',
          contextInfo: {
            stanzaId: 'AS_QUOTED_2',
            quotedMessage: {
              audioStickerMessage: {
                message: {
                  stickerMessage: {
                    url: 'https://mmg.whatsapp.net/as-static',
                    isAnimated: false,
                    audioMessage: { url: 'https://mmg.whatsapp.net/as-aud2', seconds: 3 }
                  }
                }
              }
            }
          }
        }
      }
    });
    assert.strictEqual(staticAudioStickerSource.isAnimated, false);
    unstickerSent.length = 0;
    const staticUnstickerDl = createCopyDownloader({ sticker: staticWebpFixturePath });
    await processUnsticker(unstickerSock, testChatJid, quotedAudioStickerMsg, staticAudioStickerSource, staticUnstickerDl.downloader);
    assert(unstickerSent.some((m) => m.content.image), '/unsticker em audioStickerMessage estática deve enviar imagem PNG');
    assert(staticUnstickerDl.createdCopies.every((p) => !fs.existsSync(p)), 'WebP baixado no /unsticker estático deve ser limpo no finally');

    // 6. Menu e Dispatcher (messageHandler.js)
    const mediaCat = CATEGORIAS.find((c) => c.titulo === 'MÍDIA & DOWNLOADS');
    assert(mediaCat, 'Categoria MÍDIA & DOWNLOADS deve existir no menu');
    assert(mediaCat.comandos.some(([cmdName]) => cmdName === 'stickersom'), 'Menu deve listar stickersom em MÍDIA & DOWNLOADS');
    assert(comandosDoMenu().includes('stickersom'), 'comandosDoMenu() deve conter stickersom');
    assert(buildMenu({ prefixo: '/', usuario: 'Tester' }).includes('/stickersom'), 'buildMenu deve incluir /stickersom');
    assert(buildLegendaMenu({ prefixo: '/', usuario: '5571999999999', saudacao: '🌅 Bom dia' }).length <= 1000, 'Legenda compacta do menu não deve estourar 1000 caracteres');

    flowSent.length = 0;
    await handleMessages(flowRawSock, {
      key: { remoteJid: testChatJid, participant: testSenderJid, id: 'DISPATCH_1' },
      pushName: 'Tester',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '/stickersom' }
    });
    assert.strictEqual(flowSent.length, 1, 'Dispatcher deve rotear /stickersom para handleMediaCommands');
    assert(flowSent[0].content.text.startsWith('⚠️'), 'Dispatcher de /stickersom sem mídia deve devolver aviso');
  } finally {
    queueManager.minDelay = origDelayMin;
    queueManager.maxDelay = origDelayMax;
    for (const extraFixture of [animWebpFixturePath, staticWebpFixturePath]) {
      try {
        if (fs.existsSync(extraFixture)) fs.unlinkSync(extraFixture);
      } catch (_) {}
    }
  }

  console.log('✅ Todos os testes da Task 3 passaram com sucesso!');
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
