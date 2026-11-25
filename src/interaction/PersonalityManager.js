/**
 * PersonalityManager.js
 * Gerencia a identidade padrão do bot (Seiha) e o contexto de memórias do usuário.
 */

import { BOT_NAME } from '../config/messages.js';

const DEFAULT_PERSONA = {
  id: 'padrao',
  name: BOT_NAME,
  nickname: BOT_NAME,
  title: `🤖 Assistente do ${BOT_NAME}`,
  personalityDescription: 'Assistente virtual inteligente, amigável e direto para WhatsApp.',
  systemPrompt: `Você é o ${BOT_NAME}, um assistente virtual amigável, inteligente e prestativo para WhatsApp. Responda em Português do Brasil com clareza, naturalidade e bom humor, sem interpretar personagens de anime.`
};

export const QUINTUPLETS = {
  padrao: DEFAULT_PERSONA
};

export class PersonalityManager {
  /**
   * Mantido por compatibilidade de interface; não detecta mais personagens.
   * @returns {null}
   */
  static detectMentionedQuintuplet() {
    return null;
  }

  /**
   * Obtém a instrução de sistema formatada com a identidade do bot e memórias do usuário
   * @param {Object} params Configurações de contexto
   * @returns {string} System instruction completa
   */
  static getSystemInstruction({
    groupName = 'Privado',
    userName = 'Amigo',
    userMemories = [],
    userFacts = []
  } = {}) {
    const char = DEFAULT_PERSONA;

    const allMemories = [...new Set([...userMemories, ...userFacts])];
    const memoriesFormatted = allMemories.length > 0
      ? allMemories.map(m => `• ${m}`).join('\n')
      : 'Nenhuma informação específica gravada ainda.';

    return `${char.systemPrompt}

═══════════════════════════════════════════════
📜 CONTEXTO DO DIÁLOGO & MEMÓRIA DO USUÁRIO:
- Seu nome: ${char.name}
- Local da conversa: ${groupName}
- Nome de quem está falando com você: ${userName}

🧠 MEMÓRIAS E FATOS LEMBRADOS SOBRE ${userName.toUpperCase()}:
${memoriesFormatted}

═══════════════════════════════════════════════
🎯 REGRAS IMPORTANTES PARA SUAS RESPOSTAS:
1. Responda sempre como ${char.name}, de forma natural e direta.
2. Utilize as memórias acima de forma sutil quando fizer sentido.
3. Mantenha as respostas curtas e adequadas ao WhatsApp (de 1 a 4 frases).
4. Responda sempre em Português do Brasil.`;
  }
}
