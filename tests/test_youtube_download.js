import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractVideoId,
  normalizeCookiesToNetscape,
  isValidNetscapeCookiesContent,
  isValidInstagramCookiesContent,
  buildYtDlpAttempts,
  buildYtDlpSearchArgs,
  buildInstagramYtDlpAttempts,
  getYtDlpBinaryAssetForPlatform,
  needsYtDlpUpdateFromError,
  callTikWmApi,
  resetTikWmThrottleForTest,
  isTikTokPhotoSlideshow,
} from '../src/utils/helpers.js';

console.log('🧪 Iniciando testes de YouTube, Instagram, TikTok e yt-dlp...');

// 1. Extração de videoId do YouTube (inclusive parâmetros antes de v=)
{
  assert.strictEqual(extractVideoId('https://www.youtube.com/watch?v=kXYiU_JCYtU'), 'kXYiU_JCYtU');
  assert.strictEqual(extractVideoId('https://www.youtube.com/watch?app=desktop&v=kXYiU_JCYtU&t=10'), 'kXYiU_JCYtU');
  assert.strictEqual(extractVideoId('https://m.youtube.com/watch?si=abc123&v=kXYiU_JCYtU'), 'kXYiU_JCYtU');
  assert.strictEqual(extractVideoId('https://youtu.be/kXYiU_JCYtU?si=xyz'), 'kXYiU_JCYtU');
  assert.strictEqual(extractVideoId('https://youtube.com/shorts/kXYiU_JCYtU'), 'kXYiU_JCYtU');
  assert.strictEqual(extractVideoId('Linkin Park Numb'), null);
}

// 2. Normalização de YOUTUBE_COOKIES e INSTAGRAM_COOKIES em formatos variados
{
  const netscapeNormal = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tLOGIN_INFO\tDUMMY_LOGIN_TOKEN_12345',
    '.youtube.com\tTRUE\t/\tFALSE\t1999999999\tSID\tDUMMY_SID_12345',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-1PSID\tDUMMY_1PSID_12345',
  ].join('\n');

  const resNormal = normalizeCookiesToNetscape(netscapeNormal);
  assert(resNormal && resNormal.includes('\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tLOGIN_INFO\tDUMMY_LOGIN_TOKEN_12345'));
  assert.strictEqual(isValidNetscapeCookiesContent(resNormal), true, 'Netscape padrão válido deve passar');

  // Caso crítico: painel do Railway/env colapsa quebras de linha em espaços e envolve em aspas
  const singleLineFlattened = '"' + [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '# This is a generated file! Do not edit.',
    '.youtube.com TRUE / TRUE 1999999999 LOGIN_INFO DUMMY_LOGIN_TOKEN_12345',
    '.youtube.com TRUE / FALSE 1999999999 SID DUMMY_SID_12345',
    '.youtube.com TRUE / TRUE 1999999999 SAPISID DUMMY_SAPISID_12345',
    '.youtube.com TRUE / FALSE 0 PREF tz=America.Sao_Paulo',
  ].join(' ') + '"';

  const resFlattened = normalizeCookiesToNetscape(singleLineFlattened);
  assert(resFlattened, 'Netscape colapsado em 1 linha deve ser normalizado');
  assert(!resFlattened.startsWith('"'), 'Aspas externas devem ser removidas');
  const dataLines = resFlattened.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert(dataLines.length >= 4, `Esperava >= 4 linhas de cookies reconstruídas, veio ${dataLines.length}`);
  for (const line of dataLines) {
    assert.strictEqual(line.split('\t').length, 7, `Linha deve ter 7 colunas separadas por TAB: ${line}`);
  }
  assert.strictEqual(isValidNetscapeCookiesContent(resFlattened), true, 'Netscape reconstruído de 1 linha deve ser válido');

  // Caso: arquivo Netscape com espaços em vez de TABs entre colunas
  const spaceSeparated = [
    '# Netscape HTTP Cookie File',
    '.youtube.com TRUE / TRUE 1999999999 LOGIN_INFO DUMMY_LOGIN_TOKEN_12345',
    '.youtube.com TRUE / FALSE 1999999999 SID DUMMY_SID_12345',
  ].join('\n');
  const resSpaces = normalizeCookiesToNetscape(spaceSeparated);
  assert(resSpaces.includes('.youtube.com\tTRUE\t/\tTRUE\t1999999999\tLOGIN_INFO\tDUMMY_LOGIN_TOKEN_12345'));
  assert.strictEqual(isValidNetscapeCookiesContent(resSpaces), true);

  // Caso: Base64 e JSON
  const b64 = Buffer.from(netscapeNormal, 'utf8').toString('base64');
  const resB64 = normalizeCookiesToNetscape(b64);
  assert.strictEqual(isValidNetscapeCookiesContent(resB64), true, 'Base64 deve decodificar e validar');

  const jsonCookies = JSON.stringify([
    { domain: '.youtube.com', path: '/', secure: true, expirationDate: 1999999999, name: 'LOGIN_INFO', value: 'DUMMY_LI' },
    { domain: '.youtube.com', path: '/', secure: false, expirationDate: 1999999999, name: 'SID', value: 'DUMMY_SID' },
  ]);
  const resJson = normalizeCookiesToNetscape(jsonCookies);
  assert.strictEqual(isValidNetscapeCookiesContent(resJson), true, 'JSON deve converter para Netscape válido');

  // Caso: Instagram cookies (Netscape e Base64)
  const igNetscape = [
    '# Netscape HTTP Cookie File',
    '.instagram.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tFAKE_IG_SESSION_12345',
    '.instagram.com\tTRUE\t/\tTRUE\t1999999999\tcsrftoken\tFAKE_CSRF_12345',
  ].join('\n');
  const igNorm = normalizeCookiesToNetscape(igNetscape, { domainRegex: /instagram\.com/i, defaultDomain: '.instagram.com' });
  assert.strictEqual(isValidInstagramCookiesContent(igNorm), true, 'Cookies válidos do Instagram devem ser aceitos');
  const igB64 = Buffer.from(igNetscape, 'utf8').toString('base64');
  const igNormB64 = normalizeCookiesToNetscape(igB64, { domainRegex: /instagram\.com/i, defaultDomain: '.instagram.com' });
  assert.strictEqual(isValidInstagramCookiesContent(igNormB64), true, 'Base64 do Instagram deve decodificar e validar');
  assert.strictEqual(isValidInstagramCookiesContent(netscapeNormal), false, 'Cookies do YouTube não devem ser aceitos como Instagram');

  // Caso: caminho de arquivo em YOUTUBE_COOKIES
  const tmpCookieFile = path.join(os.tmpdir(), `test-cookie-path-${Date.now()}.txt`);
  fs.writeFileSync(tmpCookieFile, netscapeNormal, 'utf8');
  try {
    const resPath = normalizeCookiesToNetscape(tmpCookieFile);
    assert.strictEqual(isValidNetscapeCookiesContent(resPath), true, 'Caminho de arquivo existente também deve funcionar');
  } finally {
    try { fs.unlinkSync(tmpCookieFile); } catch (_) {}
  }
}

// 3. Validação estrita rejeita cookies corrompidos, comentados ou sem sessão
{
  const commentedSingleLine = '# Netscape HTTP Cookie File .youtube.com TRUE / TRUE 1999999999 SID FAKE_ON_COMMENT';
  assert.strictEqual(isValidNetscapeCookiesContent(commentedSingleLine), false, 'Cookie preso na linha de comentário não pode passar');

  const noAuthSession = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tVISITOR_INFO1_LIVE\tABC',
    '.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tf6=40000000',
  ].join('\n');
  assert.strictEqual(isValidNetscapeCookiesContent(noAuthSession), false, 'Cookies sem tokens de autenticação devem ser rejeitados');

  const expiredOnly = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tFALSE\t1000000000\tSID\tEXPIRED_SID',
    '.youtube.com\tTRUE\t/\tTRUE\t1000000000\tLOGIN_INFO\tEXPIRED_LI',
  ].join('\n');
  assert.strictEqual(isValidNetscapeCookiesContent(expiredOnly), false, 'Cookies de autenticação expirados devem ser rejeitados');
}

// 4. Ordem e compatibilidade de clientes no downloadWithYtDlp e Instagram
{
  const withCookiesAttempts = buildYtDlpAttempts('https://www.youtube.com/watch?v=kXYiU_JCYtU', true);
  assert(withCookiesAttempts.length >= 4);
  assert.strictEqual(withCookiesAttempts[0].withCookies, true);
  assert.strictEqual(withCookiesAttempts[0].client, null, 'Com cookies, deve tentar primeiro o cliente padrão (tv_samsung/web_embedded/web)');
  assert(
    !withCookiesAttempts.some((a) => a.withCookies && ['tv_simply', 'android', 'android_vr', 'ios'].includes(a.client)),
    'Não deve combinar cookies com clientes que rejeitam cookies (tv_simply/android/android_vr/ios)'
  );
  assert.notStrictEqual(withCookiesAttempts[0].client, 'web_safari', 'web_safari força SABR com cookies e não pode ser o primeiro');

  const noCookiesAttempts = buildYtDlpAttempts('https://www.youtube.com/watch?v=kXYiU_JCYtU', false);
  assert.strictEqual(noCookiesAttempts[0].withCookies, false);
  assert.strictEqual(noCookiesAttempts[0].client, null, 'Sem cookies, também deve priorizar o cliente padrão');

  const tiktokAttempts = buildYtDlpAttempts('https://www.tiktok.com/@user/video/123', true);
  assert.strictEqual(tiktokAttempts.length, 1, 'URL não-YouTube não deve repetir 8 clientes do YouTube');
  assert.strictEqual(tiktokAttempts[0].withCookies, false);

  const igWithCookies = buildInstagramYtDlpAttempts(true);
  assert.strictEqual(igWithCookies[0].withCookies, true);
  assert(igWithCookies.some((a) => !a.withCookies && a.impersonate), 'Instagram deve ter fallback com impersonate');

  const igNoCookies = buildInstagramYtDlpAttempts(false);
  assert(igNoCookies.every((a) => !a.withCookies), 'Sem INSTAGRAM_COOKIES não deve passar cookies');
}

// 5. Argumentos de busca/metadados (--dump-json) não devem travar em web_safari
{
  const searchArgs = buildYtDlpSearchArgs('ytsearch1:Linkin Park Numb', true);
  assert(!searchArgs.includes('youtube:player_client=web_safari'), 'Busca não deve forçar player_client=web_safari');
  assert(searchArgs.includes('--flat-playlist'), 'ytsearch1 deve usar --flat-playlist para busca rápida');
  assert(searchArgs.includes('--ignore-no-formats-error'), 'Busca deve tolerar ausência de formatos');
  assert(searchArgs.includes('--dump-json'));
}

// 6. Seleção de binário por plataforma e detecção de erro que exige update do yt-dlp
{
  assert.strictEqual(getYtDlpBinaryAssetForPlatform('win32', 'x64'), 'yt-dlp.exe');
  assert.strictEqual(getYtDlpBinaryAssetForPlatform('linux', 'x64'), 'yt-dlp_linux');
  assert.strictEqual(getYtDlpBinaryAssetForPlatform('linux', 'arm64'), 'yt-dlp_linux_aarch64');
  assert.strictEqual(getYtDlpBinaryAssetForPlatform('darwin', 'arm64'), 'yt-dlp_macos');

  assert.strictEqual(needsYtDlpUpdateFromError('TypeError: a.addOnDisposeCallback is not a function'), true);
  assert.strictEqual(needsYtDlpUpdateFromError('WARNING: Signature solving failed: Some formats may be missing'), true);
  assert.strictEqual(needsYtDlpUpdateFromError('ERROR: [youtube] xyz: The page needs to be reloaded.'), true);
  assert.strictEqual(needsYtDlpUpdateFromError('ERROR: [youtube] xyz: Video unavailable'), false);
}

// 7. TikWM throttle/retry em rate limit e detecção de carrossel de fotos do TikTok
{
  resetTikWmThrottleForTest();
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { data: { code: -1, msg: 'Free Api Limit: 1 request/second.' } };
    }
    return { data: { code: 0, data: { play: 'https://cdn.example/video.mp4', title: 'ok' } } };
  };
  const res = await callTikWmApi('https://www.tiktok.com/@u/video/1', mockFetch);
  assert.strictEqual(calls, 2, 'Deve tentar novamente quando TikWM retornar Free Api Limit');
  assert.strictEqual(res.code, 0);

  assert.strictEqual(
    isTikTokPhotoSlideshow({ images: ['https://img/1.jpg'], play: 'https://cdn/audio.mp3', duration: 0 }),
    true,
    'Carrossel de fotos do TikTok deve ser detectado'
  );
  assert.strictEqual(
    isTikTokPhotoSlideshow({ images: [], play: 'https://cdn/video.mp4', duration: 15 }),
    false
  );
}

console.log('✅ Todos os testes de YouTube, Instagram, TikTok e yt-dlp passaram!');
