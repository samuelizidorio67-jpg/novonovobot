import { getDatabase, updateDatabase } from '../database.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import dotenv from 'dotenv';
import { grupoApenas, adminOuDonoApenas, donoApenas, botPrecisaAdmin, marcaAlguem, alvoNaoEncontrado, aviso, erro, uso, estado } from '../config/messages.js';
import { extractContextInfo } from '../utils/viewOnceManager.js';
dotenv.config();

const groupMetaCache = new Map();
const GROUP_META_TTL_MS = 60 * 1000;

async function getGroupMetadataCached(sock, groupJid) {
  if (!sock?.groupMetadata || !groupJid?.endsWith('@g.us')) return null;
  const cached = groupMetaCache.get(groupJid);
  if (cached && Date.now() - cached.at < GROUP_META_TTL_MS) {
    return cached.data;
  }
  try {
    const data = await sock.groupMetadata(groupJid);
    groupMetaCache.set(groupJid, { at: Date.now(), data });
    return data;
  } catch (_) {
    return null;
  }
}

// Normaliza um JID para comparação (minúsculo, sem sufixo de dispositivo)
function normJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try {
    return jidNormalizedUser(jid).toLowerCase();
  } catch (_) {
    return jid.split(':')[0].toLowerCase();
  }
}

// Heurística numérica só faz sentido entre JIDs de telefone.
// LIDs (@lid) são IDs opacos — comparar dígitos deles com telefones erra.
export function isPhoneJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
}

function phoneDigits(jid) {
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function phoneDigitsMatch(a, b) {
  if (!isPhoneJid(a) || !isPhoneJid(b)) return false;
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db || da.length < 8 || db.length < 8) return false;
  return da === db || da.endsWith(db.slice(-8)) || db.endsWith(da.slice(-8));
}

// Verifica se o JID é o dono do bot
export function checkIfOwner(sender, msg = null) {
  if (msg?.key?.fromMe) return true;

  const ownerEnv = process.env.OWNER_NUMBER || process.env.BOT_NUMERO || '5571981756869,557181756869';
  const ownerList = ownerEnv.split(/[,;\s]+/).map(num => num.replace(/\D/g, '')).filter(Boolean);

  if (ownerList.length === 0) {
    return msg?.key?.fromMe === true;
  }

  const rawRemote = msg?.key?.remoteJid;
  const isGroup = typeof rawRemote === 'string' && rawRemote.endsWith('@g.us');

  const candidates = [
    sender,
    msg?.key?.participantPn,
    msg?.key?.senderPn,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    !isGroup ? rawRemote : null
  ].filter(Boolean);

  for (const cand of candidates) {
    if (!isPhoneJid(cand)) continue;

    const cleanCand = phoneDigits(cand);
    if (!cleanCand || cleanCand.length < 8) continue;

    const cand8 = cleanCand.slice(-8);

    for (const owner of ownerList) {
      if (cleanCand === owner) return true;
      const owner8 = owner.slice(-8);
      if (owner8.length >= 8 && (cand8 === owner8 || cleanCand.endsWith(owner8) || owner.endsWith(cand8))) {
        return true;
      }
    }
  }

  return false;
}

// Coleta todos os identificadores válidos do remetente (PN + LID via metadados de grupo se necessário)
export async function resolveSenderCandidates(sock, from, sender, msg = null) {
  const rawRemote = msg?.key?.remoteJid;
  const isGroup = (typeof from === 'string' && from.endsWith('@g.us')) ||
                  (typeof rawRemote === 'string' && rawRemote.endsWith('@g.us'));

  const base = [
    sender,
    msg?.key?.participantPn,
    msg?.key?.senderPn,
    msg?.key?.participantAlt,
    !isGroup ? msg?.key?.remoteJidAlt : null,
    msg?.key?.participant,
    !isGroup && !msg?.key?.fromMe ? rawRemote : null
  ].filter(Boolean);

  if (isGroup && !base.some(isPhoneJid)) {
    const groupJid = (typeof from === 'string' && from.endsWith('@g.us')) ? from : rawRemote;
    const meta = await getGroupMetadataCached(sock, groupJid);
    const p = findParticipant(meta?.participants, sender || msg?.key?.participant);
    if (p) {
      if (p.jid) base.push(p.jid);
      if (p.lid) base.push(p.lid);
      if (p.id) base.push(p.id);
    }
  }

  const out = [];
  for (const c of base) {
    if (typeof c !== 'string' || c.endsWith('@g.us')) continue;
    const n = normJid(c);
    if (n && !out.includes(n)) out.push(n);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Verifica se algum dos identificadores do remetente está autorizado para /ver
export function isAuthorizedForVer(autorizadosVer = [], candidateSenders = []) {
  if (!Array.isArray(autorizadosVer) || autorizadosVer.length === 0) return false;
  if (!Array.isArray(candidateSenders) || candidateSenders.length === 0) return false;

  const normAuth = autorizadosVer.map(normJid).filter(Boolean);

  return candidateSenders.some((cand) => {
    if (typeof cand !== 'string' || cand.endsWith('@g.us')) return false;
    const normCand = normJid(cand);
    if (!normCand) return false;

    if (autorizadosVer.includes(cand) || normAuth.includes(normCand)) return true;

    if (isPhoneJid(cand)) {
      return autorizadosVer.some((auth) => phoneDigitsMatch(cand, auth));
    }
    return false;
  });
}

// Encontra o participant exato nos metadados, funcionando em grupos
// com endereçamento PN (@s.whatsapp.net) ou LID (@lid).
export function findParticipant(participants, jid) {
  if (!participants || !jid) return null;
  const norm = normJid(jid);
  if (!norm) return null;

  const exact = participants.find((p) => {
    if (!p) return false;
    if (normJid(p.id) === norm) return true;
    if (p.jid && normJid(p.jid) === norm) return true;
    if (p.lid && normJid(p.lid) === norm) return true;
    return false;
  });
  if (exact) return exact;

  // Fallback numérico SOMENTE entre JIDs de telefone
  if (isPhoneJid(jid)) {
    const d = phoneDigits(jid);
    if (!d) return null;
    return participants.find((p) => {
      if (!p) return false;
      return [p.id, p.jid].filter(isPhoneJid).some((c) => {
        const cd = phoneDigits(c);
        return cd && (cd === d || (cd.length >= 8 && d.endsWith(cd.slice(-8))) || (d.length >= 8 && cd.endsWith(d.slice(-8))));
      });
    }) || null;
  }
  return null;
}

// Verifica se um participante é admin (lê p.admin e também os flags
// isAdmin/isSuperAdmin conforme a versão do Baileys)
export function isAdmin(participants, jid) {
  const p = findParticipant(participants, jid);
  if (!p) return false;
  return p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true;
}

// Todos os JIDs candidatos do próprio bot (forma PN + forma LID).
// Em grupos LID, sock.user.id em formato PN nunca aparece na lista de
// participantes — por isso a checagem antiga sempre dizia que o bot
// "não era admin".
export function getBotJids(sock) {
  const out = [];
  const id = sock?.user?.id;
  const lid = sock?.user?.lid;
  if (id) {
    out.push(normJid(id));
    const base = String(id).split(':')[0].split('@')[0];
    if (base && /^\d+$/.test(base)) out.push(`${base}@s.whatsapp.net`);
  }
  if (lid) out.push(normJid(lid));
  return [...new Set(out.filter(Boolean))];
}

export function isBotAdmin(participants, sock) {
  return getBotJids(sock).some((j) => isAdmin(participants, j));
}

export function isBotJid(sock, jid) {
  if (!jid) return false;
  const norm = normJid(jid);
  return getBotJids(sock).includes(norm);
}

// JID correto para groupParticipantsUpdate conforme o endereçamento do grupo:
// grupo LID exige o LID; grupo PN aceita o JID de telefone.
export function participantActionJid(groupMetadata, participant) {
  if (!participant) return null;
  if (groupMetadata?.addressingMode === 'lid') {
    return participant.lid || participant.id;
  }
  return participant.jid || participant.id;
}

// Resolve um JID mencionado/citado para o participant exato dos metadados
// e já retorna o JID certo para usar na ação (remove/promote/demote).
export function resolveActionTarget(groupMetadata, jid) {
  const participants = groupMetadata?.participants;
  const participant = findParticipant(participants, jid);
  if (!participant) return null;
  return { participant, actionJid: participantActionJid(groupMetadata, participant) };
}

export async function handleAdminCommands(sock, msg, command, args, sender, mentioned) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  
  const reply = async (text, mentions = []) => {
    await sock.sendMessage(from, { text, mentions }, { quoted: msg });
  };

  let isSenderOwner = checkIfOwner(sender, msg);
  if (!isSenderOwner && isGroup) {
    const senderCandidates = await resolveSenderCandidates(sock, from, sender, msg);
    isSenderOwner = senderCandidates.some((c) => isPhoneJid(c) && checkIfOwner(c));
  }

  switch (command) {
    case 'ban': {
      if (!isGroup) {
        return reply(grupoApenas());
      }

      // Obter metadados do grupo
      let groupMetadata;
      try {
        groupMetadata = await sock.groupMetadata(from);
      } catch (err) {
        return reply(erro('Não foi possível obter os metadados do grupo.'));
      }

      const participants = groupMetadata.participants;

      // Verificar se o solicitante é admin ou dono
      const senderAdmin = isAdmin(participants, sender);
      if (!senderAdmin && !isSenderOwner) {
        return reply(adminOuDonoApenas());
      }

      // Verificar se o bot é admin (checagem compatível com grupos LID e PN)
      if (!isBotAdmin(participants, sock)) {
        return reply(botPrecisaAdmin());
      }

      // Determinar o alvo (mencionado ou citado)
      let target = mentioned[0];
      if (!target && msg.message?.extendedTextMessage?.contextInfo?.participant) {
        target = msg.message.extendedTextMessage.contextInfo.participant;
      }

      if (!target) {
        return reply(marcaAlguem());
      }

      const resolved = resolveActionTarget(groupMetadata, target);
      if (!resolved) {
        return reply(alvoNaoEncontrado());
      }
      const actionJid = resolved.actionJid;

      if (isBotJid(sock, target)) {
        return reply(aviso('Eu não posso me banir!'));
      }

      if (isPhoneJid(target) && checkIfOwner(target)) {
        return reply(aviso('Não posso banir o meu dono!'));
      }

      // Banir o participante
      try {
        if (isAdmin(participants, target)) {
          await sock.groupParticipantsUpdate(from, [actionJid], 'demote');
        }
        await sock.groupParticipantsUpdate(from, [actionJid], 'remove');
        return reply(`🔨 @${actionJid.split('@')[0]} foi banido com sucesso.`, [actionJid]);
      } catch (error) {
        console.error('Erro ao banir participante:', error);
        return reply(erro('Não foi possível remover o participante. Talvez ele seja o criador do grupo ou eu não tenha permissão.'));
      }
    }

    case 'adm': {
      if (!isSenderOwner) {
        return reply(donoApenas());
      }

      const ctx = extractContextInfo(msg);
      let target = mentioned[0] || ctx?.participant;

      if (!target) {
        return reply(marcaAlguem());
      }

      const targetJids = [normJid(target)].filter(Boolean);
      if (isGroup) {
        const meta = await getGroupMetadataCached(sock, from);
        const participant = findParticipant(meta?.participants, target);
        if (participant?.jid) targetJids.unshift(normJid(participant.jid));
        if (participant?.lid) targetJids.push(normJid(participant.lid));
      }
      const primaryTarget = targetJids.find(isPhoneJid) || targetJids[0] || target;

      let jaAutorizado = false;
      await updateDatabase((db) => {
        if (!Array.isArray(db.autorizadosVer)) db.autorizadosVer = [];
        const already = isAuthorizedForVer(db.autorizadosVer, targetJids);
        if (!already) {
          db.autorizadosVer.push(primaryTarget);
        } else {
          jaAutorizado = true;
        }
      });

      if (jaAutorizado) {
        return reply(aviso(`@${target.split('@')[0]} já está na lista de autorizados para usar /ver.`), [target]);
      }

      return reply(`🔑 @${target.split('@')[0]} foi autorizado com sucesso para usar /ver.`, [target]);
    }

    case 'remover': {
      if (!isSenderOwner) {
        return reply(donoApenas());
      }

      const ctx = extractContextInfo(msg);
      let target = mentioned[0] || ctx?.participant;

      if (!target) {
        return reply(marcaAlguem());
      }

      const targetAliases = [normJid(target)].filter(Boolean);
      if (isGroup) {
        const meta = await getGroupMetadataCached(sock, from);
        const participant = findParticipant(meta?.participants, target);
        if (participant?.id) targetAliases.push(normJid(participant.id));
        if (participant?.jid) targetAliases.push(normJid(participant.jid));
        if (participant?.lid) targetAliases.push(normJid(participant.lid));
      }

      let removido = false;
      await updateDatabase((db) => {
        if (!Array.isArray(db.autorizadosVer)) return;
        const antes = db.autorizadosVer.length;
        db.autorizadosVer = db.autorizadosVer.filter((auth) => {
          const normAuth = normJid(auth);
          if (targetAliases.includes(normAuth)) return false;
          if (targetAliases.some((t) => phoneDigitsMatch(t, auth))) return false;
          return true;
        });
        removido = db.autorizadosVer.length < antes;
      });

      if (!removido) {
        return reply(aviso(`@${target.split('@')[0]} não estava na lista de autorizados.`), [target]);
      }

      return reply(`🚫 @${target.split('@')[0]} teve sua autorização para usar /ver removida.`, [target]);
    }

    case 'antidel': {
      if (!isGroup) {
        return reply(grupoApenas());
      }

      if (!isSenderOwner) {
        return reply(donoApenas());
      }

      const param = args[0]?.toLowerCase();
      if (param !== 'on' && param !== 'off') {
        return reply(uso('/antidel on', 'Use `/antidel off` para desativar.'));
      }

      const active = param === 'on';

      updateDatabase((db) => {
        if (!db.configGrupos[from]) {
          db.configGrupos[from] = {};
        }
        db.configGrupos[from].antiDelete = active;
      });

      return reply(`🗑️ Anti-delete foi *${estado(active)}* para este grupo.`);
    }

    default:
      break;
  }
}
