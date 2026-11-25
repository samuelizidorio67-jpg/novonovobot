/**
 * Menu do bot. Fica separado do handler para ser fácil de manter:
 * adicionar ou mudar um comando aqui não mexe na lógica de nenhum outro arquivo.
 *
 * Padrão de cada linha:  /comando <argumentos> — Descrição
 *  - argumentos entre < > são obrigatórios, [ ] são opcionais
 *  - descrição começa com verbo, sem ponto final, uma linha só
 */

import { BOT_NAME } from './messages.js';

export const CATEGORIAS = [
  {
    id: 'midia',
    tituloCurto: 'Mídia',
    aliases: ['midia', 'mídia', 'media', 'downloads', 'sticker', 'stickers'],
    emoji: '📥',
    titulo: 'MÍDIA & DOWNLOADS',
    destaques: ['play', 'video', 'tiktok', 'ig', 'sticker', 'stickersom', 'unsticker', 'ver'],
    comandos: [
      ['play <música ou link>', 'Baixar música do YouTube'],
      ['video <vídeo ou link>', 'Baixar vídeo do YouTube'],
      ['tiktok <link>', 'Baixar vídeo do TikTok sem marca d\'água'],
      ['ig <link>', 'Baixar vídeo ou Reels do Instagram'],
      ['tiktokaudio <link>', 'Baixar só o áudio de um TikTok'],
      ['igaudio <link>', 'Baixar só o áudio de um Instagram'],
      ['sticker', 'Criar figurinha de imagem ou vídeo'],
      ['sticker2', 'Figurinha com a proporção original, sem distorcer'],
      ['sticker3', 'Figurinha maior, preenchendo o quadrado'],
      ['stickersom', 'Criar figurinha com áudio (vídeo ou imagem + áudio)'],
      ['unsticker', 'Transformar figurinha em imagem'],
      ['ver', 'Revelar mídia de visualização única (restrito)'],
    ],
  },
  {
    id: 'ia',
    tituloCurto: 'IA',
    aliases: ['ia', 'ai', 'inteligencia'],
    emoji: '🤖',
    titulo: 'INTELIGÊNCIA ARTIFICIAL',
    destaques: ['ia'],
    comandos: [
      ['ia <pergunta>', 'Pesquisar na internet e responder, lembrando o fio da conversa'],
    ],
  },
  {
    id: 'estudo',
    tituloCurto: 'Estudo & Família',
    aliases: ['estudo', 'estudos', 'familia', 'família', 'shiunji'],
    emoji: '🎓',
    titulo: 'ESTUDO & FAMÍLIA',
    destaques: ['estudo', 'redacao', 'simulado', 'quiz anime', 'familia', 'rank', 'omiai', 'heranca'],
    comandos: [
      ['estudo <tema>', 'Explicar um assunto de escola ou curiosidade'],
      ['redacao <texto>', 'Corrigir redação no padrão ENEM'],
      ['simulado', 'Responder 5 perguntas valendo XP'],
      ['quiz anime', 'Quiz de anime, com perguntas do Shiunji'],
      ['familia', 'Ver a família Shiunji do grupo'],
      ['familia entrar', 'Entrar na família e receber um papel'],
      ['familia sair', 'Sair da família'],
      ['rank [xp|moedas|aura]', 'Ver o quadro de honra'],
      ['omiai @pessoa', 'Encontro arranjado com carta da Seiha'],
      ['heranca', 'Disputar a herança mensal por XP'],
    ],
  },
  {
    id: 'rpg',
    tituloCurto: 'RPG',
    aliases: ['rpg', 'batalha', 'batalhas'],
    emoji: '⚔️',
    titulo: 'RPG & BATALHAS',
    destaques: ['classe', 'missao', 'raid', 'curar', 'perfil'],
    comandos: [
      ['classe <guerreiro|mago|arqueiro>', 'Escolher a sua classe'],
      ['missao', 'Ver ou iniciar as missões do dia'],
      ['raid', 'Entrar na raid contra o chefe do grupo'],
      ['curar', 'Recuperar vida com poção ou descanso'],
      ['perfil', 'Ver nível, vida e moedas'],
    ],
  },
  {
    id: 'cassino',
    tituloCurto: 'Cassino',
    aliases: ['cassino', 'casino', 'minigames', 'jogos de aposta'],
    emoji: '🎰',
    titulo: 'CASSINO & MINIGAMES',
    destaques: ['blackjack', 'poker', 'slots', 'pescar'],
    comandos: [
      ['blackjack <aposta>', 'Jogar 21 contra a banca'],
      ['poker <aposta>', 'Disputar uma mão rápida de poker'],
      ['slots <aposta>', 'Girar o caça-níqueis'],
      ['pescar', 'Pescar peixes e itens raros'],
    ],
  },
  {
    id: 'social',
    tituloCurto: 'Social',
    aliases: ['social', 'casamento', 'casar'],
    emoji: '💍',
    titulo: 'CASAMENTO & SOCIAL',
    destaques: ['casar', 'aceitar', 'rep', 'romance', 'beijo', 'tapa'],
    comandos: [
      ['casar @pessoa', 'Fazer um pedido de casamento'],
      ['aceitar', 'Aceitar o pedido pendente'],
      ['recusar', 'Recusar o pedido pendente'],
      ['divorcio', 'Terminar o relacionamento'],
      ['rep @pessoa', 'Dar 1 ponto de reputação'],
      ['unrep @pessoa', 'Tirar 1 ponto de reputação'],
      ['romance @pessoa', 'Medir o romance do casal'],
      ['beijo @pessoa', 'Mandar um beijo animado'],
      ['tapa @pessoa', 'Dar um tapa em alguém'],
      ['mamada @pessoa', 'Brincadeira interativa'],
      ['gozar', 'Expressar pura emoção'],
    ],
  },
  {
    id: 'diversao',
    tituloCurto: 'Diversão',
    aliases: ['diversao', 'diversão', 'jogos', 'zueira'],
    emoji: '🎮',
    titulo: 'DIVERSÃO & JOGOS',
    destaques: ['ship', '8ball', 'taro', 'quiz', 'forca', 'roleta', 'ppt'],
    comandos: [
      ['ship @pessoa1 @pessoa2', 'Calcular a afinidade do casal'],
      ['8ball <pergunta>', 'Perguntar à bola 8 mística'],
      ['taro', 'Tirar uma carta de tarô'],
      ['quiz', 'Responder uma pergunta de conhecimentos gerais'],
      ['forca', 'Jogar o jogo da forca'],
      ['roleta', 'Roleta russa em grupo'],
      ['ppt <pedra|papel|tesoura>', 'Jogar pedra, papel e tesoura'],
      ['dado', 'Rolar um dado de 6 lados'],
      ['caraoucoroa <cara|coroa>', 'Jogar cara ou coroa'],
      ['gay / corno / feio / chato', 'Medidores de zueira'],
      ['gostoso / bebado / sortudo', 'Mais medidores de zueira'],
    ],
  },
  {
    id: 'admin',
    tituloCurto: 'Admin',
    aliases: ['admin', 'adm', 'administracao', 'administração', 'grupo'],
    emoji: '🛡️',
    titulo: 'ADMINISTRAÇÃO DO GRUPO',
    destaques: ['ban', 'promote', 'tagall', 'mute', 'antilink', 'antispam', 'warn', 'enquete', 'adm'],
    comandos: [
      ['ban / kick @pessoa', 'Remover um membro do grupo'],
      ['promote @pessoa', 'Promover a administrador'],
      ['demote @pessoa', 'Rebaixar um administrador'],
      ['tagall <aviso>', 'Marcar todos os membros'],
      ['mute / unmute', 'Fechar ou abrir o grupo'],
      ['antilink <on|off>', 'Bloquear links de outros sites'],
      ['antispam <on|off>', 'Bloquear flood e spam'],
      ['boasvindas <on|off>', 'Avisar quando alguém entrar'],
      ['regras', 'Ver ou definir as regras do grupo'],
      ['warn @pessoa', 'Aplicar uma advertência'],
      ['warnings @pessoa', 'Consultar as advertências'],
      ['enquete <título|opção1|opção2>', 'Criar uma enquete votável'],
      ['ticket <motivo>', 'Abrir um chamado com a administração'],
      ['antidel <on|off>', 'Apagar mensagens deletadas (dono)'],
      ['adm @pessoa', 'Autorizar alguém a usar o {prefixo}ver (dono)'],
      ['remover @pessoa', 'Tirar essa autorização (dono)'],
    ],
  },
  {
    id: 'util',
    tituloCurto: 'Utilidades',
    aliases: ['util', 'utilidades', 'info', 'informacoes', 'informações'],
    emoji: '⚙️',
    titulo: 'UTILIDADES & INFORMAÇÕES',
    destaques: ['qrcode', 'readqr', 'cep', 'lembrete', 'fila', 'ping', 'uptime', 'info', 'grupo'],
    comandos: [
      ['menu', 'Abrir este menu novamente'],
      ['qrcode <texto ou link>', 'Gerar a imagem de um QR Code'],
      ['readqr', 'Ler o QR Code de uma imagem enviada'],
      ['cep <número>', 'Buscar o endereço de um CEP'],
      ['lembrete <tempo> <texto>', 'Ser avisado depois (ex: 10m, 2h, 18:30)'],
      ['lembretes', 'Ver e cancelar seus lembretes'],
      ['fila', 'Ver o status da fila de comandos'],
      ['ping', 'Medir o tempo de resposta'],
      ['uptime', 'Ver há quanto tempo o bot está online'],
      ['info / botinfo', 'Ver informações técnicas do bot'],
      ['grupo', 'Ver os detalhes do grupo atual'],
    ],
  },
];

// Limite real da legenda de mídia no WhatsApp é 1.024. Trabalhamos com uma
// folga para não esbarrar em diferenças de contagem de bytes.
const LIMITE_LEGENDA = 1000;

function normalizarTermo(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Localiza uma categoria do menu por id, alias ou prefixo do título. */
export function encontrarCategoriaMenu(termo) {
  const alvo = normalizarTermo(termo);
  if (!alvo) return null;

  for (const categoria of CATEGORIAS) {
    if (normalizarTermo(categoria.id) === alvo) return categoria;
    if (
      Array.isArray(categoria.aliases) &&
      categoria.aliases.some((alias) => normalizarTermo(alias) === alvo)
    ) {
      return categoria;
    }
  }

  if (alvo.length >= 3) {
    for (const categoria of CATEGORIAS) {
      if (
        normalizarTermo(categoria.tituloCurto).startsWith(alvo) ||
        normalizarTermo(categoria.titulo).startsWith(alvo)
      ) {
        return categoria;
      }
    }
  }

  return null;
}

/** Formata os comandos de uma única categoria com visual limpo (sem caixas ASCII). */
export function buildMenuCategoria(categoria, { prefixo = '/' } = {}) {
  if (!categoria || !Array.isArray(categoria.comandos)) return '';

  const linhas = [`${categoria.emoji} *${categoria.titulo}*`, ''];
  for (const [usoCmd, descricao] of categoria.comandos) {
    const descFormatada = String(descricao).replace(/\{prefixo\}/g, prefixo);
    linhas.push(`${prefixo}${usoCmd} — ${descFormatada}`);
  }
  return linhas.join('\n');
}

function buildCabecalhoMenu({
  nome = BOT_NAME,
  usuario = '',
  saudacao = '👋 Olá',
  uptime = '',
  incluirUptime = true,
  incluirSaudacao = true,
} = {}) {
  const linhas = [`⚡ *${nome}*`];

  if (incluirSaudacao && (saudacao || usuario)) {
    const base = usuario
      ? `${saudacao ? `${saudacao}, ` : ''}*@${usuario}*!`
      : `${saudacao}!`;
    const parteUptime = incluirUptime && uptime ? ` • Online: *${uptime}*` : '';
    linhas.push(`${base}${parteUptime}`);
  } else if (incluirUptime && uptime) {
    linhas.push(`Online: *${uptime}*`);
  }

  return linhas;
}

/** Lista limpa com todas as categorias e descrições (sem bordas ASCII). */
export function buildMenu(opcoes = {}) {
  const prefixo = opcoes.prefixo || '/';
  const linhas = buildCabecalhoMenu(opcoes);

  for (const categoria of CATEGORIAS) {
    linhas.push('');
    linhas.push(buildMenuCategoria(categoria, { prefixo }));
  }

  linhas.push('');
  linhas.push('💡 Rode um comando sem argumentos para ver um exemplo de uso.');
  return linhas.join('\n');
}

/** Só os nomes de comando (primeira palavra) — usado em conferências. */
export function comandosDoMenu() {
  return CATEGORIAS.flatMap((c) => c.comandos.map(([usoCmd]) => usoCmd.split(' ')[0]));
}

function formatarLegenda(opcoes = {}) {
  const prefixo = opcoes.prefixo || '/';
  const linhas = buildCabecalhoMenu(opcoes);

  for (const categoria of CATEGORIAS) {
    linhas.push('');
    linhas.push(`${categoria.emoji} *${categoria.tituloCurto}* — \`${prefixo}menu ${categoria.id}\``);
    linhas.push(categoria.destaques.map((cmd) => `${prefixo}${cmd}`).join(', '));
  }

  linhas.push('');
  linhas.push(`💡 Digite \`${prefixo}menu <tema>\` para ver todos os comandos e descrições.`);
  return linhas.join('\n');
}

/**
 * Monta a legenda única do `/menu` dentro do limite de 1.024 caracteres
 * do WhatsApp, com redução progressiva de cabeçalho e corte seguro no limite.
 */
export function buildLegendaMenu(opcoes = {}) {
  const completo = formatarLegenda(opcoes);
  if (completo.length <= LIMITE_LEGENDA) return completo;

  const semUptime = formatarLegenda({ ...opcoes, incluirUptime: false });
  if (semUptime.length <= LIMITE_LEGENDA) return semUptime;

  const semCabecalho = formatarLegenda({
    ...opcoes,
    incluirUptime: false,
    incluirSaudacao: false,
  });
  if (semCabecalho.length <= LIMITE_LEGENDA) return semCabecalho;

  const prefixo = opcoes.prefixo || '/';
  const rodape = `\n\n💡 Digite \`${prefixo}menu <tema>\` para ver todos os comandos e descrições.`;
  const tetoCorpo = LIMITE_LEGENDA - rodape.length;
  const corte = semCabecalho.lastIndexOf('\n', tetoCorpo);
  const corpo = semCabecalho.slice(0, corte > 0 ? corte : Math.max(0, tetoCorpo));
  return `${corpo}${rodape}`;
}
