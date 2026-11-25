import assert from 'assert';
import {
  CATEGORIAS,
  comandosDoMenu,
  buildMenu,
  buildLegendaMenu,
  encontrarCategoriaMenu,
  buildMenuCategoria,
} from '../src/config/menu.js';

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

console.log('✅ Todos os testes de menu.js passaram com sucesso!');
