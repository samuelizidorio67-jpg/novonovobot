import assert from 'assert';
import { extractViewOnce, findViewOnce, recordIncomingViewOnce, toBuffer } from '../src/utils/viewOnceManager.js';
import { checkIfOwner } from '../src/commands/admin.js';

console.log('🧪 Iniciando testes de Visualização Única e Autorização...');

// 1. Teste de Buffer conversion
const b = toBuffer({ type: 'Buffer', data: [1, 2, 3] });
assert(Buffer.isBuffer(b), 'Deve converter objeto Buffer para Buffer real');
assert.strictEqual(b.length, 3);

// 2. Teste de extração de ViewOnce
const dummyImageVO = {
  viewOnceMessageV2: {
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/test',
        mimetype: 'image/jpeg',
        mediaKey: Buffer.from('test-key-12345678901234567890123456789012'),
        directPath: '/v/t62.7118-24/test'
      }
    }
  }
};

const extracted = extractViewOnce(dummyImageVO);
assert(extracted !== null, 'Deve extrair viewOnceMessageV2');
assert.strictEqual(extracted.mediaType, 'image');
assert.strictEqual(extracted.content.url, 'https://mmg.whatsapp.net/test');

// 3. Teste de cache de mensagem recebida
const dummyMsg = {
  key: {
    remoteJid: '120363040000000000@g.us',
    id: 'MSG_TEST_123',
    participant: '557199999999@s.whatsapp.net'
  },
  message: dummyImageVO
};

recordIncomingViewOnce(dummyMsg);

// 4. Teste de busca por quoted stanzaId
const foundQuoted = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_1' }, message: {} },
  '120363040000000000@g.us',
  { stanzaId: 'MSG_TEST_123' }
);
assert(foundQuoted !== null, 'Deve encontrar pelo stanzaId citado');
assert.strictEqual(foundQuoted.id, 'MSG_TEST_123');

// 5. Teste de busca como fallback no chat (sem citar)
const foundLast = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_2' }, message: {} },
  '120363040000000000@g.us',
  {}
);
assert(foundLast !== null, 'Deve encontrar a última mídia do chat como fallback');
assert.strictEqual(foundLast.id, 'MSG_TEST_123');

// 6. Teste de checkIfOwner
assert(checkIfOwner('5571981756869@s.whatsapp.net') === true, 'Owner 9 dígitos deve ser reconhecido');
assert(checkIfOwner('557181756869@s.whatsapp.net') === true, 'Owner 8 dígitos deve ser reconhecido');
assert(checkIfOwner('random_lid@lid', { key: { participantPn: '557181756869@s.whatsapp.net' } }) === true, 'LID com participantPn do dono deve ser reconhecido');
assert(checkIfOwner('5511999999999@s.whatsapp.net') === false, 'Estranho não deve ser reconhecido como dono');

console.log('✅ Todos os testes de /ver e permissões passaram com sucesso!');
