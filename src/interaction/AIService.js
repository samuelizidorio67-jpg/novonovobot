/**
 * AIService.js
 * Módulo de interação com a Inteligência Artificial do Seiha.
 */

import { askAiChat } from '../utils/aiService.js';
import { PersonalityManager, QUINTUPLETS } from './PersonalityManager.js';
import { conversationMemory } from './ConversationMemory.js';
import { BOT_NAME } from '../config/messages.js';

export class AIService {
  /**
   * Gera uma resposta contextualizada e inteligente para a conversa com memória
   * @param {Object} context Objeto retornado pelo ContextManager.buildContext
   * @param {string} userPrompt Mensagem enviada pelo usuário
   * @returns {Promise<string|null>} Resposta gerada pela IA
   */
  static async generateReply(context, userPrompt) {
    try {
      const charInfo = QUINTUPLETS.padrao;

      const systemInstruction = PersonalityManager.getSystemInstruction({
        groupName: context.groupName,
        userName: context.userName,
        userFacts: context.userFacts
      });

      const messages = conversationMemory.getMultiTurnMessages(
        context.chatJid,
        systemInstruction,
        userPrompt,
        14
      );

      const response = await askAiChat(messages, { temperature: 0.7 });

      if (!response) {
        return '😅 Tive um pequeno lapso aqui... Pode repetir o que você disse?';
      }

      const cleaned = response
        .replace(new RegExp(`^${BOT_NAME}:\\s*`, 'i'), '')
        .replace(new RegExp(`^\\[${BOT_NAME}\\]:\\s*`, 'i'), '')
        .replace(new RegExp(`^${charInfo.nickname}:\\s*`, 'i'), '')
        .replace(/^WhatsApp Automation Bot:\s*/i, '')
        .replace(/^\[WhatsApp Automation Bot\]:\s*/i, '')
        .replace(/^Bot:\s*/i, '')
        .trim();

      return cleaned;
    } catch (err) {
      console.error('Erro ao gerar resposta na IA de interação:', err.message);
      return null;
    }
  }
}
