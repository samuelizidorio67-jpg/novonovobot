import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { getDatabase } from '../database.js';
import { downloadWhatsAppMedia, downloadYoutubeAudio, downloadYoutubeVideo, downloadTiktokVideo, downloadTiktokAudio, downloadInstagramVideo, downloadInstagramAudio } from '../utils/helpers.js';
import { checkIfOwner, isAuthorizedForVer, isPhoneJid, resolveSenderCandidates } from './admin.js';
import { findViewOnce, downloadViewOnceFile, extractContextInfo, extractViewOnce, unwrapMessageContent } from '../utils/viewOnceManager.js';
import { installAudioStickerProto, sendAudioSticker, unwrapAudioStickerMessage } from '../utils/audioStickerProto.js';
import { probeMediaInfo, extractOggOpusAudio, convertVideoToSoundStickerWebp, convertImageToSoundStickerWebp } from '../utils/audioStickerMedia.js';
import { aviso, erro, uso } from '../config/messages.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { execFile } from 'child_process';

// Configura o caminho do ffmpeg e instala extensão WAProto para audioStickerMessage
ffmpeg.setFfmpegPath(ffmpegPath);
installAudioStickerProto();

// Função para converter WebP para PNG (com fallback via sharp para WebP animado)
async function convertWebpToPng(inputPath) {
  const outputPath = path.join(os.tmpdir(), `unsticker-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
    return outputPath;
  } catch (ffmpegErr) {
    try {
      const { default: sharp } = await import('sharp');
      await sharp(inputPath, { page: 0 }).png().toFile(outputPath);
      return outputPath;
    } catch (_) {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch (__) {}
      }
      throw ffmpegErr;
    }
  }
}

// Função para converter Vídeo em Figurinha Animada WebP (Otimizado para WhatsApp Celular)
function convertVideoToAnimatedSticker(inputPath) {
  const outputPath = path.join(os.tmpdir(), `anim-sticker-${Date.now()}.webp`);
  return new Promise((resolve, reject) => {
    // Passagem 1: 512x512, fps=10, 6s de duração, qscale=45 (Tamanho leve para celular)
    const args = [
      '-y',
      '-i', inputPath,
      '-vcodec', 'libwebp',
      '-filter_complex', '[0:v] scale=512:512:force_original_aspect_ratio=decrease,fps=10,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-loop', '0',
      '-ss', '00:00:00',
      '-t', '00:00:06',
      '-qscale', '45',
      '-preset', 'default',
      '-an',
      '-vsync', '0',
      outputPath
    ];
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      try {
        const buffer = fs.readFileSync(outputPath);
        try { fs.unlinkSync(outputPath); } catch (_) {}

        // Se por acaso exceder 480KB (limite em que o WhatsApp Mobile trava a animação), aplica passagem 2 mais leve
        if (buffer.length > 490000) {
          const pass2Path = path.join(os.tmpdir(), `anim-sticker-p2-${Date.now()}.webp`);
          const pass2Args = [
            '-y',
            '-i', inputPath,
            '-vcodec', 'libwebp',
            '-filter_complex', '[0:v] scale=384:384:force_original_aspect_ratio=decrease,fps=8,pad=384:384:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-loop', '0',
            '-ss', '00:00:00',
            '-t', '00:00:05',
            '-qscale', '35',
            '-preset', 'default',
            '-an',
            '-vsync', '0',
            pass2Path
          ];
          execFile(ffmpegPath, pass2Args, (err2) => {
            if (err2) return resolve(buffer);
            try {
              const buf2 = fs.readFileSync(pass2Path);
              try { fs.unlinkSync(pass2Path); } catch (_) {}
              resolve(buf2);
            } catch (_) {
              resolve(buffer);
            }
          });
          return;
        }

        resolve(buffer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function transcodeToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-movflags', '+faststart',
      '-filter_complex', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      outputPath
    ];
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

// Função para converter Figurinha Animada (WebP) em MP4/GIF
// FFmpeg 6.x não decodifica chunks ANIM/ANMF de WebP animado; nesses casos rasterizamos via sharp -> GIF -> MP4.
async function convertWebpToMp4(inputPath) {
  const outputPath = path.join(os.tmpdir(), `unsticker-anim-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  try {
    return await transcodeToMp4(inputPath, outputPath);
  } catch (ffmpegErr) {
    const tempGifPath = path.join(os.tmpdir(), `unsticker-anim-${Date.now()}-${Math.floor(Math.random() * 1e6)}.gif`);
    try {
      const { default: sharp } = await import('sharp');
      await sharp(inputPath, { animated: true }).gif().toFile(tempGifPath);
      return await transcodeToMp4(tempGifPath, outputPath);
    } catch (_) {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch (__) {}
      }
      throw ffmpegErr;
    } finally {
      if (fs.existsSync(tempGifPath)) {
        try { fs.unlinkSync(tempGifPath); } catch (_) {}
      }
    }
  }
}

// Detecta se a mensagem citada é de visualização única (qualquer wrapper)
function isViewOnceQuoted(quoted) {
  return Boolean(extractViewOnce(quoted));
}

// Extrai imagem (direta ou citada) para figurinha.
// Retorna { mediaMessage } ou { error: 'VIEWONCE' | 'VIDEO' | 'NONE' }.
// Mídia de visualização única é SEMPRE recusada aqui: só o /ver
// (restrito a autorizados) pode revelá-la.
export function extractStickerImage(msg) {
  const from = msg.key.remoteJid;

  if (msg.message?.imageMessage) {
    return { mediaMessage: msg };
  }
  if (msg.message?.videoMessage) {
    return { error: 'VIDEO' };
  }

  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return { error: 'NONE' };

  if (isViewOnceQuoted(quoted)) {
    return { error: 'VIEWONCE' };
  }

  if (quoted.imageMessage) {
    return {
      mediaMessage: {
        key: {
          remoteJid: from,
          id: msg.message.extendedTextMessage.contextInfo.stanzaId,
          participant: msg.message.extendedTextMessage.contextInfo.participant
        },
        message: quoted
      }
    };
  }
  if (quoted.videoMessage) {
    return { error: 'VIDEO' };
  }
  return { error: 'NONE' };
}

// Converte imagem em figurinha WebP 512x512 preservando a proporção
// (o /sticker padrão estica a imagem — por isso sai "torta").
// mode 'fit': imagem inteira, sem corte, com fundo transparente (padrão do WhatsApp).
// mode 'fill': preenche tudo (corte central), sem bordas — figurinha maior.
function convertImageToSticker(inputPath, mode = 'fit', quality = 85) {
  const outputPath = path.join(os.tmpdir(), `sticker-${mode}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.webp`);
  const vf = mode === 'fill'
    ? 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512'
    : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', vf,
      '-vcodec', 'libwebp',
      '-lossless', '0',
      '-quality', String(quality),
      '-preset', 'picture',
      '-an',
      outputPath
    ];
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      try {
        const buffer = fs.readFileSync(outputPath);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        resolve(buffer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Converte com fallback de qualidade para respeitar o limite do WhatsApp (~500KB)
export async function convertImageToStickerSized(inputPath, mode) {
  let buffer = await convertImageToSticker(inputPath, mode, 85);
  if (buffer.length > 450 * 1024) {
    buffer = await convertImageToSticker(inputPath, mode, 60);
  }
  return buffer;
}

// Converte áudio (mp3) para M4A/AAC. O WhatsApp usa AAC dentro de MP4 como
// formato nativo — é o que toca em qualquer aparelho, inclusive iPhone.
export function convertToM4a(inputPath) {
  const outputPath = path.join(os.tmpdir(), `wa-audio-${Date.now()}-${Math.floor(Math.random() * 1e6)}.m4a`);
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath
    ], (err) => (err ? reject(err) : resolve(outputPath)));
  });
}

// Envia áudio como mensagem NATIVA do WhatsApp.
// Antes o bot enviava MP3 com mimetype 'audio/mp4' (mp3 rotulado de mp4) —
// o Android às vezes tolera, o iPhone não toca. Agora o arquivo real é M4A/AAC
// com 'audio/mp4'; se a conversão falhar, envia mp3 com 'audio/mpeg' (coerente).
export async function sendAudioCompat(sock, from, filePath, title, quotedMsg) {
  const safeTitle = String(title || 'audio').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || 'audio';
  let caminho = filePath;
  let mimetype = 'audio/mpeg';
  let fileName = `${safeTitle}.mp3`;

  try {
    caminho = await convertToM4a(filePath);
    mimetype = 'audio/mp4';
    fileName = `${safeTitle}.m4a`;
  } catch (err) {
    console.warn(`⚠️ Conversão para m4a falhou, enviando mp3: ${err.message?.slice(0, 100)}`);
  }

  try {
    await sock.sendMessage(from, {
      audio: fs.readFileSync(caminho),
      mimetype,
      fileName,
      ptt: false
    }, { quoted: quotedMsg });
  } finally {
    if (caminho !== filePath && fs.existsSync(caminho)) {
      try { fs.unlinkSync(caminho); } catch (_) {}
    }
  }
}

function buildQuotedMessage(from, contextInfo, message) {
  return {
    key: {
      remoteJid: from,
      id: contextInfo.stanzaId,
      participant: contextInfo.participant
    },
    message
  };
}

/**
 * Extrai as fontes de mídia compatíveis para /stickersom:
 * 1. Bloqueia qualquer mídia de visualização única (direta ou citada)
 * 2. Vídeo direto ou citado (<= 15 s) -> { mode: 'video', videoMsg }
 * 3. Imagem direta citando áudio -> { mode: 'image_audio', imageMsg, audioMsg }
 */
export function extractSoundStickerSources(msg) {
  if (!msg?.message || typeof msg.message !== 'object') {
    return { error: 'NONE' };
  }

  const from = msg.key?.remoteJid;
  const contextInfo = extractContextInfo(msg);
  const quotedRaw = contextInfo?.quotedMessage;

  if (extractViewOnce(msg.message) || (quotedRaw && extractViewOnce(quotedRaw))) {
    return { error: 'VIEWONCE' };
  }

  const { content: directContent } = unwrapMessageContent(msg.message);
  const { content: quotedContent } = unwrapMessageContent(quotedRaw);

  if (directContent?.videoMessage) {
    if (Number(directContent.videoMessage.seconds || 0) > 15) {
      return { error: 'VIDEO_TOO_LONG' };
    }
    const videoMsg = directContent === msg.message ? msg : { ...msg, message: directContent };
    return { mode: 'video', videoMsg };
  }

  if (directContent?.imageMessage) {
    if (quotedContent?.audioMessage) {
      const imageMsg = directContent === msg.message ? msg : { ...msg, message: directContent };
      return {
        mode: 'image_audio',
        imageMsg,
        audioMsg: buildQuotedMessage(from, contextInfo, quotedContent)
      };
    }
    return { error: 'NEED_AUDIO' };
  }

  if (quotedContent?.videoMessage) {
    if (Number(quotedContent.videoMessage.seconds || 0) > 15) {
      return { error: 'VIDEO_TOO_LONG' };
    }
    return {
      mode: 'video',
      videoMsg: buildQuotedMessage(from, contextInfo, quotedContent)
    };
  }

  return { error: 'NONE' };
}

/**
 * Baixa mídias, converte áudio/WebP respeitando limites (5s vídeo, 10s imagem+áudio)
 * e envia figurinha sonora nativa garantindo remoção de temporários em finally.
 */
export async function processSoundStickerSources(
  sock,
  from,
  msg,
  sources,
  downloadFn = downloadWhatsAppMedia
) {
  const reply = async (text) => {
    await sock.sendMessage(from, { text }, { quoted: msg });
  };

  if (!sources || sources.error === 'VIEWONCE') {
    return reply(aviso('Mídia de visualização única não pode virar figurinha. Ela só pode ser revelada com o comando */ver*, que é restrito.'));
  }
  if (sources.error === 'VIDEO_TOO_LONG') {
    return reply(aviso('O vídeo deve ter no máximo *15 segundos* para virar figurinha com som.'));
  }
  if (sources.error === 'NEED_AUDIO') {
    return reply(aviso('Para criar figurinha com som usando uma imagem, responda a um áudio enviando a imagem com */stickersom* na legenda.'));
  }
  if (sources.error || !sources.mode) {
    return reply(aviso('Envie ou responda a um vídeo curto com */stickersom*, ou responda a um áudio enviando uma imagem com */stickersom* na legenda.'));
  }

  await reply('⏳ Criando sua figurinha com som, aguarde...');

  const tempFiles = [];
  try {
    if (sources.mode === 'video') {
      const videoPath = await downloadFn(sources.videoMsg, 'video');
      tempFiles.push(videoPath);

      const mediaInfo = await probeMediaInfo(videoPath);
      if (mediaInfo.durationSeconds > 15) {
        return reply(aviso('O vídeo deve ter no máximo *15 segundos* para virar figurinha com som.'));
      }
      if (!mediaInfo.hasAudio) {
        throw new Error('NO_AUDIO_STREAM');
      }

      const audioBuffer = await extractOggOpusAudio(videoPath, 5);
      const webpBuffer = await convertVideoToSoundStickerWebp(videoPath, 5);
      const durationSeconds = mediaInfo.durationSeconds > 0
        ? Math.min(mediaInfo.durationSeconds, 5)
        : 5;

      await sendAudioSticker(sock, from, {
        webpBuffer,
        audioBuffer,
        durationSeconds,
        isAnimated: true,
        quoted: msg
      });
      return;
    }

    if (sources.mode === 'image_audio') {
      const imagePath = await downloadFn(sources.imageMsg, 'image');
      tempFiles.push(imagePath);

      const audioPath = await downloadFn(sources.audioMsg, 'audio');
      tempFiles.push(audioPath);

      const audioInfo = await probeMediaInfo(audioPath);
      if (!audioInfo.hasAudio) {
        throw new Error('NO_AUDIO_STREAM');
      }

      const audioBuffer = await extractOggOpusAudio(audioPath, 10);
      const webpBuffer = await convertImageToSoundStickerWebp(imagePath);
      const durationSeconds = audioInfo.durationSeconds > 0
        ? Math.min(audioInfo.durationSeconds, 10)
        : 10;

      await sendAudioSticker(sock, from, {
        webpBuffer,
        audioBuffer,
        durationSeconds,
        isAnimated: false,
        quoted: msg
      });
    }
  } catch (error) {
    if (error?.message === 'NO_AUDIO_STREAM' || error?.message?.includes('NO_AUDIO_STREAM')) {
      if (sources.mode === 'video') {
        return reply(aviso('Esse vídeo não possui faixa de áudio. Use */sticker* para criar uma figurinha animada sem som.'));
      }
      return reply(aviso('O áudio citado não possui uma faixa de áudio válida.'));
    }
    console.error('Erro ao criar figurinha com som:', error);
    return reply(erro('Não consegui criar a figurinha com som. Verifique se a mídia é válida e tente novamente.'));
  } finally {
    for (const filePath of tempFiles) {
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (_) {}
      }
    }
  }
}

/**
 * Extrai a figurinha citada para o comando /unsticker, incluindo
 * figurinhas sonoras encapsuladas em audioStickerMessage e wrappers externos.
 */
export function extractUnstickerSource(msg) {
  if (!msg?.message || typeof msg.message !== 'object') return null;

  const from = msg.key?.remoteJid;
  const contextInfo = extractContextInfo(msg);
  const quoted = contextInfo?.quotedMessage;
  if (!quoted || typeof quoted !== 'object') return null;

  const stickerObj =
    unwrapAudioStickerMessage(quoted)?.stickerMessage ||
    unwrapMessageContent(quoted).content?.stickerMessage;

  if (!stickerObj) return null;

  return {
    stickerMessage: buildQuotedMessage(from, contextInfo, { stickerMessage: stickerObj }),
    isAnimated: stickerObj.isAnimated === true
  };
}

/**
 * Baixa uma figurinha (comum ou audioStickerMessage), converte para GIF/MP4 ou PNG
 * e limpa os temporários em bloco finally.
 */
export async function processUnsticker(
  sock,
  from,
  msg,
  source,
  downloadFn = downloadWhatsAppMedia
) {
  const reply = async (text) => {
    await sock.sendMessage(from, { text }, { quoted: msg });
  };

  if (!source?.stickerMessage) {
    return reply(aviso('Responda a uma figurinha com /unsticker para transformá-la em imagem ou GIF/vídeo.'));
  }

  await reply('⏳ Convertendo figurinha, aguarde...');

  let filePath = null;
  let outPath = null;
  try {
    filePath = await downloadFn(source.stickerMessage, 'sticker');

    if (source.isAnimated) {
      try {
        outPath = await convertWebpToMp4(filePath);
        await sock.sendMessage(from, {
          video: { url: outPath },
          gifPlayback: true,
          caption: '🎬 Figurinha animada convertida em GIF com sucesso!'
        }, { quoted: msg });
        return;
      } catch (animErr) {
        console.warn('⚠️ Falha ao converter sticker animado para MP4, tentando PNG:', animErr.message);
        if (outPath && fs.existsSync(outPath)) {
          try { fs.unlinkSync(outPath); } catch (_) {}
          outPath = null;
        }
      }
    }

    outPath = await convertWebpToPng(filePath);
    await sock.sendMessage(from, {
      image: { url: outPath },
      caption: '🖼️ Figurinha convertida com sucesso!'
    }, { quoted: msg });
  } catch (error) {
    console.error('Erro ao converter figurinha:', error);
    return reply(erro('Não consegui converter a figurinha.'));
  } finally {
    for (const p of [filePath, outPath]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  }
}

export async function handleMediaCommands(sock, msg, command, args, sender, resolvedFrom = null) {
  const from = resolvedFrom || msg.key.remoteJid;
  const reply = async (text) => {
    await sock.sendMessage(from, { text }, { quoted: msg });
  };

  const db = getDatabase();

  switch (command) {
    case 'sticker': {
      let mediaMessage = null;
      let mediaType = null;

      // Verifica se a mensagem original é imagem ou vídeo curto
      if (msg.message?.imageMessage) {
        mediaMessage = msg;
        mediaType = 'image';
      } else if (msg.message?.videoMessage) {
        const duration = msg.message.videoMessage.seconds;
        if (duration > 15) {
          return reply(aviso('O vídeo deve ter no máximo 15 segundos para virar figurinha animada.'));
        }
        mediaMessage = msg;
        mediaType = 'video';
      } else {
        // Verifica a mensagem citada
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted) {
          // 🔒 Visualização única não vira figurinha (só o /ver restrito revela)
          if (isViewOnceQuoted(quoted)) {
            return reply(aviso('Mídia de visualização única não pode virar figurinha. Ela só pode ser revelada com o comando /ver, que é restrito.'));
          }
          if (quoted.imageMessage) {
            mediaMessage = {
              key: {
                remoteJid: from,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
              },
              message: quoted
            };
            mediaType = 'image';
          } else if (quoted.videoMessage) {
            const duration = quoted.videoMessage.seconds;
            if (duration > 15) {
              return reply(aviso('O vídeo deve ter no máximo 15 segundos para virar figurinha animada.'));
            }
            mediaMessage = {
              key: {
                remoteJid: from,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
              },
              message: quoted
            };
            mediaType = 'video';
          }
        }
      }

      if (!mediaMessage) {
        return reply(aviso('Envie uma imagem ou um vídeo com o comando /sticker na legenda, ou responda a uma mídia com o comando.'));
      }

      await reply('⏳ Criando sua figurinha, aguarde...');

      try {
        const filePath = await downloadWhatsAppMedia(mediaMessage, mediaType);
        let buffer;

        if (mediaType === 'video') {
          // Converte o vídeo em WebP animado com FFMPEG
          buffer = await convertVideoToAnimatedSticker(filePath);
        } else {
          // Imagem estática
          const sticker = new Sticker(filePath, {
            pack: 'WhatsApp Automation Bot 🤖',
            author: 'Bot de Whatsapp',
            type: StickerTypes.FULL,
            quality: 60
          });
          buffer = await sticker.toBuffer();
        }
        
        // Apaga arquivo temporário
        try { fs.unlinkSync(filePath); } catch (_) {}

        await sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
      } catch (error) {
        console.error('Erro ao criar sticker:', error);
        return reply(erro('Não consegui criar a figurinha. Verifique se a imagem ou o vídeo é válido.'));
      }
      break;
    }

    case 'sticker2':
    case 'sticker3': {
      // sticker2 = imagem inteira com proporção original (fundo transparente)
      // sticker3 = preenche tudo com corte central (maior, sem bordas)
      const mode = command === 'sticker2' ? 'fit' : 'fill';
      const res = extractStickerImage(msg);

      if (res.error === 'VIEWONCE') {
        return reply(aviso('Mídia de visualização única não pode virar figurinha. Ela só pode ser revelada com o comando /ver, que é restrito.'));
      }
      if (res.error === 'VIDEO') {
        return reply(aviso(`O comando /${command} funciona apenas com imagens. Para vídeos curtos, use /sticker.`));
      }
      if (res.error || !res.mediaMessage) {
        return reply(aviso(`Envie uma imagem com o comando /${command} na legenda, ou responda a uma imagem com o comando.`));
      }

      await reply('⏳ Criando sua figurinha, aguarde...');

      try {
        const filePath = await downloadWhatsAppMedia(res.mediaMessage, 'image');
        const buffer = await convertImageToStickerSized(filePath, mode);

        try { fs.unlinkSync(filePath); } catch (_) {}

        await sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
      } catch (error) {
        console.error(`Erro ao criar ${command}:`, error);
        return reply(erro('Não consegui criar a figurinha. Verifique se a imagem é válida.'));
      }
      break;
    }

    case 'stickersom': {
      const sources = extractSoundStickerSources(msg);
      await processSoundStickerSources(sock, from, msg, sources);
      break;
    }

    case 'unsticker': {
      const source = extractUnstickerSource(msg);
      await processUnsticker(sock, from, msg, source);
      break;
    }

    case 'ver': {
      // Verificar se é o dono ou se está na lista de autorizados (cobre PN + LID via metadados)
      const candidateSenders = await resolveSenderCandidates(sock, from, sender, msg);
      const isOwner = checkIfOwner(sender, msg) || candidateSenders.some((c) => isPhoneJid(c) && checkIfOwner(c));
      const isAuthorized = isAuthorizedForVer(db.autorizadosVer, candidateSenders);

      if (!isOwner && !isAuthorized) {
        return reply(aviso('Você não tem permissão para usar este comando.'));
      }

      const contextInfo = extractContextInfo(msg);

      // Localiza a mídia de visualização única (cache, quoted ou última recebida)
      const voData = findViewOnce(msg, [from, msg?.key?.remoteJid], contextInfo);

      if (voData?.missingKey) {
        if (voData.unavailable) {
          return reply(aviso('O WhatsApp não entregou essa mídia de visualização única para o dispositivo conectado do bot (unavailable). Aguarde alguns segundos ou peça para reenviarem.'));
        }
        return reply(aviso('O WhatsApp não forneceu a chave de descriptografia para esta mídia (provavelmente enviada antes do bot ligar ou já expirada). Peça para reenviarem.'));
      }

      if (!voData || !voData.content) {
        return reply(aviso('Nenhuma mídia de visualização única encontrada.\n💡 *Dica:* Responda à mídia com */ver* ou digite */ver* logo após ela ser enviada no chat.'));
      }

      await reply('⏳ Baixando e revelando mídia de visualização única, aguarde...');

      let filePath = null;
      try {
        filePath = await downloadViewOnceFile(voData.mediaType, voData.content, { sock, voData });

        const caption = '👁️ *Mídia revelada com sucesso!*';
        if (voData.mediaType === 'image') {
          await sock.sendMessage(from, { image: { url: filePath }, caption }, { quoted: msg });
        } else if (voData.mediaType === 'video') {
          await sock.sendMessage(from, { video: { url: filePath }, caption }, { quoted: msg });
        } else if (voData.mediaType === 'audio') {
          if (filePath.endsWith('.ogg')) {
            await sock.sendMessage(from, {
              audio: { url: filePath },
              mimetype: voData.content.mimetype || 'audio/ogg; codecs=opus',
              ptt: voData.content.ptt !== false
            }, { quoted: msg });
          } else {
            await sendAudioCompat(sock, from, filePath, 'audio-ver', msg);
          }
        } else if (voData.mediaType === 'document') {
          await sock.sendMessage(from, {
            document: { url: filePath },
            mimetype: voData.content.mimetype || 'application/octet-stream',
            fileName: voData.content.fileName || 'arquivo'
          }, { quoted: msg });
        }
      } catch (error) {
        if (error?.message === 'MISSING_MEDIA_KEY' || error?.message?.includes('Cannot derive from empty media key')) {
          return reply(aviso('O WhatsApp não forneceu a chave de descriptografia para esta mídia (provavelmente enviada antes do bot ligar). Peça para reenviarem.'));
        }
        if (error?.message === 'MISSING_MEDIA_URL' || error?.message === 'EMPTY_MEDIA_STREAM') {
          return reply(aviso('A mídia de visualização única veio sem endereço válido ou vazia (provavelmente expirada). Peça para reenviarem.'));
        }
        const status = error?.response?.status;
        if (status === 404 || status === 410 || status === 403) {
          return reply(aviso('Esta mídia de visualização única já expirou nos servidores do WhatsApp (HTTP ' + status + '). Peça para reenviarem.'));
        }
        console.error('Erro ao revelar visualização única:', error);
        const detail = error?.message ? ` (${error.message.slice(0, 120)})` : '';
        return reply(erro(`Não consegui baixar e revelar a mídia${detail}.`));
      } finally {
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      }
      break;
    }

    case 'play': {
      const query = args.join(' ').trim();
      if (!query) {
        return reply(uso('/play Linkin Park Numb', 'Digite o nome da música ou o link do YouTube, TikTok ou Instagram.'));
      }

      if (/(tiktok\.com|vt\.tiktok|vm\.tiktok)/i.test(query)) {
        await reply('⏳ Baixando áudio do TikTok, aguarde...');
        let music;
        try {
          music = await downloadTiktokAudio(query);
          await sendAudioCompat(sock, from, music.filePath, music.title, msg);
          return;
        } catch (error) {
          console.error('Erro ao baixar áudio do TikTok via /play:', error);
          const detail = error?.message ? ` (${error.message.slice(0, 120)})` : '';
          return reply(erro(`Não consegui baixar o áudio do TikTok${detail}.`));
        } finally {
          if (music?.filePath && fs.existsSync(music.filePath)) {
            try { fs.unlinkSync(music.filePath); } catch (_) {}
          }
        }
      }

      if (/(instagram\.com|instagr\.am)/i.test(query)) {
        await reply('⏳ Baixando áudio do Instagram, aguarde...');
        let music;
        try {
          music = await downloadInstagramAudio(query);
          await sendAudioCompat(sock, from, music.filePath, music.title, msg);
          return;
        } catch (error) {
          console.error('Erro ao baixar áudio do Instagram via /play:', error);
          return reply(erro('Não consegui baixar o áudio do Instagram. Verifique se a publicação é pública.'));
        } finally {
          if (music?.filePath && fs.existsSync(music.filePath)) {
            try { fs.unlinkSync(music.filePath); } catch (_) {}
          }
        }
      }

      await reply('⏳ Buscando e baixando áudio do YouTube, aguarde...');

      let music;
      try {
        music = await downloadYoutubeAudio(query);

        await sendAudioCompat(sock, from, music.filePath, music.title, msg);
      } catch (error) {
        console.error('Erro ao baixar música:', error);
        const detail = error?.message ? ` (${error.message.slice(0, 100)})` : '';
        return reply(erro(`Não consegui buscar ou baixar a música${detail}. Tente novamente em instantes.`));
      } finally {
        if (music?.filePath && fs.existsSync(music.filePath)) {
          try { fs.unlinkSync(music.filePath); } catch (_) {}
        }
      }
      break;
    }

    case 'video': {
      const query = args.join(' ');
      if (!query) {
        return reply(uso('/video Minecraft Speedrun', 'Digite o nome do vídeo ou o link do YouTube, TikTok ou Instagram.'));
      }

      if (/tiktok\.com/i.test(query)) {
        await reply('⏳ Baixando vídeo do TikTok sem marca d\'água, aguarde...');
        try {
          const video = await downloadTiktokVideo(query);
          await sock.sendMessage(
            from, 
            { 
              video: { url: video.filePath }, 
              caption: `🎥 *${video.title}*\n\nCriador: ${video.author}`
            }, 
            { quoted: msg }
          );
          fs.unlinkSync(video.filePath);
          return;
        } catch (error) {
          console.error('Erro ao baixar vídeo do TikTok via /video:', error);
          const detail = error?.message ? ` (${error.message.slice(0, 120)})` : '';
          return reply(erro(`Não consegui baixar o vídeo do TikTok${detail}. Verifique se o link é público e tente novamente.`));
        }
      }

      if (/instagram\.com/i.test(query)) {
        await reply('⏳ Baixando vídeo do Instagram, aguarde...');
        try {
          const video = await downloadInstagramVideo(query);
          await sock.sendMessage(
            from, 
            { 
              video: { url: video.filePath }, 
              mimetype: 'video/mp4',
              caption: `🎥 *${video.title}*\n\nOrigem: Instagram`
            }, 
            { quoted: msg }
          );
          fs.unlinkSync(video.filePath);
          return;
        } catch (error) {
          console.error('Erro ao baixar vídeo do Instagram via /video:', error);
          return reply(erro('Não consegui baixar o vídeo do Instagram. Verifique se a publicação é pública.'));
        }
      }

      await reply('⏳ Buscando e baixando vídeo do YouTube, aguarde...');

      try {
        const video = await downloadYoutubeVideo(query);

        await sock.sendMessage(
          from, 
          { 
            video: { url: video.filePath }, 
            caption: `🎥 *${video.title}*\n\nCanal: ${video.author}\nVisualizações: ${video.views.toLocaleString()}`
          }, 
          { quoted: msg }
        );

        // Limpa temporários
        fs.unlinkSync(video.filePath);
      } catch (error) {
        console.error('Erro ao baixar vídeo:', error);
        const detail = error?.message ? ` (${error.message.slice(0, 100)})` : '';
        return reply(erro(`Não consegui buscar ou baixar o vídeo${detail}. O vídeo pode ser muito grande ou indisponível.`));
      }
      break;
    }

    case 'ig':
    case 'insta':
    case 'igvideo':
    case 'instavideo': {
      const url = args[0];
      if (!url || !/instagram\.com/i.test(url)) {
        return reply(uso('/ig https://www.instagram.com/reel/...', 'Cole um link válido do Instagram.'));
      }

      await reply('⏳ Baixando vídeo do Instagram, aguarde...');

      try {
        const video = await downloadInstagramVideo(url);
        await sock.sendMessage(
          from, 
          { 
            video: { url: video.filePath }, 
            mimetype: 'video/mp4',
            caption: `🎥 *${video.title}*\n\nOrigem: Instagram`
          }, 
          { quoted: msg }
        );
        fs.unlinkSync(video.filePath);
      } catch (error) {
        console.error('Erro ao baixar vídeo do Instagram:', error);
        return reply(erro('Não consegui baixar o vídeo do Instagram. Verifique o link e tente novamente.'));
      }
      break;
    }

    case 'igaudio':
    case 'instaaudio':
    case 'igplay': {
      const url = args[0];
      if (!url || !/instagram\.com/i.test(url)) {
        return reply(uso('/igaudio https://www.instagram.com/reel/...', 'Cole um link válido do Instagram.'));
      }

      await reply('⏳ Baixando áudio do Instagram, aguarde...');

      try {
        const music = await downloadInstagramAudio(url);
        await sendAudioCompat(sock, from, music.filePath, music.title, msg);
        fs.unlinkSync(music.filePath);
      } catch (error) {
        console.error('Erro ao baixar áudio do Instagram:', error);
        return reply(erro('Não consegui baixar o áudio do Instagram. Verifique o link e tente novamente.'));
      }
      break;
    }

    case 'tiktok':
    case 'ttvideo': {
      const url = args[0];
      if (!url || !/tiktok\.com/i.test(url)) {
        return reply(uso('/tiktok https://vm.tiktok.com/...', 'Cole um link válido do TikTok.'));
      }

      await reply('⏳ Baixando vídeo do TikTok sem marca d\'água, aguarde...');

      try {
        const video = await downloadTiktokVideo(url);
        await sock.sendMessage(
          from, 
          { 
            video: { url: video.filePath }, 
            caption: `🎥 *${video.title}*\n\nCriador: ${video.author}`
          }, 
          { quoted: msg }
        );
        fs.unlinkSync(video.filePath);
      } catch (error) {
        console.error('Erro ao baixar vídeo do TikTok:', error);
        const detail = error?.message ? ` (${error.message.slice(0, 120)})` : '';
        return reply(erro(`Não consegui baixar o vídeo do TikTok${detail}. Verifique o link e tente novamente.`));
      }
      break;
    }

    case 'tiktokaudio':
    case 'ttplay': {
      const url = args[0];
      if (!url || !/tiktok\.com/i.test(url)) {
        return reply(uso('/tiktokaudio https://vm.tiktok.com/...', 'Cole um link válido do TikTok.'));
      }

      await reply('⏳ Baixando áudio do TikTok, aguarde...');

      try {
        const music = await downloadTiktokAudio(url);
        await sendAudioCompat(sock, from, music.filePath, music.title, msg);
        fs.unlinkSync(music.filePath);
      } catch (error) {
        console.error('Erro ao baixar áudio do TikTok:', error);
        const detail = error?.message ? ` (${error.message.slice(0, 120)})` : '';
        return reply(erro(`Não consegui baixar o áudio do TikTok${detail}. Verifique o link e tente novamente.`));
      }
      break;
    }

    default:
      break;
  }
}

