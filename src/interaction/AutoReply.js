/**
 * AutoReply.js
 * Gerencia respostas automáticas em grupos apenas quando o bot é mencionado
 * ou respondido diretamente.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { conversationMemory } from './ConversationMemory.js';
import { ContextManager } from './ContextManager.js';
import { AIService } from './AIService.js';
import { BOT_NAME } from '../config/messages.js';
import { extractContextInfo } from '../utils/viewOnceManager.js';

function normJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    return jidNormalizedUser(jid).toLowerCase();
  } catch (_) {
    return jid.split(':')[0].toLowerCase();
  }
}

export class AutoReply {
  /**
   * Processa uma mensagem não-comando e decide se o bot deve responder.
   * @param {Object} sock Instância do Baileys
   * @param {Object} msg Objeto da mensagem Baileys
   * @param {string} text Texto limpo da mensagem
   * @returns {Promise<boolean>} True se respondeu, false caso contrário
   */
  static async processMessage(sock, msg, text) {
    if (!text || !text.trim()) return false;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = msg.key.participant || msg.key.remoteJid;
    const userName = msg.pushName || sender.split('@')[0];

    // Registra a mensagem no aprendizado de fatos
    ContextManager.detectAndLearnFact(sender, text);

    // Registra no histórico do grupo/chat para contexto quando for chamado
    conversationMemory.addMessage(from, {
      id: msg.key.id,
      sender,
      senderName: userName,
      text,
      timestamp: msg.messageTimestamp,
      isBot: false
    });

    // Identificar JIDs do Bot (PN e LID)
    const rawBotId = sock.user?.id || '';
    const botNum = rawBotId.split(':')[0].split('@')[0];
    const botJid = botNum ? `${botNum}@s.whatsapp.net` : '';
    const botLid = normJid(sock.user?.lid || '');

    // Contexto de citação/menção
    const contextInfo = extractContextInfo(msg);
    const mentionedJids = (contextInfo?.mentionedJid || []).map(normJid).filter(Boolean);
    const quotedParticipant = normJid(contextInfo?.participant || '');

    // 1. Menção direta ao bot (por tag @seiha ou @JID do bot — sem nomes de personagens)
    const isMentionedByName = /@(seiha|whatsappautomationbot|automationbot)\b/i.test(text);
    const isMentionedByJid = Boolean(
      (botJid && mentionedJids.includes(normJid(botJid))) ||
      (botLid && mentionedJids.includes(botLid))
    );
    const isMentioned = isMentionedByName || isMentionedByJid;

    // 2. Resposta direta (citando) a uma mensagem do Bot
    const isReplyingToBot = Boolean(
      quotedParticipant && (
        (botJid && quotedParticipant === normJid(botJid)) ||
        (botLid && quotedParticipant === botLid) ||
        (botNum && quotedParticipant.split('@')[0] === botNum)
      )
    );

    // Responde apenas em grupos quando mencionado ou citado diretamente (nunca no PV nem por palavras soltas)
    if (isGroup && (isMentioned || isReplyingToBot)) {
      let cleanPrompt = text
        .replace(/@(seiha|whatsappautomationbot|automationbot)\b/gi, '');
      if (botNum) {
        cleanPrompt = cleanPrompt.replace(new RegExp(`@${botNum}\\b`, 'g'), '');
      }
      cleanPrompt = cleanPrompt.trim() || 'Olá!';

      await sock.sendPresenceUpdate?.('composing', from).catch(() => {});

      const context = await ContextManager.buildContext(sock, msg);
      const replyText = await AIService.generateReply(context, cleanPrompt);

      if (replyText) {
        const sentMsg = await sock.sendMessage(from, { text: replyText }, { quoted: msg });

        if (sentMsg) {
          conversationMemory.addMessage(from, {
            id: sentMsg.key.id,
            sender: botJid || rawBotId,
            senderName: BOT_NAME,
            text: replyText,
            timestamp: Math.floor(Date.now() / 1000),
            isBot: true
          });
        }
        return true;
      }
    }

    return false;
  }
}
