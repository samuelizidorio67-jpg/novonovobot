# `/stickersom` com Fundo Desfocado e Cantos Arredondados — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atualizar `convertVideoToSoundStickerWebp` e `convertImageToSoundStickerWebp` para gerar figurinhas `512×512` preenchidas com o próprio conteúdo ampliado/desfocado ao fundo (`boxblur`), a mídia original centralizada sem cortes e cantos arredondados (`rx` proporcional a `34px` em `512×512`), mantendo `/sticker`, `/sticker2` e `/sticker3` inalterados.

**Architecture:** Toda a mudança fica isolada em `src/utils/audioStickerMedia.js`, reutilizando `sharp` (já instalado no projeto) para gerar uma máscara PNG temporária de cantos arredondados combinada no FFmpeg via `alphamerge`. O filtro de vídeo reduz para `pass.fps` antes de `split=2` para economizar CPU/RAM e usa `-loop 1 -i maskPath` com `alphamerge=shortest=1` garantindo remoção da máscara em `finally`.

**Tech Stack:** Node.js ESM, `ffmpeg-static`, `sharp`, `@whiskeysockets/baileys`

**Spec:** `docs/superpowers/specs/2026-11-25-stickersom-blur-format-design.md`

## Global Constraints

- Escopo visual restrito a `/stickersom` (`src/utils/audioStickerMedia.js`); nunca alterar `/sticker`, `/sticker2` ou `/sticker3` em `src/commands/media.js`.
- Nunca editar `node_modules/`.
- Saída de vídeo animado <= `490000` bytes (`MAX_ANIMATED_WEBP_BYTES`); saída de imagem estática <= `450 * 1024` bytes (`MAX_STATIC_WEBP_BYTES`).
- Timeout de `60000` ms (`FFMPEG_TIMEOUT_MS`) mantido nas execuções FFmpeg.
- Zero arquivos temporários vazados em `os.tmpdir()` (incluindo máscaras PNG geradas em `sharp`).

## Review Focus

- **Animação multi-frame preservada em vídeo:** garantir com `sharp(animWebp, { animated: true }).metadata()` que `pages > 1` (máscara com `-loop 1` + `alphamerge=shortest=1` não colapsa vídeo para 1 quadro).
- **Vídeos verticais (9:16) e horizontais (16:9) preenchidos sem faixas vazias:** verificar que o pixel central da borda esquerda/direita (vertical) ou topo/base (horizontal) tem `alpha === 255` (blur opaco), e que os 4 cantos `(0, 0)`, `(511, 0)`, `(0, 511)`, `(511, 511)` têm `alpha === 0` (cantos arredondados).
- **Fallback de tamanho sem quebrar máscara:** quando vídeo pesado cai para passe `384×384`, a máscara precisa ser gerada com `384×384` e `rx = Math.round((384 * 34) / 512)` para não falhar nem deformar o `alphamerge`.
- **Imagem 9:16/16:9 em `convertImageToSoundStickerWebp`:** validar que foto não quadrada também recebe fundo desfocado opaco + cantos arredondados com `isAnimated === false`.
- **Regressão zero:** `/stickersom`, `/unsticker`, `menu` e `/ver` continuam passando na íntegra.

---

### Task 1: Testes TDD para fundo desfocado, cantos arredondados e multi-frame

**Files:**
- Modify: `tests/test_audio_sticker.js`

**Interfaces:**
- Consumes: `convertVideoToSoundStickerWebp`, `convertImageToSoundStickerWebp` de `src/utils/audioStickerMedia.js`
- Produces: Cobertura em `tests/test_audio_sticker.js` validando animação multi-frame, alfa dos cantos e opacidade das bordas preenchidas por blur em vídeo vertical `9:16`, vídeo horizontal `16:9` e imagem `16:9`

- [ ] **Step 1: Adicionar gerador de vídeo vertical `9:16` e assertions RGBA/multi-frame em `tests/test_audio_sticker.js`**
  Adicionar um vídeo sintético vertical `180x320` (9:16) além do vídeo `320x240` e da imagem `640x360`, inspecionar pixels com `sharp(buffer, { page: 0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })` (validando `alpha === 0` no canto `(0, 0)` e `alpha === 255` no meio da borda esquerda/topo preenchida pelo blur) e verificar `pages > 1` via `sharp(animWebp, { animated: true }).metadata()`.

- [ ] **Step 2: Rodar `node tests/test_audio_sticker.js` para confirmar falha esperada antes da implementação**
  Run: `node tests/test_audio_sticker.js`
  Expected: FAIL indicando borda esquerda/topo transparente (`alpha === 0`) ou cantos sem arredondamento (`alpha === 255` dependendo do caso) antes de aplicar o filtro novo.

### Task 2: Implementar fundo desfocado e máscara arredondada em `src/utils/audioStickerMedia.js`

**Files:**
- Modify: `src/utils/audioStickerMedia.js`

**Interfaces:**
- Consumes: `sharp` (dependência direta do projeto), `runFfmpegToBuffer`, `createTempFilePath`, `safeUnlink`
- Produces: `convertVideoToSoundStickerWebp(inputPath, maxSeconds = 5)` e `convertImageToSoundStickerWebp(inputPath)` com helpers compartilhados `createRoundedMaskFile(size)` e `buildBlurStickerFilter({ size, fps, blurRadius })`

- [ ] **Step 1: Implementar helpers `createRoundedMaskFile` e `buildBlurStickerFilter` e atualizar `convertVideoToSoundStickerWebp` e `convertImageToSoundStickerWebp`**
  - Em vídeo: `-ss 00:00:00 -t ${maxSeconds} -i inputPath -loop 1 -i maskPath` com `[0:v]fps=${pass.fps},setsar=1,split=2[bg_src][fg_src];[bg_src]scale=${pass.size}:${pass.size}:force_original_aspect_ratio=increase,crop=${pass.size}:${pass.size}:(iw-${pass.size})/2:(ih-${pass.size})/2,boxblur=${blurRadius}:2[bg];[fg_src]scale=${pass.size}:${pass.size}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgba[comp];[1:v]format=gray[alpha];[comp][alpha]alphamerge=shortest=1` e limpar `maskPath` no `finally` (gerando sob demanda e reutilizando por `size` dentro do loop de passes).
  - Em imagem: `-i inputPath -i maskPath` com filtro equivalente (sem `fps`), limpando `maskPath` no `finally`.

- [ ] **Step 2: Executar verificação completa e enviar ao GitHub**
  Run: `node --check src/utils/audioStickerMedia.js`, `node --check tests/test_audio_sticker.js`, `node tests/test_audio_sticker.js`, `node tests/test_menu.js`, `node tests/test_view_once.js`
  Expected: PASS em todas as suítes sem arquivos temporários vazados em `os.tmpdir()`.
  Depois fazer `git add`, `git commit` e `git push origin main`.
