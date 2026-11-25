import assert from 'assert';
import {
  CATEGORIAS,
  comandosDoMenu,
  buildMenu,
  buildLegendaMenu,
  encontrarCategoriaMenu,
  buildMenuCategoria,
} from '../src/config/menu.js';
import { handleMessages } from '../src/messageHandler.js';
import queueManager from '../src/queue/QueueManager.js';

const CARACTERES_CAIXA = ['╭', '│', '╰', '◈'];

function assertSemVisualAntigo(texto, contexto) {
  for (const ch of CARACTERES_CAIXA) {
    assert(
      !texto.includes(ch),
      `${contexto} não deve conter caractere de caixa "${ch}"`
    );
  }
  assert(
    !/menu\s+completo/i.test(texto),
    `${contexto} não deve citar "/menu completo"`
  );
}

console.log('🧪 Iniciando testes do novo /menu...');

// 1. Limite de legenda e conteúdo completo das 9 categorias no /menu único
const legendaPadrao = buildLegendaMenu({
  prefixo: '/',
  usuario: '5571999999999',
  saudacao: '🌙 Boa noite',
  uptime: '97h 10m 31s',
});

assertSemVisualAntigo(legendaPadrao, 'buildLegendaMenu padrão');
assert(
  legendaPadrao.length <= 1000,
  `Legenda padrão deve caber em <= 1000 chars (atual: ${legendaPadrao.length})`
);
assert(legendaPadrao.includes('🌙 Boa noite, *@5571999999999*!'), 'Deve incluir saudação e @usuario');
assert(legendaPadrao.includes('97h 10m 31s'), 'Deve incluir uptime quando cabível');
assert(legendaPadrao.includes('/stickersom'), 'Deve listar /stickersom em Mídia');
assert(legendaPadrao.includes('/menu <tema>'), 'Deve orientar consulta por /menu <tema>');

for (const tituloEsperado of [
  'Mídia',
  'IA',
  'Estudo & Família',
  'RPG',
  'Cassino',
  'Social',
  'Diversão',
  'Admin',
  'Utilidades',
]) {
  assert(legendaPadrao.includes(tituloEsperado), `Deve incluir categoria "${tituloEsperado}"`);
}

// 2. Fallback de tamanho com usuário e uptime extensos
const legendaLonga = buildLegendaMenu({
  prefixo: '/',
  usuario: '5'.repeat(40),
  saudacao: '🌙 Boa noite',
  uptime: '1234h 56m 78s',
});
assertSemVisualAntigo(legendaLonga, 'buildLegendaMenu longo');
assert(
  legendaLonga.length <= 1000,
  `Legenda com usuário longo não deve estourar 1000 chars (atual: ${legendaLonga.length})`
);

// 3. Prefixo customizado em legenda e categoria
const legendaExclamacao = buildLegendaMenu({
  prefixo: '!',
  usuario: 'Teste',
  saudacao: '☀️ Boa tarde',
  uptime: '10m 0s',
});
assert(legendaExclamacao.includes('!stickersom'), 'Deve aplicar prefixo customizado em /stickersom');
assert(legendaExclamacao.includes('!menu estudo'), 'Deve aplicar prefixo customizado no atalho de tema');
assert(legendaExclamacao.includes('!menu <tema>'), 'Deve aplicar prefixo customizado na dica');
assert(!/\/(stickersom|menu|play|estudo)/.test(legendaExclamacao), 'Não deve vazar prefixo "/" quando prefixo="!"');

// 4. Lookup de categoria por tema (acento, maiúsculas, aliases e inválidos)
assert.strictEqual(encontrarCategoriaMenu('Estudo')?.id, 'estudo');
assert.strictEqual(encontrarCategoriaMenu('mídia')?.id, 'midia');
assert.strictEqual(encontrarCategoriaMenu('UTILIDADES')?.id, 'util');
assert.strictEqual(encontrarCategoriaMenu('ia')?.id, 'ia');
assert.strictEqual(encontrarCategoriaMenu('administracao')?.id, 'admin');
assert.strictEqual(encontrarCategoriaMenu('diversão')?.id, 'diversao');
assert.strictEqual(encontrarCategoriaMenu('completo'), null);
assert.strictEqual(encontrarCategoriaMenu('inexistente'), null);
assert.strictEqual(encontrarCategoriaMenu(''), null);
assert.strictEqual(encontrarCategoriaMenu(null), null);

// 5. Detalhamento limpo por categoria e fallback nulo
const catMidia = encontrarCategoriaMenu('midia');
const textoMidia = buildMenuCategoria(catMidia, { prefixo: '/' });
assertSemVisualAntigo(textoMidia, 'buildMenuCategoria(midia)');
assert(textoMidia.includes('MÍDIA & DOWNLOADS'), 'Deve exibir título da categoria');
assert.strictEqual(catMidia.comandos.length, 12, 'Mídia deve manter os 12 comandos cadastrados');
for (const [usoCmd, desc] of catMidia.comandos) {
  assert(
    textoMidia.includes(`/${usoCmd} — ${desc}`),
    `Categoria mídia deve listar "/${usoCmd} — ${desc}"`
  );
}

const catEstudo = encontrarCategoriaMenu('estudo');
const textoEstudoExcl = buildMenuCategoria(catEstudo, { prefixo: '!' });
assert(textoEstudoExcl.includes('!estudo <tema> — '), 'buildMenuCategoria deve respeitar prefixo customizado');
assert(!textoEstudoExcl.includes('/estudo'), 'Não deve fixar "/" quando prefixo="!"');
assert.strictEqual(buildMenuCategoria(null), '', 'Categoria nula deve retornar string vazia');

// 6. Todas as categorias sem bordas nem "menu completo" + buildMenu limpo
assert.strictEqual(CATEGORIAS.length, 9, 'Devem existir exatamente 9 categorias');
assert(comandosDoMenu().includes('stickersom'), 'comandosDoMenu deve preservar stickersom');
for (const cat of CATEGORIAS) {
  assertSemVisualAntigo(buildMenuCategoria(cat, { prefixo: '/' }), `categoria ${cat.id}`);
}
const menuCompletoLimpo = buildMenu({ prefixo: '/', usuario: 'Tester' });
assertSemVisualAntigo(menuCompletoLimpo, 'buildMenu');
assert(menuCompletoLimpo.includes('/stickersom'), 'buildMenu limpo deve incluir /stickersom');

// 7. Integração handleMessages (/menu, /menu completo, /menu <tema>, fallback sem imagem)
const origDelayMin = queueManager.minDelay;
const origDelayMax = queueManager.maxDelay;
queueManager.minDelay = 0;
queueManager.maxDelay = 0;

try {
  const senderJid = '5571999998888@s.whatsapp.net';
  const enviarParaHandler = async (texto, opts = {}) => {
    const sent = [];
    const attempts = [];
    const mockRawSock = {
      sendMessage: async (jid, content, sendOpts) => {
        attempts.push({ jid, content, sendOpts });
        if (opts.failImage && content?.image) {
          throw new Error('falha simulada ao enviar imagem');
        }
        sent.push({ jid, content, sendOpts });
        return { key: { id: `MOCK_${sent.length}` } };
      },
    };
    await handleMessages(mockRawSock, {
      key: { remoteJid: senderJid, participant: senderJid, id: `MSG_${Date.now()}` },
      pushName: 'Tester',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: texto },
    });
    return { sent, attempts };
  };

  // 7a. /menu envia exatamente 1 mensagem com imagem e legenda limpa
  const resMenu = await enviarParaHandler('/menu');
  assert.strictEqual(resMenu.sent.length, 1, '/menu deve enviar exatamente 1 mensagem');
  const payloadMenu = resMenu.sent[0].content;
  assert(Buffer.isBuffer(payloadMenu.image), '/menu deve enviar imagem em Buffer');
  assert.strictEqual(typeof payloadMenu.caption, 'string', '/menu deve enviar legenda textual');
  assertSemVisualAntigo(payloadMenu.caption, 'handleMessages /menu');
  assert(payloadMenu.caption.length <= 1000, 'Legenda enviada pelo /menu não deve passar de 1000 chars');
  assert(payloadMenu.caption.includes('/stickersom'), 'Legenda enviada deve incluir /stickersom');
  assert(payloadMenu.caption.includes('Online:'), 'Legenda enviada deve incluir uptime');
  assert(payloadMenu.mentions?.includes(senderJid), '/menu deve mencionar o remetente');

  // 7b. /menu completo legado agora também retorna o /menu único com imagem
  const resCompleto = await enviarParaHandler('/menu completo');
  assert.strictEqual(resCompleto.sent.length, 1, '/menu completo deve cair no fluxo único de 1 mensagem');
  assert(Buffer.isBuffer(resCompleto.sent[0].content.image), '/menu completo deve enviar imagem como o /menu normal');
  assertSemVisualAntigo(resCompleto.sent[0].content.caption, 'handleMessages /menu completo');

  // 7c. /menu <tema> (com e sem acento) responde texto limpo da categoria
  const resEstudo = await enviarParaHandler('/menu estudo');
  assert.strictEqual(resEstudo.sent.length, 1, '/menu estudo deve responder com 1 mensagem');
  assert(!resEstudo.sent[0].content.image, '/menu estudo não deve anexar imagem');
  assertSemVisualAntigo(resEstudo.sent[0].content.text, 'handleMessages /menu estudo');
  assert(resEstudo.sent[0].content.text.includes('ESTUDO & FAMÍLIA'), '/menu estudo deve mostrar título da categoria');
  assert(resEstudo.sent[0].content.text.includes('/estudo <tema> — '), '/menu estudo deve mostrar descrições');

  const resMidia = await enviarParaHandler('/menu Mídia');
  assert.strictEqual(resMidia.sent.length, 1);
  assert(!resMidia.sent[0].content.image);
  assertSemVisualAntigo(resMidia.sent[0].content.text, 'handleMessages /menu Mídia');
  assert(resMidia.sent[0].content.text.includes('/stickersom — '), '/menu Mídia deve incluir descrição de /stickersom');

  // 7d. Fallback para texto quando envio de imagem falha (4 tentativas na fila + 1 fallback texto)
  const resFallback = await enviarParaHandler('/menu', { failImage: true });
  assert.strictEqual(resFallback.attempts.length, 5, 'Deve tentar imagem com retries da fila e depois enviar texto no fallback');
  assert(
    resFallback.attempts.slice(0, 4).every((a) => Buffer.isBuffer(a.content?.image)),
    'Tentativas iniciais devem conter imagem'
  );
  assert.strictEqual(resFallback.sent.length, 1, 'Fallback deve entregar exatamente 1 mensagem de texto');
  assert.strictEqual(
    resFallback.sent[0].content.text,
    resFallback.attempts[0].content.caption,
    'Texto do fallback deve preservar exatamente a legenda gerada'
  );
} finally {
  queueManager.minDelay = origDelayMin;
  queueManager.maxDelay = origDelayMax;
}

console.log('✅ Todos os testes de menu.js passaram com sucesso!');
