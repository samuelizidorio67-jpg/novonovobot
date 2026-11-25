import assert from 'assert';
import { AutoReply } from '../src/interaction/AutoReply.js';
import { PersonalityManager, QUINTUPLETS } from '../src/interaction/PersonalityManager.js';
import { conversationMemory } from '../src/interaction/ConversationMemory.js';
import { ContextManager } from '../src/interaction/ContextManager.js';

console.log('🧪 Iniciando testes de AutoReply (sem personagens quíntuplas) e memória...');

const sentMessages = [];
const mockSock = {
  user: { id: '5571981756869:1@s.whatsapp.net', lid: '111222333444@lid' },
  sendPresenceUpdate: async () => {},
  sendMessage: async (jid, content, options) => {
    sentMessages.push({ jid, content, options });
    return { key: { id: 'BOT_MSG_' + sentMessages.length } };
  }
};

const groupJid = '120363040000000000@g.us';
const userJid = '5571999999999@s.whatsapp.net';

// 1. Mencionar miku, nino, itsuki, yotsuba ou ichika em grupo NÃO deve acionar o bot
const triggerTexts = [
  'miku',
  'nino',
  'itsuki',
  'yotsuba',
  'ichika',
  'Miku, o que você acha disso?',
  'Nino você sabe fazer bolo?',
  'Ichika, Yotsuba e Itsuki apareceram no episódio'
];

for (const text of triggerTexts) {
  sentMessages.length = 0;
  const replied = await AutoReply.processMessage(
    mockSock,
    {
      key: { remoteJid: groupJid, participant: userJid, id: 'MSG_' + Math.random() },
      pushName: 'Usuário',
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000)
    },
    text
  );
  assert.strictEqual(replied, false, `Bot não deve responder automaticamente para "${text}"`);
  assert.strictEqual(sentMessages.length, 0, `Nenhuma mensagem deve ser enviada para "${text}"`);
}

// 2. PersonalityManager não deve detectar nem ativar personagens das quíntuplas
for (const name of ['miku', 'nino', 'itsuki', 'yotsuba', 'ichika']) {
  assert.strictEqual(
    PersonalityManager.detectMentionedQuintuplet(`Oi ${name}, tudo bem?`),
    null,
    `detectMentionedQuintuplet deve retornar null para ${name}`
  );
  assert.strictEqual(QUINTUPLETS[name], undefined, `Personagem ${name} não deve estar ativo em QUINTUPLETS`);
}

// 3. System instruction deve usar a persona padrão do Seiha mesmo se passar quintupletId antigo
const prompt = PersonalityManager.getSystemInstruction({
  quintupletId: 'miku',
  groupName: 'Grupo Teste',
  userName: 'Carlos',
  userFacts: ['Gosta de café']
});
assert.ok(prompt.includes('Seiha'), 'System prompt deve usar a identidade do Seiha');
assert.ok(!/(NINO|MIKU|ICHIKA|YOTSUBA|ITSUKI)\s+NAKANO/i.test(prompt), 'System prompt não pode conter persona das irmãs Nakano');
assert.ok(prompt.includes('Gosta de café'), 'Deve manter fatos do usuário');

// 4. ContextManager.buildContext não deve expor activeQuintuplet de personagem
const builtCtx = await ContextManager.buildContext(
  { groupMetadata: async () => ({ subject: 'Grupo Teste' }) },
  { key: { remoteJid: groupJid, participant: userJid, id: 'CTX_1' }, pushName: 'Carlos' }
);
assert.strictEqual(builtCtx.activeQuintuplet, undefined, 'Contexto não deve definir activeQuintuplet');

// 5. ConversationMemory continua estruturando histórico multi-turn normalmente
conversationMemory.clearHistory(groupJid);
conversationMemory.addMessage(groupJid, {
  id: 'M1',
  sender: userJid,
  senderName: 'Carlos',
  text: 'Oi Seiha, tudo bem?',
  isBot: false
});
conversationMemory.addMessage(groupJid, {
  id: 'M2',
  sender: '5571981756869@s.whatsapp.net',
  senderName: 'Seiha',
  text: 'Tudo ótimo por aqui!',
  isBot: true
});
const multiTurn = conversationMemory.getMultiTurnMessages(groupJid, prompt, 'Qual meu gosto?', 10);
assert.strictEqual(multiTurn[0].role, 'system');
assert.strictEqual(multiTurn[1].role, 'user');
assert.strictEqual(multiTurn[2].role, 'assistant');
assert.strictEqual(multiTurn[3].role, 'user');

console.log('✅ Todos os testes de AutoReply sem quíntuplas e memória passaram com sucesso!');
