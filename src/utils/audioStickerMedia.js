import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 60000;
const MAX_ANIMATED_WEBP_BYTES = 490000;
const MAX_STATIC_WEBP_BYTES = 450 * 1024;

function createTempFilePath(prefix, extension) {
  const randomPart = Math.floor(Math.random() * 1e6);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${process.pid}-${randomPart}.${extension}`);
}

async function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (_) {}
}

/**
 * Executa o FFmpeg gravando em arquivo temporário, lê o Buffer resultante
 * e garante a remoção do arquivo temporário em bloco finally.
 */
async function runFfmpegToBuffer(prefix, extension, args) {
  const outputPath = createTempFilePath(prefix, extension);
  try {
    await execFileAsync(ffmpegPath, [...args, outputPath], {
      maxBuffer: MAX_EXEC_BUFFER,
      timeout: FFMPEG_TIMEOUT_MS
    });
    return await fs.promises.readFile(outputPath);
  } finally {
    await safeUnlink(outputPath);
  }
}

function parseDurationSeconds(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : 0;
}

/**
 * Sonda um arquivo de mídia usando apenas `ffmpeg -i` (sem depender de ffprobe).
 * @param {string} inputPath
 * @returns {Promise<{ hasVideo: boolean, hasAudio: boolean, durationSeconds: number }>}
 */
export async function probeMediaInfo(inputPath) {
  let stderr = '';
  let probeError = null;

  try {
    const result = await execFileAsync(ffmpegPath, ['-i', inputPath], {
      maxBuffer: MAX_EXEC_BUFFER,
      timeout: FFMPEG_TIMEOUT_MS
    });
    stderr = result.stderr || '';
  } catch (err) {
    probeError = err;
    stderr = err?.stderr || '';
  }

  const hasVideo = /Stream #\d+:\d+.*:\s*Video:/.test(stderr);
  const hasAudio = /Stream #\d+:\d+.*:\s*Audio:/.test(stderr);

  if (!hasVideo && !hasAudio) {
    throw probeError || new Error(`Não foi possível identificar fluxos de mídia em: ${inputPath}`);
  }

  return {
    hasVideo,
    hasAudio,
    durationSeconds: parseDurationSeconds(stderr)
  };
}

/**
 * Extrai a faixa de áudio em formato OGG/Opus limitada a `maxSeconds`.
 * Rejeita com Error('NO_AUDIO_STREAM') caso o arquivo não possua áudio.
 * @param {string} inputPath
 * @param {number} [maxSeconds=10]
 * @returns {Promise<Buffer>}
 */
export async function extractOggOpusAudio(inputPath, maxSeconds = 10) {
  const info = await probeMediaInfo(inputPath);
  if (!info.hasAudio) {
    throw new Error('NO_AUDIO_STREAM');
  }

  return runFfmpegToBuffer('stickersom-audio', 'ogg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-map', '0:a:0',
    '-t', String(maxSeconds),
    '-c:a', 'libopus',
    '-b:a', '48k',
    '-vbr', 'on',
    '-compression_level', '10',
    '-frame_duration', '20',
    '-ar', '48000',
    '-ac', '1',
    '-application', 'voip',
    '-avoid_negative_ts', 'make_zero',
    '-map_metadata', '-1'
  ]);
}

/**
 * Converte vídeo para figurinha WebP animada (512x512, até `maxSeconds`),
 * reduzindo fps/qualidade (e escala em último caso) caso ultrapasse 490000 bytes.
 * @param {string} inputPath
 * @param {number} [maxSeconds=5]
 * @returns {Promise<Buffer>}
 */
export async function convertVideoToSoundStickerWebp(inputPath, maxSeconds = 5) {
  const passes = [
    { size: 512, fps: 10, qscale: 45 },
    { size: 512, fps: 8, qscale: 30 },
    { size: 512, fps: 6, qscale: 20 },
    { size: 384, fps: 6, qscale: 20 }
  ];

  let lastBuffer = null;
  for (const pass of passes) {
    const vf = `[0:v] format=rgba,scale=${pass.size}:${pass.size}:force_original_aspect_ratio=decrease,fps=${pass.fps},pad=${pass.size}:${pass.size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
    const buffer = await runFfmpegToBuffer('stickersom-anim', 'webp', [
      '-y',
      '-i', inputPath,
      '-vcodec', 'libwebp',
      '-filter_complex', vf,
      '-loop', '0',
      '-ss', '00:00:00',
      '-t', String(maxSeconds),
      '-qscale', String(pass.qscale),
      '-preset', 'default',
      '-an',
      '-vsync', '0'
    ]);

    lastBuffer = buffer;
    if (buffer.length <= MAX_ANIMATED_WEBP_BYTES) {
      return buffer;
    }
  }

  return lastBuffer;
}

/**
 * Converte imagem estática para figurinha WebP 512x512 preservando proporção
 * com fundo transparente e fallback de qualidade se exceder 450 KB.
 * @param {string} inputPath
 * @returns {Promise<Buffer>}
 */
export async function convertImageToSoundStickerWebp(inputPath) {
  const qualities = [85, 60, 35];
  const vf = 'format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';

  let lastBuffer = null;
  for (const quality of qualities) {
    const buffer = await runFfmpegToBuffer('stickersom-img', 'webp', [
      '-y',
      '-i', inputPath,
      '-vf', vf,
      '-vcodec', 'libwebp',
      '-lossless', '0',
      '-quality', String(quality),
      '-preset', 'picture',
      '-an'
    ]);

    lastBuffer = buffer;
    if (buffer.length <= MAX_STATIC_WEBP_BYTES) {
      return buffer;
    }
  }

  return lastBuffer;
}
