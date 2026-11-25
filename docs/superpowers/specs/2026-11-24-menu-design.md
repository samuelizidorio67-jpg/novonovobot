# Design: `/menu` único com imagem e visual limpo

## Intenção e motivo
Substituir a dupla `/menu` (bloco apertado separado por `·`) e `/menu completo` (textão com bordas ASCII `╭───`, `│ ◈`, `╰──────`) por **um único `/menu` limpo, organizado e com imagem** da Seiha, antes de enviar todas as alterações pendentes para o GitHub.

## Objetivos, não-objetivos e restrições
- **Objetivos:**
  - Unificar em apenas `/menu` (removendo `/menu completo` e referências a ele).
  - Remover totalmente bordas ASCII (`╭`, `│`, `╰`, `◈`) de todo o código do menu.
  - Enviar **1 única mensagem** no `/menu`: foto sorteada de `assets/menu-seiha-*` com legenda limpa em texto nativo do WhatsApp (cabeçalho curto + categorias organizadas com `/` + dica de filtro por tema).
  - Suportar `/menu <tema>` opcional (ex.: `/menu estudo`, `/menu midia`) para exibir todos os comandos e descrições completas de uma categoria em formato limpo (sem caixas ASCII).
- **Não-objetivos:**
  - Gerar card gráfico em PNG com `sharp` ou dividir o `/menu` padrão em 2 mensagens.
  - Alterar a lógica de execução dos comandos listados no bot.
- **Restrições:**
  - Limite real do WhatsApp para legendas de imagem: `1.024` caracteres (`LIMITE_LEGENDA = 1000` em `src/config/menu.js`).
  - `assets/` mantém `menu-seiha-1.png`, `menu-seiha-2.jpg`, `menu-seiha-3.jpg` sorteadas por `sortearImagemMenu()` sem repetir a última.

## Abordagens consideradas
1. **Opção 1 (escolhida pelo usuário) — Foto única + legenda limpa por categoria (`<= 1.000` chars) + filtro opcional `/menu <tema>`:** mantém 1 única mensagem com imagem, texto nativo selecionável/copiável no WhatsApp e leitura limpa sem caixinhas ASCII, deixando o detalhamento completo sob demanda por tema.
2. **Opção 2 — Card visual gerado em imagem via `sharp`:** permitiria todas as 81 descrições em 1 imagem, mas exige zoom no celular e impede copiar comandos direto do texto; descartada pelo usuário.
3. **Opção 3 — Foto no topo + textão limpo em 2 mensagens:** envia 2 mensagens seguidas no chat em vez de 1 única mensagem com imagem; descartada pelo usuário.

## Desenho técnico
- **[`src/config/menu.js`](../../src/config/menu.js):**
  - Adicionar `id` e palavras-chave (`aliases`) em cada entrada de `CATEGORIAS` (`midia`, `ia`, `estudo`, `rpg`, `cassino`, `social`, `diversao`, `admin`, `util`) e lista resumida `destaques` (os comandos principais de cada categoria, com `/`) para compor a vitrine principal sem estourar `LIMITE_LEGENDA`.
  - Substituir `buildMenu` / `buildMenuCompacto` por:
    - `buildLegendaMenu({ prefixo, usuario, saudacao, uptime, nome })`: cabeçalho limpo (`⚡ *Seiha*`, saudação com `@usuario` e `Online: *uptime*`), blocos curtos por categoria (`📥 *Mídia:* /play, /video, ...`) e rodapé único orientando `💡 Use \`/menu <tema>\` para ver usos e descrições (ex: \`/menu estudo\`)`. Mantém fallback progressivo (remove `uptime`/saudação e, no pior caso, trunca em quebra de linha) garantindo `<= 1000` caracteres.
    - `encontrarCategoriaMenu(termo)`: localiza categoria por `id`, alias ou prefixo do título (ignorando acentos e maiúsculas).
    - `buildMenuCategoria(categoria, { prefixo, nome })`: formata todos os comandos daquela categoria com argumentos e descrições usando apenas título em negrito e linhas `/comando — Descrição`, sem nenhuma caixa ASCII.
  - Preservar `comandosDoMenu()` (e atualizar `buildMenu` apenas se mantido como alias limpo sem bordas ou atualizado nos callers/testes — remover o texto `╭───`/`│ ◈`/`╰───` por completo).
- **[`src/messageHandler.js`](../../src/messageHandler.js):**
  - Remover o bloco `querDetalhado` (`/menu completo`, `detalhado`, `full`, `todos`).
  - No handler de `['menu', 'help', 'bot']`: se `args[0]` corresponder a `encontrarCategoriaMenu(args[0])`, responder em texto limpo com `buildMenuCategoria(...)`; caso contrário (inclusive `/menu` sem argumentos), enviar **uma única mensagem** com `sortearImagemMenu()` e `buildLegendaMenu(...)` (com fallback para texto caso não haja imagem ou ocorra erro no envio).
- **Testes ([`tests/test_menu.js`](../../tests/test_menu.js) e ajuste em [`tests/test_audio_sticker.js`](../../tests/test_audio_sticker.js)):**
  - Validar ausência de `╭`, `│`, `╰`, `◈` e `/menu completo` em todas as saídas de `menu.js` e `/menu`.
  - Validar `buildLegendaMenu(...) <= 1000` chars mesmo com número longo e presença de `/stickersom`.
  - Validar via `handleMessages` que `/menu` envia uma única imagem com legenda, `/menu estudo` devolve os detalhes limpos da categoria `ESTUDO & FAMÍLIA` sem bordas e `/menu completo` não aciona mais o formato antigo.

## Fora do escopo imediato (deixado para o builder decidir se necessário)
- Ajuste fino de quais sinônimos entram em `destaques` dentro do teto de `1000` caracteres, desde que todas as 9 categorias e o `/stickersom` apareçam no `/menu`.
- Uso de `await` direto / envio para `origin/main` após aprovação e verificação final dos testes.
