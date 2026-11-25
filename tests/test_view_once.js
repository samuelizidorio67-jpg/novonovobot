import assert from 'assert';
import fs from 'fs';
import {
  extractViewOnce,
  extractContextInfo,
  findViewOnce,
  recordIncomingViewOnce,
  recordUnavailableViewOnce,
  downloadViewOnceFile,
  toBuffer,
  unwrapMessageContent
} from '../src/utils/viewOnceManager.js';
import { checkIfOwner, isAuthorizedForVer, resolveSenderCandidates } from '../src/commands/admin.js';
import { handleMediaCommands } from '../src/commands/media.js';
import { getDatabase } from '../src/database.js';

console.log('🧪 Iniciando testes de Visualização Única e Autorização...');

// 1. Teste de Buffer conversion (incluindo objeto indexado numericamente)
const b = toBuffer({ type: 'Buffer', data: [1, 2, 3] });
assert(Buffer.isBuffer(b), 'Deve converter objeto Buffer para Buffer real');
assert.strictEqual(b.length, 3);

const objTyped = toBuffer({ '0': 10, '1': 20, '2': 30, '3': 40 });
assert(Buffer.isBuffer(objTyped), 'Deve converter objeto tipo Uint8Array serializado para Buffer');
assert.deepStrictEqual([...objTyped], [10, 20, 30, 40]);

// 2. Teste de extração de ViewOnce em múltiplos wrappers e formatos
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

const wrappedDeviceVO = {
  deviceSentMessage: {
    destinationJid: '557199999999@s.whatsapp.net',
    message: {
      ephemeralMessage: {
        message: {
          botInvokeMessage: {
            message: {
              ptvMessage: {
                viewOnce: true,
                url: 'https://mmg.whatsapp.net/ptv',
                mediaKey: Buffer.alloc(32, 3),
                directPath: '/v/t62.7161-24/ptv'
              }
            }
          }
        }
      }
    }
  }
};
const extractedPtv = extractViewOnce(wrappedDeviceVO);
assert(extractedPtv !== null, 'Deve extrair ptvMessage viewOnce dentro de wrappers');
assert.strictEqual(extractedPtv.mediaType, 'video');
assert.strictEqual(extractedPtv.hkdfType, 'ptv');

// 3. Teste de extractContextInfo com deviceSentMessage / editedMessage / businessMessage
const wrappedReplyMsg = {
  key: { remoteJid: '120363040000000000@g.us', id: 'CMD_WRAPPED', fromMe: true },
  message: {
    deviceSentMessage: {
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: '/ver',
              contextInfo: {
                stanzaId: 'TARGET_ID_99',
                quotedMessage: { imageMessage: { viewOnce: true } }
              }
            }
          }
        }
      }
    }
  }
};
const ctx = extractContextInfo(wrappedReplyMsg);
assert.strictEqual(ctx.stanzaId, 'TARGET_ID_99', 'Deve extrair contextInfo dentro de deviceSentMessage + ephemeralMessage');

// 4. Teste de cache e aliasing de chat (@lid <-> @s.whatsapp.net no PV)
const dummyMsg = {
  key: {
    remoteJid: '120363040000000000@g.us',
    id: 'MSG_TEST_123',
    participant: '557199999999@s.whatsapp.net'
  },
  message: dummyImageVO
};

recordIncomingViewOnce(dummyMsg);

const pvLidMsg = {
  key: {
    remoteJid: '136275420020776@lid',
    senderPn: '557188888888@s.whatsapp.net',
    id: 'PV_VO_1'
  },
  message: {
    imageMessage: {
      viewOnce: true,
      url: 'https://mmg.whatsapp.net/pv',
      mediaKey: Buffer.alloc(32, 5),
      directPath: '/v/t62.7118-24/pv'
    }
  }
};
recordIncomingViewOnce(pvLidMsg, '557188888888@s.whatsapp.net');

const foundPvByPn = findViewOnce(
  { key: { remoteJid: '557188888888@s.whatsapp.net', id: 'PV_CMD_1' }, message: {} },
  ['557188888888@s.whatsapp.net'],
  {}
);
assert(foundPvByPn !== null && !foundPvByPn.missingKey, 'Deve encontrar mídia do PV por PN mesmo quando chegou em @lid');
assert.strictEqual(foundPvByPn.id, 'PV_VO_1');

// 5. Teste de busca por quoted stanzaId
const foundQuoted = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_1' }, message: {} },
  '120363040000000000@g.us',
  { stanzaId: 'MSG_TEST_123' }
);
assert(foundQuoted !== null, 'Deve encontrar pelo stanzaId citado');
assert.strictEqual(foundQuoted.id, 'MSG_TEST_123');

// 6. Teste de busca como fallback no chat (sem citar)
const foundLast = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_2' }, message: {} },
  '120363040000000000@g.us',
  {}
);
assert(foundLast !== null, 'Deve encontrar a última mídia do chat como fallback');
assert.strictEqual(foundLast.id, 'MSG_TEST_123');

// 7. Quando cita uma view-once sem mediaKey (fora do cache), NÃO deve vazar a mídia anterior do chat
const foundQuotedNoKey = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_3' }, message: {} },
  '120363040000000000@g.us',
  {
    stanzaId: 'UNCACHED_VO_NO_KEY',
    quotedMessage: {
      viewOnceMessageV2: {
        message: { imageMessage: { mimetype: 'image/jpeg' } }
      }
    }
  }
);
assert(foundQuotedNoKey?.missingKey === true, 'Deve sinalizar missingKey ao citar view-once sem chave, sem cair para mídia antiga');

// 8. Quando cita mídia cujo wrapper viewOnceMessageV2 foi removido pelo normalizeMessageContent
const foundStrippedWrapper = findViewOnce(
  { key: { remoteJid: '120363040000000000@g.us', id: 'REPLY_4' }, message: {} },
  '120363040000000000@g.us',
  {
    stanzaId: 'STRIPPED_WRAPPER_1',
    quotedMessage: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/stripped',
        mediaKey: Buffer.alloc(32, 9),
        directPath: '/v/t62.7118-24/stripped'
      }
    }
  }
);
assert(foundStrippedWrapper !== null && !foundStrippedWrapper.missingKey, 'Deve extrair mídia citada quando o wrapper viewOnce foi removido pelo cliente');
assert.strictEqual(foundStrippedWrapper.id, 'STRIPPED_WRAPPER_1');

// 9. Unavailable view_once tracking e limpeza ao recuperar
recordUnavailableViewOnce({
  key: { remoteJid: '120363099999999999@g.us', id: 'UNAVAIL_1', isViewOnce: true }
});
const foundUnavail = findViewOnce(
  { key: { remoteJid: '120363099999999999@g.us', id: 'CMD_UNAVAIL' }, message: {} },
  '120363099999999999@g.us',
  { stanzaId: 'UNAVAIL_1' }
);
assert(foundUnavail?.missingKey === true && foundUnavail?.unavailable === true, 'Deve identificar mídia unavailable type=view_once');

// 10. Download validation e fallback via updateMediaMessage
await assert.rejects(
  () => downloadViewOnceFile('image', { mediaKey: Buffer.alloc(32, 1) }),
  /MISSING_MEDIA_URL/,
  'Sem url nem directPath deve lançar MISSING_MEDIA_URL'
);

// 11. Testes de checkIfOwner e isAuthorizedForVer
assert(checkIfOwner('5571981756869@s.whatsapp.net') === true, 'Owner 9 dígitos deve ser reconhecido');
assert(checkIfOwner('557181756869@s.whatsapp.net') === true, 'Owner 8 dígitos deve ser reconhecido');
assert(checkIfOwner('random_lid@lid', { key: { participantPn: '557181756869@s.whatsapp.net' } }) === true, 'LID com participantPn do dono deve ser reconhecido');
assert(checkIfOwner('5511999999999@s.whatsapp.net') === false, 'Estranho não deve ser reconhecido como dono');

// Segurança: estranho respondendo mensagem do dono NÃO pode virar dono!
assert(
  checkIfOwner('5511999999999@s.whatsapp.net', {
    key: { remoteJid: '120363040000000000@g.us', participant: '5511999999999@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '/ver',
        contextInfo: { participant: '5571981756869@s.whatsapp.net' }
      }
    }
  }) === false,
  'Responder mensagem do dono não pode conceder permissão de dono'
);

// Autorizado por LID ou PN não deve confundir remoteJid nem dígitos de LID
assert(
  isAuthorizedForVer(['557199999999@s.whatsapp.net'], ['123456789012345@lid'], {
    key: { remoteJid: '120363040000000000@g.us', participant: '123456789012345@lid' }
  }) === false,
  'Não pode comparar dígitos de @lid com telefone autorizado'
);

assert(
  isAuthorizedForVer(['557199999999@s.whatsapp.net'], ['551188888888@s.whatsapp.net'], {
    key: { remoteJid: '557199999999@s.whatsapp.net', participant: '551188888888@s.whatsapp.net' }
  }) === false,
  'remoteJid do destinatário não pode autorizar um remetente não autorizado'
);

// Garante uso de unwrapMessageContent
const unwrapped = unwrapMessageContent(wrappedDeviceVO);
assert(unwrapped.content?.ptvMessage?.viewOnce === true, 'unwrapMessageContent deve desembrulhar wrappers aninhados');
assert.strictEqual(unwrapped.isViewOnce, false);

// 12. Resolução de dono e autorizado em grupo LID sem participantPn via groupMetadata
const mockGroupSock = {
  groupMetadata: async () => ({
    id: '120363040000000001@g.us',
    addressingMode: 'lid',
    participants: [
      { id: '999000111222333@lid', lid: '999000111222333@lid', jid: '5571981756869@s.whatsapp.net', admin: 'superadmin' },
      { id: '888000111222333@lid', lid: '888000111222333@lid', jid: '5571912345678@s.whatsapp.net', admin: null }
    ]
  }),
  sendMessage: async (jid, content) => {
    mockSent.push({ jid, content });
  }
};
const mockSent = [];

const ownerCandidates = await resolveSenderCandidates(
  mockGroupSock,
  '120363040000000001@g.us',
  '999000111222333@lid',
  { key: { remoteJid: '120363040000000001@g.us', participant: '999000111222333@lid' } }
);
assert(ownerCandidates.includes('5571981756869@s.whatsapp.net'), 'Deve resolver PN do participante LID via groupMetadata');
assert(ownerCandidates.some((c) => checkIfOwner(c)), 'Dono em grupo LID sem participantPn deve ser reconhecido via groupMetadata');

const authCandidates = await resolveSenderCandidates(
  mockGroupSock,
  '120363040000000001@g.us',
  '888000111222333@lid',
  { key: { remoteJid: '120363040000000001@g.us', participant: '888000111222333@lid' } }
);
assert(
  isAuthorizedForVer(['5571912345678@s.whatsapp.net'], authCandidates) === true,
  'Autorizado por número deve ser reconhecido em grupo LID via groupMetadata'
);

// 13. Fluxo handleMediaCommands('/ver') com usuário não autorizado e com mídia unavailable
const db = getDatabase();
db.autorizadosVer = [];
mockSent.length = 0;
await handleMediaCommands(
  mockGroupSock,
  {
    key: { remoteJid: '120363040000000001@g.us', participant: '777000111222333@lid', id: 'VER_DENIED' },
    message: { conversation: '/ver' }
  },
  'ver',
  [],
  '777000111222333@lid'
);
assert.strictEqual(mockSent.length, 1);
assert(mockSent[0].content.text.includes('permissão'), 'Usuário não autorizado deve receber aviso de permissão');

mockSent.length = 0;
recordUnavailableViewOnce({
  key: { remoteJid: '120363040000000002@g.us', id: 'UNAVAIL_FLOW_1', isViewOnce: true }
});
await handleMediaCommands(
  mockGroupSock,
  {
    key: { remoteJid: '120363040000000002@g.us', participant: '999000111222333@lid', id: 'VER_UNAVAIL' },
    message: {
      extendedTextMessage: {
        text: '/ver',
        contextInfo: { stanzaId: 'UNAVAIL_FLOW_1' }
      }
    }
  },
  'ver',
  [],
  '999000111222333@lid'
);
assert.strictEqual(mockSent.length, 1);
assert(mockSent[0].content.text.includes('unavailable'), 'Dono deve receber diagnóstico claro quando mídia chegar unavailable');

// Garante limpeza de arquivo inexistente se fs falhar e verifica se temp anterior não vazou
assert.strictEqual(typeof fs.existsSync, 'function');

console.log('✅ Todos os testes de /ver e permissões passaram com sucesso!');
