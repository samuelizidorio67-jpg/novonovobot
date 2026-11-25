# Plano de Implementação: `/stickersom` (Figurinha Sonora Nativa)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o comando `/stickersom` para criar e enviar figurinhas nativas com áudio embutido (`audioStickerMessage`) a partir de vídeos com som ou imagem + áudio citado, mantendo `/sticker`, `/sticker2` e `/sticker3` intocados.

**Architecture:** Estendemos em memória o `WAProto` do `@whiskeysockets/baileys` (`Message.audioStickerMessage` campo `134` e `StickerMessage.audioMessage` campo `26`, além de `premium` `24` e `emojis` `25`) sem modificar `node_modules`. Um módulo de mídia dedicado usa `ffmpeg-static` (sem depender de `ffprobe`) para validar/recortar vídeo+áudio (máximo 5 s) ou imagem+áudio (máximo 10 s) em WebP `512×512` e `audio/ogg; codecs=opus`, faz upload separado via `prepareWAMessageMedia` + `waUploadToServer` e envia pela fila do `QueueManager` via `relayMessage` com `mediatype: 'sticker'`.

**Tech Stack:** Node.js (ESM), `@whiskeysockets/baileys` (`6.7.23`), `protobufjs/minimal.js`, `ffmpeg-static`, `assert`.

**Spec:** [docs/superpowers/specs/2026-11-24-stickersom-design.md](../specs/2026-11-24-stickersom-design.md)

## Global Constraints

- Manter `/sticker`, `/sticker2` e `/sticker3` exatamente com o comportamento atual.
- Não alterar arquivos dentro de `node_modules/`.
- Bloquear qualquer mídia de visualização única no `/stickersom` (restrita ao `/ver`).
- Limitar duração de vídeo de entrada em 15 s (como `/sticker`), recortando a saída sonora para **5 s** em vídeos e **10 s** em imagem + áudio.
- Não depender de `ffprobe` (usar `ffmpeg-static` para sondagem e conversão, compatível com Windows e Linux/Docker).
- Enviar mensagens pela fila do `QueueManager` e limpar arquivos temporários em bloco `finally`.

## Review Focus

- **Vídeo sem trilha de áudio (mudo):** `probeMediaInfo` / `extractOggOpusAudio` deve detectar ausência de áudio (`NO_AUDIO_STREAM`) e responder aviso amigável orientando usar `/sticker`, sem quebrar.
- **Mídia de visualização única (direta ou citada):** `extractSoundStickerSources` deve recusar com `error: 'VIEWONCE'` antes de qualquer download.
- **Vídeo acima de 5 s (até 15 s) ou áudio acima de 10 s:** FFmpeg deve recortar para 5 s (vídeo) ou 10 s (áudio + imagem) sem estourar o limite de 490 KB do WebP animado.
- **Envio de `audioStickerMessage` sem que `getMediaType` zere `mediatype`:** `relayMessage` deve receber `additionalAttributes: { mediatype: 'sticker' }` e passar pelo `QueueManager`.
- **Decodificação/unwrapping de `audioStickerMessage` recebida:** `unwrapMessageContent` e `/unsticker` devem reconhecer figurinhas sonoras recebidas sem tratar como mensagem vazia.

---

### Estrutura de Arquivos

- **Criar:** `src/utils/audioStickerProto.js` — extensão em runtime do `WAProto` (campos `134` e `24`/`25`/`26`) e `sendAudioSticker(...)` via `prepareWAMessageMedia` + `relayMessage` + `QueueManager`.
- **Criar:** `src/utils/audioStickerMedia.js` — sondagem via `ffmpeg-static` (`probeMediaInfo`), extração para OGG/Opus (`extractOggOpusAudio`), geração de WebP estático/animado (`convertVideoToSoundStickerWebp`, `convertImageToSoundStickerWebp`).
- **Criar:** `tests/test_audio_sticker.js` — testes automatizados de encode/decode protobuf, FFmpeg real com mídia sintética e fluxo de `handleMediaCommands('stickersom')`.
- **Modificar:** `src/utils/viewOnceManager.js` — incluir `'audioStickerMessage'` em `WRAPPER_KEYS` do `unwrapMessageContent`.
- **Modificar:** `src/commands/media.js` — adicionar `extractSoundStickerSources(msg)` e `case 'stickersom'`, além de desembrulhar `audioStickerMessage` no `case 'unsticker'`.
- **Modificar:** `src/messageHandler.js` — adicionar `'stickersom'` na rota de comandos pesados de mídia.
- **Modificar:** `src/config/menu.js` — documentar `stickersom` em `MÍDIA & DOWNLOADS`.

---

### Task 1: Extensão Protobuf `audioStickerMessage` e Envio (`src/utils/audioStickerProto.js`)

**Files:**
- Create: `src/utils/audioStickerProto.js`
- Test: `tests/test_audio_sticker.js`

**Interfaces:**
- Produces:
  - `installAudioStickerProto(): void`
  - `unwrapAudioStickerMessage(messageObj): { stickerMessage: object, audioMessage: object|null } | null`
  - `sendAudioSticker(sock, jid, { webpBuffer, audioBuffer, durationSeconds, isAnimated, emojis, quoted }): Promise<object>`

- [ ] **Step 1: Escrever teste que falha para encode/decode e `sendAudioSticker`**

Criar `tests/test_audio_sticker.js` testando:
- `installAudioStickerProto()` seguido de `proto.Message.encode` / `proto.Message.decode` em `{ audioStickerMessage: { message: { stickerMessage: { url: 'https://mmg.whatsapp.net/s', mimetype: 'image/webp', width: 512, height: 512, isAnimated: true, emojis: '🔥', audioMessage: { url: 'https://mmg.whatsapp.net/a', mimetype: 'audio/ogg; codecs=opus', seconds: 4 } } } } }` preserva `audioStickerMessage.message.stickerMessage.audioMessage.seconds === 4`, `mimetype === 'audio/ogg; codecs=opus'` e `emojis === '🔥'`.
- `unwrapAudioStickerMessage(decoded)` retorna `{ stickerMessage, audioMessage }`.

- [ ] **Step 2: Rodar o teste para confirmar falha**

Run: `node tests/test_audio_sticker.js`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` para `src/utils/audioStickerProto.js`).

- [ ] **Step 3: Implementar `src/utils/audioStickerProto.js`**

- Importar `proto`, `generateWAMessageFromContent`, `prepareWAMessageMedia` de `@whiskeysockets/baileys`, `$protobuf` de `protobufjs/minimal.js` e `queueManager` de `../queue/QueueManager.js`.
- Implementar `installAudioStickerProto()` com guarda idempotente:
  - Em `proto.Message`: envolver `encode`, `decode`, `fromObject`, `toObject` e `verify` para ler/gravar o campo `134` (`wireType 2`, tag `(134 << 3) | 2 = 1074`) usando `proto.Message.FutureProofMessage`.
  - Em `proto.Message.StickerMessage`: envolver `encode`, `decode`, `fromObject`, `toObject` e `verify` para ler/gravar campo `24` (`premium`, varint tag `192`), campo `25` (`emojis`, length-delimited tag `202`) e campo `26` (`audioMessage`, length-delimited tag `210` com `proto.Message.AudioMessage`).
  - Na decodificação dos campos extras (`decode`), usar um `Reader` secundário sobre o intervalo `[pos, end]` para capturar apenas os campos desconhecidos pelo `WAProto` original sem quebrar o reader principal.
- Implementar `unwrapAudioStickerMessage(messageObj)` e `sendAudioSticker(...)`:
  - Usar `rawSock = sock._rawSock || sock` para `waUploadToServer` e `relayMessage`.
  - Preparar `stickerPart = await prepareWAMessageMedia({ sticker: webpBuffer }, { upload: rawSock.waUploadToServer, logger: rawSock.logger })` e `audioPart = await prepareWAMessageMedia({ audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: false, seconds: Math.max(1, Math.round(durationSeconds || 1)) }, { upload: rawSock.waUploadToServer, logger: rawSock.logger })`.
  - Montar `stickerMessage` com `width: 512`, `height: 512`, `isAnimated: Boolean(isAnimated)`, `accessibilityLabel: ''`, `emojis` (se informado) e `audioMessage: audioPart.audioMessage` (sem `ptt`).
  - Construir `{ audioStickerMessage: { message: { stickerMessage } } }` via `generateWAMessageFromContent(jid, msgPayload, { userJid: rawSock.user?.id, quoted })` e enviar com `queueManager.enqueueMessage(jid, () => rawSock.relayMessage(jid, fullMsg.message, { messageId: fullMsg.key.id, additionalAttributes: { mediatype: 'sticker' } }))`.

- [ ] **Step 4: Rodar teste para confirmar que passa**

Run: `node tests/test_audio_sticker.js`
Expected: PASS na parte protobuf.

---

### Task 2: Conversão e Sondagem FFmpeg (`src/utils/audioStickerMedia.js`)

**Files:**
- Create: `src/utils/audioStickerMedia.js`
- Test: `tests/test_audio_sticker.js`

**Interfaces:**
- Produces:
  - `probeMediaInfo(inputPath): Promise<{ hasVideo: boolean, hasAudio: boolean, durationSeconds: number }>`
  - `extractOggOpusAudio(inputPath, maxSeconds = 10): Promise<Buffer>`
  - `convertVideoToSoundStickerWebp(inputPath, maxSeconds = 5): Promise<Buffer>`
  - `convertImageToSoundStickerWebp(inputPath): Promise<Buffer>`

- [ ] **Step 1: Adicionar testes FFmpeg reais em `tests/test_audio_sticker.js`**

Usando `ffmpegPath` (`ffmpeg-static`) para gerar em `os.tmpdir()` dois fixtures temporários sintéticos (removidos em `finally`):
1. Vídeo MP4 de 7 s com vídeo (`color=c=red:s=320x240:d=7`) + áudio (`sine=f=440:d=7`).
2. Vídeo MP4 mudo de 3 s (`color=c=blue:s=320x240:d=3` sem áudio).
Asserções:
- `probeMediaInfo` retorna `{ hasVideo: true, hasAudio: true }` e duração ~7 s para o vídeo com áudio, e `hasAudio: false` para o vídeo mudo.
- `extractOggOpusAudio(videoWithAudio, 5)` retorna `Buffer` iniciando com bytes `OggS` e tamanho > 0.
- `extractOggOpusAudio(silentVideo, 5)` rejeita com `NO_AUDIO_STREAM`.
- `convertVideoToSoundStickerWebp(videoWithAudio, 5)` retorna `Buffer` WebP (`RIFF....WEBP`) com tamanho `<= 490000`.
- `convertImageToSoundStickerWebp` em PNG/JPG gera `Buffer` WebP (`RIFF....WEBP`).

- [ ] **Step 2: Rodar o teste para confirmar falha**

Run: `node tests/test_audio_sticker.js`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` para `src/utils/audioStickerMedia.js`).

- [ ] **Step 3: Implementar `src/utils/audioStickerMedia.js`**

- `probeMediaInfo(inputPath)`: executa `execFile(ffmpegPath, ['-i', inputPath])` capturando `stderr` (o `ffmpeg -i` sem saída retorna código 1 com os metadados em `stderr`), extraindo `Duration: HH:MM:SS.xx` e checando `/Stream #\d+:\d+.*: Video:/` e `/Stream #\d+:\d+.*: Audio:/`.
- `extractOggOpusAudio(inputPath, maxSeconds = 10)`: valida com `probeMediaInfo` (lança `new Error('NO_AUDIO_STREAM')` se `!info.hasAudio`), converte com `['-y', '-i', inputPath, '-vn', '-map', '0:a:0', '-t', String(maxSeconds), '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip', outPath]`, lê para `Buffer` e limpa temporário em `finally`.
- `convertVideoToSoundStickerWebp(inputPath, maxSeconds = 5)`: converte com `libwebp` `512x512` `fps=10` `-t 5` `qscale 45`, e faz segunda passagem `384x384` `fps=8` `qscale 35` se passar de `490000` bytes (padrão já usado em `media.js`).
- `convertImageToSoundStickerWebp(inputPath)`: converte imagem para `libwebp` `512x512` preservando proporção com fundo transparente (e fallback de qualidade se > 450 KB).

- [ ] **Step 4: Rodar teste para confirmar que passa**

Run: `node tests/test_audio_sticker.js`
Expected: PASS nos testes de protobuf e FFmpeg.

---

### Task 3: Comando `/stickersom`, Desembrulho no `/unsticker`, Dispatcher e Menu

**Files:**
- Modify: `src/utils/viewOnceManager.js` (adicionar `'audioStickerMessage'` em `WRAPPER_KEYS`)
- Modify: `src/commands/media.js` (adicionar `extractSoundStickerSources`, `case 'stickersom'` e suporte no `case 'unsticker'`)
- Modify: `src/messageHandler.js` (incluir `'stickersom'` na rota de comandos de mídia)
- Modify: `src/config/menu.js` (adicionar `'stickersom'` em `MÍDIA & DOWNLOADS`)
- Test: `tests/test_audio_sticker.js` e `tests/test_view_once.js`

**Interfaces:**
- Consumes: `sendAudioSticker` de `../utils/audioStickerProto.js`; `probeMediaInfo`, `extractOggOpusAudio`, `convertVideoToSoundStickerWebp`, `convertImageToSoundStickerWebp` de `../utils/audioStickerMedia.js`; `extractContextInfo`, `extractViewOnce` de `../utils/viewOnceManager.js`.
- Produces: `extractSoundStickerSources(msg)` exportada em `src/commands/media.js`.

- [ ] **Step 1: Adicionar testes de `extractSoundStickerSources`, `handleMediaCommands('stickersom')` e `unwrapMessageContent` com `audioStickerMessage`**

Em `tests/test_audio_sticker.js`, testar:
- Vídeo com `viewOnceMessageV2` -> `{ error: 'VIEWONCE' }`.
- Mensagem sem mídia compatível -> `{ error: 'NONE' }` e resposta `aviso` em `handleMediaCommands(..., 'stickersom', ...)`.
- Vídeo com `seconds: 20` -> `{ error: 'VIDEO_TOO_LONG' }` e resposta `aviso`.
- Imagem enviada com `/stickersom` citando mensagem que não é áudio -> `{ error: 'NEED_AUDIO' }`.
- Imagem enviada com `/stickersom` citando `audioMessage` -> retorna `{ mode: 'image_audio', imageMsg, audioMsg }`.
- Vídeo direto ou citado com `/stickersom` -> retorna `{ mode: 'video', videoMsg }`.
- `unwrapMessageContent({ audioStickerMessage: { message: { stickerMessage: { isAnimated: true } } } })` expõe `stickerMessage`.

- [ ] **Step 2: Rodar o teste para confirmar falha**

Run: `node tests/test_audio_sticker.js`
Expected: FAIL (`extractSoundStickerSources` não exportada).

- [ ] **Step 3: Implementar as alterações em `viewOnceManager.js`, `media.js`, `messageHandler.js` e `menu.js`**

- `src/utils/viewOnceManager.js`: adicionar `'audioStickerMessage'` em `WRAPPER_KEYS`.
- `src/commands/media.js`:
  - Exportar `extractSoundStickerSources(msg)` cobrindo:
    1. Checagem de visualização única via `extractViewOnce(msg.message)` e `extractViewOnce(contextInfo?.quotedMessage)` -> `{ error: 'VIEWONCE' }`.
    2. Vídeo direto ou citado (`duration > 15` -> `{ error: 'VIDEO_TOO_LONG' }`; senão `{ mode: 'video', videoMsg }`).
    3. Imagem direta com `/stickersom` na legenda citando `quoted.audioMessage` -> `{ mode: 'image_audio', imageMsg, audioMsg }` (ou `{ error: 'NEED_AUDIO' }` se citou outra coisa ou não citou áudio).
    4. Caso contrário `{ error: 'NONE' }`.
  - No `case 'stickersom'`: validar fontes, baixar mídias via `downloadWhatsAppMedia`, converter com `audioStickerMedia.js` (respeitando `5` s para vídeo e `10` s para imagem+áudio; capturar `NO_AUDIO_STREAM` com aviso claro), enviar com `sendAudioSticker` e limpar temporários em `finally`.
  - No `case 'unsticker'`: usar `extractContextInfo(msg)` e `unwrapAudioStickerMessage(quoted)` para aceitar também `audioStickerMessage` recebida.
- `src/messageHandler.js`: incluir `'stickersom'` no array de comandos de mídia da linha ~487.
- `src/config/menu.js`: incluir `['stickersom', 'Criar figurinha com áudio (vídeo ou imagem + áudio)']` em `MÍDIA & DOWNLOADS`.

- [ ] **Step 4: Verificar sintaxe e rodar todos os testes sem DB externo**

Run:
```powershell
@('src/utils/audioStickerProto.js','src/utils/audioStickerMedia.js','src/utils/viewOnceManager.js','src/commands/media.js','src/messageHandler.js','src/config/menu.js','tests/test_audio_sticker.js','tests/test_view_once.js','tests/test_quintuplets_ai_and_memory.js') | ForEach-Object { node --check $_; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }; node tests/test_audio_sticker.js; node tests/test_view_once.js; node tests/test_quintuplets_ai_and_memory.js
```
Expected: Todos os checks e as 3 suítes de testes passam com exit code `0`.

---

## Self-Review

- **Spec coverage:** Vídeo com áudio (≤5 s) -> Task 2 & Task 3; Imagem + áudio citado (≤10 s) -> Task 2 & Task 3; Vídeo mudo recusado -> Task 2 & Task 3; Visualização única bloqueada -> Task 3; Extensão WAProto `134` e `26` sem editar `node_modules` -> Task 1; Upload + `relayMessage` com `mediatype: 'sticker'` pela fila -> Task 1; Registro em `messageHandler.js`, `menu.js` e suporte no `/unsticker` / `unwrapMessageContent` -> Task 3.
- **Step scan:** Cada passo tem assinaturas, entradas, saídas, comandos e resultados esperados explícitos, sem placeholders.
- **Type consistency:** `extractSoundStickerSources`, `sendAudioSticker`, `installAudioStickerProto`, `unwrapAudioStickerMessage`, `probeMediaInfo`, `extractOggOpusAudio`, `convertVideoToSoundStickerWebp`, `convertImageToSoundStickerWebp` mantêm nomes e parâmetros consistentes entre as Tasks 1, 2 e 3.
- **Review Focus:** Todos os 5 casos de falha mapeados têm testes dedicados nas Tasks 1, 2 e 3.
