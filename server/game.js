// Loup-Garou gabonais: game rooms and rules.
// The server holds every secret (roles, night actions, the link between night pseudos
// and real names). Each player only ever receives the view they are allowed to see.

const crypto = require("crypto");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const SCALE = Math.max(0.01, Number(process.env.TIME_SCALE) || 1); // shorter timers for tests

// Durations in seconds (see the gameplay document v2).
const T = {
  roles: 25,
  election: 45,
  action: 30,
  morning: 14,
  debateMin: 120,
  debateMax: 360,
  vote: 60,
  tiebreak: 30,
  result: 12,
};
const CHAT_CHOICES = [60, 90, 120];

const ROLES = {
  ndoki: { name: "Ndoki", camp: "ndoki", power: "Chaque nuit, choisis avec les autres Ndoki un voisin à manger. Le jour, fais-toi passer pour un habitant." },
  nganga: { name: "Nganga", camp: "village", power: "Chaque nuit, consulte les esprits et découvre le rôle d'un joueur. Une vision sur cinq est floue : tu ne vois que son camp." },
  policier: { name: "Policier", camp: "village", power: "Chaque nuit, mets un joueur au poste : il ne peut ni agir ni lire le chat de nuit. Jamais le même deux nuits de suite." },
  marabout: { name: "Marabout", camp: "village", power: "Chaque nuit, bénis un joueur pour le protéger des Ndoki. Jamais le même deux nuits de suite." },
  pasteur: { name: "Pasteur", camp: "village", power: "Une fois par partie, pendant un vote, lance ton sermon : le vote recommence à zéro." },
  gardien: { name: "Gardien des byéri", camp: "village", power: "Une fois par partie, protège un joueur pour une nuit avec le reliquaire." },
  bouc: { name: "Bouc émissaire", camp: "seul", power: "Aucun pouvoir. Tu gagnes seul si le village te chasse au vote du jour." },
  habitant: { name: "Habitant", camp: "village", power: "Aucun pouvoir. Écoute les rumeurs de la nuit, débats au maquis et trouve les Ndoki." },
};
const SECONDARY = ["policier", "marabout", "pasteur", "gardien", "bouc"];
const SECONDARY_CHANCE = { 4: 0.05, 5: 0.1, 6: 0.15, 7: 0.22, 8: 0.3, 9: 0.38, 10: 0.45 };

const PSEUDOS = [
  "Le Taximan", "La Mama", "Le Vendeur de brochettes", "La Coiffeuse", "Le Boutiquier",
  "La Tantine", "Le Chauffeur de clando", "La Vendeuse de manioc", "Le Mécanicien",
  "Le Gardien de nuit", "La Couturière", "Le Vendeur d'unités", "La Vendeuse de beignets",
  "Le Tailleur", "Le Cordonnier", "La Pharmacienne", "Le Maçon", "La Restauratrice",
];

const rooms = new Map();

/* ---------------- helpers ---------------- */

const token = () => crypto.randomBytes(16).toString("hex");
const rand = (n) => crypto.randomInt(n);
const pick = (arr) => arr[rand(arr.length)];
const secs = (s) => Math.round(s * 1000 * SCALE);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => CODE_CHARS[rand(CODE_CHARS.length)]).join("");
  while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
}

const alive = (room) => [...room.players.values()].filter((p) => p.alive);
const byRole = (room, role) => alive(room).filter((p) => p.role === role);
const nameOf = (room, id) => room.players.get(id)?.name ?? "?";

function roleInfo(role) {
  return role ? { key: role, ...ROLES[role] } : null;
}

/* ---------------- roles ---------------- */

function ndokiCount(n) {
  if (n >= 10) return 3;
  if (n >= 6) return 2;
  return 1;
}

function drawRoles(n) {
  const roles = Array(ndokiCount(n)).fill("ndoki");
  roles.push("nganga");
  const free = n - roles.length;
  const chance = SECONDARY_CHANCE[n] ?? 0.45;
  const drawn = SECONDARY.filter(() => crypto.randomInt(1000) < chance * 1000).slice(0, free);
  roles.push(...drawn);
  while (roles.length < n) roles.push("habitant");
  return shuffle(roles);
}

/* ---------------- rooms ---------------- */

function createRoom(hostName) {
  const code = newCode();
  const room = {
    code,
    hostId: null,
    players: new Map(),
    order: [],
    settings: { chatSecs: 90 },
    phase: "lobby",
    endsAt: null,
    timer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  const host = addPlayer(room, hostName);
  room.hostId = host.id;
  return { room, player: host };
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomBytes(4).toString("hex"),
    token: token(),
    name,
    ws: null,
    connected: false,
    alive: true,
    role: null,
    ready: false,
    removeTimer: null,
  };
  room.players.set(player.id, player);
  room.order.push(player.id);
  return player;
}

function resetGame(room) {
  clearTimeout(room.timer);
  room.phase = "lobby";
  room.endsAt = null;
  room.night = 0;
  room.chefId = null;
  room.winner = null;
  room.sermonUsed = false;
  room.gardienUsed = false;
  room.lastJail = null;
  room.lastBless = null;
  room.log = { nights: [], days: [], elections: [] };
  for (const p of room.players.values()) {
    p.alive = true;
    p.role = null;
    p.ready = false;
    p.bilanSeen = false;
  }
}

/* ---------------- phase machine ---------------- */

function setPhase(room, phase, seconds, onEnd) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  room.endsAt = seconds ? Date.now() + secs(seconds) : null;
  room.onPhaseEnd = onEnd || null;
  if (seconds && onEnd) room.timer = setTimeout(() => endPhase(room), secs(seconds));
  broadcast(room);
}

function endPhase(room) {
  clearTimeout(room.timer);
  const fn = room.onPhaseEnd;
  room.onPhaseEnd = null;
  if (fn) fn();
}

function startGame(room) {
  const players = [...room.players.values()];
  resetGame(room);
  const roles = drawRoles(players.length);
  players.forEach((p, i) => (p.role = roles[i]));
  setPhase(room, "roles", T.roles, () => startElection(room, () => startNight(room)));
}

function startElection(room, then) {
  room.election = { candidates: new Set(), votes: new Map(), then };
  setPhase(room, "election", T.election, () => finishElection(room));
}

function finishElection(room) {
  const el = room.election;
  const pool = el.candidates.size ? [...el.candidates].filter((id) => room.players.get(id)?.alive) : alive(room).map((p) => p.id);
  const counts = new Map(pool.map((id) => [id, 0]));
  for (const target of el.votes.values()) if (counts.has(target)) counts.set(target, counts.get(target) + 1);
  const max = Math.max(0, ...counts.values());
  const top = [...counts].filter(([, c]) => c === max).map(([id]) => id);
  room.chefId = pick(top.length ? top : alive(room).map((p) => p.id));
  room.log.elections.push({
    night: room.night,
    candidates: [...el.candidates].map((id) => nameOf(room, id)),
    votes: [...el.votes].map(([v, t]) => ({ voter: nameOf(room, v), target: nameOf(room, t) })),
    chef: nameOf(room, room.chefId),
    drawn: top.length > 1,
  });
  const then = el.then;
  room.election = null;
  then();
}

function startNight(room) {
  room.night = (room.night || 0) + 1;
  const pseudos = shuffle(PSEUDOS);
  room.nightState = {
    actions: new Map(), // playerId -> targetId (or "skip")
    ndokiVotes: new Map(),
    ndokiChat: [],
    chat: [],
    pseudos: new Map(alive(room).map((p, i) => [p.id, pseudos[i]])),
    arrested: null,
  };
  setPhase(room, "night_action", T.action, () => startNightChat(room));
}

function actionRoles(room) {
  // Players who still have a night decision to make.
  return alive(room).filter((p) => {
    if (p.role === "ndoki") return !room.nightState.ndokiVotes.has(p.id);
    if (p.role === "gardien") return !room.gardienUsed && !room.nightState.actions.has(p.id);
    if (["nganga", "policier", "marabout"].includes(p.role)) return !room.nightState.actions.has(p.id);
    return false;
  });
}

function startNightChat(room) {
  const ns = room.nightState;
  // The arrest is known as soon as the action phase ends: the arrested player misses the chat.
  const policier = byRole(room, "policier")[0];
  const jail = policier && ns.actions.get(policier.id);
  ns.arrested = jail && jail !== "skip" ? jail : null;
  room.lastJail = ns.arrested;
  setPhase(room, "night_chat", room.settings.chatSecs, () => resolveNight(room));
}

function resolveNight(room) {
  const ns = room.nightState;
  const free = (p) => p.id !== ns.arrested;
  const actionOf = (role) => {
    const p = byRole(room, role)[0];
    if (!p || !free(p)) return null;
    const t = ns.actions.get(p.id);
    return t && t !== "skip" ? t : null;
  };

  // 1. Protections (the arrest is already applied through free()).
  const blessed = actionOf("marabout");
  room.lastBless = blessed;
  const gardien = byRole(room, "gardien")[0];
  let reliquary = null;
  if (gardien && free(gardien) && !room.gardienUsed) {
    const t = ns.actions.get(gardien.id);
    if (t && t !== "skip") {
      reliquary = t;
      room.gardienUsed = true;
    }
  }

  // 2. Attack: the target with the most votes among free Ndoki; a tie means nobody.
  const counts = new Map();
  for (const [ndokiId, target] of ns.ndokiVotes) {
    if (ndokiId === ns.arrested) continue;
    if (!room.players.get(target)?.alive) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  const top = [...counts].filter(([, c]) => c === max);
  const target = max > 0 && top.length === 1 ? top[0][0] : null;
  const saved = !!target && (target === blessed || target === reliquary);
  const victim = target && !saved ? target : null;
  if (victim) room.players.get(victim).alive = false;

  // 3. Vision of the Nganga.
  let vision = null;
  const nganga = byRole(room, "nganga")[0] || [...room.players.values()].find((p) => p.role === "nganga" && p.id === victim);
  const seen = nganga && free(nganga) && ns.actions.get(nganga.id);
  if (seen && seen !== "skip") {
    const t = room.players.get(seen);
    const blurry = rand(5) === 0;
    vision = { ngangaId: nganga.id, targetId: seen, name: t.name, blurry, role: blurry ? null : roleInfo(t.role), camp: ROLES[t.role].camp };
  }

  const chefDied = victim && victim === room.chefId;
  room.morning = { victim, saved, vision, arrested: ns.arrested };
  room.log.nights.push({
    night: room.night,
    arrested: ns.arrested && nameOf(room, ns.arrested),
    blessed: blessed && nameOf(room, blessed),
    reliquary: reliquary && nameOf(room, reliquary),
    ndokiVotes: [...ns.ndokiVotes].map(([n, t]) => ({ ndoki: nameOf(room, n), target: nameOf(room, t) })),
    victim: victim && nameOf(room, victim),
    saved,
    vision: vision && { nganga: nameOf(room, vision.ngangaId), target: vision.name, blurry: vision.blurry },
    pseudos: [...ns.pseudos].map(([id, pseudo]) => ({ pseudo, name: nameOf(room, id) })),
    chat: ns.chat.map((m) => ({ pseudo: m.pseudo, name: nameOf(room, m.from), text: m.text })),
  });
  room.lastNightChat = ns.chat.map((m) => ({ pseudo: m.pseudo, text: m.text }));
  room.nightState = null;
  if (chefDied) room.chefId = null;

  setPhase(room, "morning", T.morning, () => {
    if (checkWin(room)) return;
    if (!room.chefId) startElection(room, () => startDebate(room));
    else startDebate(room);
  });
}

function startDebate(room) {
  room.debate = { messages: [], minAt: Date.now() + secs(T.debateMin) };
  setPhase(room, "debate", T.debateMax, () => startVote(room));
}

function startVote(room) {
  room.vote = { intents: new Map(), confirmed: new Set(), history: [], feed: [], sermon: false };
  setPhase(room, "vote", T.vote, () => finishVote(room));
}

function finishVote(room) {
  const v = room.vote;
  const counts = new Map();
  for (const target of v.intents.values()) counts.set(target, (counts.get(target) || 0) + 1);
  const max = Math.max(0, ...counts.values());
  const tied = [...counts].filter(([, c]) => c === max).map(([id]) => id);
  const day = {
    day: room.night,
    final: [...v.intents].map(([voter, target]) => ({ voter: nameOf(room, voter), target: nameOf(room, target) })),
    history: v.history,
    sermon: v.sermon,
  };
  room.log.days.push(day);
  if (max === 0) return eliminate(room, null, "Personne n'a voté : personne ne quitte le quartier.");
  if (tied.length === 1) return eliminate(room, tied[0]);
  const chef = room.chefId && room.players.get(room.chefId);
  if (!chef || !chef.alive) return eliminate(room, pick(tied), "Égalité sans Chef : le sort a tranché.");
  room.tiebreak = { tied };
  setPhase(room, "tiebreak", T.tiebreak, () => eliminate(room, pick(room.tiebreak.tied), "Le Chef n'a pas tranché à temps : le sort a choisi."));
}

function eliminate(room, id, note) {
  room.tiebreak = null;
  const day = room.log.days[room.log.days.length - 1];
  if (id) room.players.get(id).alive = false;
  if (day) day.eliminated = id ? nameOf(room, id) : null;
  room.result = { eliminated: id, note: note || null };
  if (id && room.players.get(id).role === "bouc") {
    room.winner = "bouc";
    return setPhase(room, "result", T.result, () => endGame(room));
  }
  const chefDied = id && id === room.chefId;
  if (chefDied) room.chefId = null;
  setPhase(room, "result", T.result, () => {
    if (checkWin(room)) return;
    if (!room.chefId) startElection(room, () => startNight(room));
    else startNight(room);
  });
}

function checkWin(room) {
  const living = alive(room);
  const ndoki = living.filter((p) => p.role === "ndoki").length;
  if (ndoki === 0) room.winner = "village";
  else if (ndoki >= living.length - ndoki) room.winner = "ndoki";
  if (room.winner) endGame(room);
  return !!room.winner;
}

function endGame(room) {
  if (!room.winner) checkWin(room);
  clearTimeout(room.timer);
  room.phase = "end";
  room.endsAt = null;
  broadcast(room);
}

/* ---------------- player actions ---------------- */

function isAliveTarget(room, id, exclude = []) {
  const p = room.players.get(id);
  return !!p && p.alive && !exclude.includes(id);
}

const handlers = {
  settings(room, me, msg) {
    if (room.phase !== "lobby" || me.id !== room.hostId) return;
    const s = Number(msg.chatSecs);
    if (CHAT_CHOICES.includes(s)) room.settings.chatSecs = s;
  },

  start(room, me) {
    if (room.phase !== "lobby" || me.id !== room.hostId) return;
    const n = room.players.size;
    if (n < MIN_PLAYERS) return `Il faut au moins ${MIN_PLAYERS} joueurs pour lancer la partie.`;
    if (n > MAX_PLAYERS) return `${MAX_PLAYERS} joueurs au maximum.`;
    startGame(room);
  },

  ready(room, me) {
    if (room.phase !== "roles") return;
    me.ready = true;
    if ([...room.players.values()].every((p) => p.ready || !p.connected)) return endPhase(room);
  },

  candidate(room, me, msg) {
    if (room.phase !== "election" || !me.alive) return;
    if (msg.on) room.election.candidates.add(me.id);
    else room.election.candidates.delete(me.id);
  },

  elect(room, me, msg) {
    if (room.phase !== "election" || !me.alive) return;
    if (msg.target === me.id) return "Tu ne peux pas voter pour toi-même.";
    if (!isAliveTarget(room, msg.target)) return;
    const el = room.election;
    if (el.candidates.size && !el.candidates.has(msg.target)) return "Vote pour un des candidats.";
    el.votes.set(me.id, msg.target);
    if (alive(room).every((p) => el.votes.has(p.id) || !p.connected)) endPhase(room);
  },

  night(room, me, msg) {
    if (room.phase !== "night_action" || !me.alive) return;
    const ns = room.nightState;
    const t = msg.target;
    if (me.role === "ndoki") {
      if (!isAliveTarget(room, t) || room.players.get(t).role === "ndoki") return "Choisis un voisin qui n'est pas Ndoki.";
      ns.ndokiVotes.set(me.id, t);
    } else if (me.role === "nganga") {
      if (!isAliveTarget(room, t, [me.id])) return;
      ns.actions.set(me.id, t);
    } else if (me.role === "policier") {
      if (t === room.lastJail) return "Tu as déjà mis ce joueur au poste la nuit dernière.";
      if (!isAliveTarget(room, t, [me.id])) return;
      ns.actions.set(me.id, t);
    } else if (me.role === "marabout") {
      if (t === room.lastBless) return "Tu as déjà béni ce joueur la nuit dernière.";
      if (!isAliveTarget(room, t)) return;
      ns.actions.set(me.id, t);
    } else if (me.role === "gardien") {
      if (room.gardienUsed) return "Le reliquaire a déjà servi.";
      if (t === "skip") ns.actions.set(me.id, "skip");
      else if (isAliveTarget(room, t)) ns.actions.set(me.id, t);
    } else return;
    if (actionRoles(room).length === 0) endPhase(room);
  },

  ndokiChat(room, me, msg) {
    if (room.phase !== "night_action" || !me.alive || me.role !== "ndoki") return;
    const text = cleanText(msg.text);
    if (text) room.nightState.ndokiChat.push({ from: me.id, text });
  },

  chat(room, me, msg) {
    const text = cleanText(msg.text);
    if (!text || !me.alive) return;
    if (room.phase === "night_chat") {
      const ns = room.nightState;
      if (ns.arrested === me.id) return;
      ns.chat.push({ from: me.id, pseudo: ns.pseudos.get(me.id), text });
    } else if (room.phase === "debate") {
      room.debate.messages.push({ from: me.id, text });
    }
  },

  closeDebate(room, me) {
    if (room.phase !== "debate" || me.id !== room.chefId) return;
    if (Date.now() < room.debate.minAt) return "Le débat doit durer au moins 2 minutes.";
    endPhase(room);
  },

  vote(room, me, msg) {
    if (room.phase !== "vote" || !me.alive) return;
    const v = room.vote;
    if (msg.target === me.id) return "Tu ne peux pas voter contre toi-même.";
    if (!isAliveTarget(room, msg.target)) return;
    const before = v.intents.get(me.id);
    if (before === msg.target) return;
    v.intents.set(me.id, msg.target);
    v.confirmed.delete(me.id);
    const entry = { voter: nameOf(room, me.id), from: before ? nameOf(room, before) : null, to: nameOf(room, msg.target) };
    v.history.push(entry);
    v.feed = [entry, ...v.feed].slice(0, 3);
  },

  confirm(room, me) {
    if (room.phase !== "vote" || !me.alive || !room.vote.intents.has(me.id)) return;
    room.vote.confirmed.add(me.id);
    if (alive(room).every((p) => room.vote.confirmed.has(p.id) || !p.connected)) endPhase(room);
  },

  sermon(room, me) {
    if (room.phase !== "vote" || !me.alive || me.role !== "pasteur" || room.sermonUsed) return;
    room.sermonUsed = true;
    const v = room.vote;
    v.intents.clear();
    v.confirmed.clear();
    v.sermon = true;
    v.history.push({ sermon: true, by: me.name });
    v.feed = [{ sermon: true }];
    setPhase(room, "vote", T.vote, () => finishVote(room));
  },

  tiebreak(room, me, msg) {
    if (room.phase !== "tiebreak" || me.id !== room.chefId) return;
    if (!room.tiebreak.tied.includes(msg.target)) return;
    clearTimeout(room.timer);
    eliminate(room, msg.target, "Égalité : le Chef de quartier a tranché.");
  },

  bilan(room, me) {
    if (room.phase !== "end") return;
    me.bilanSeen = true;
    if (me.ws) me.ws.sendJSON({ type: "bilan", bilan: bilan(room) });
    return "__silent";
  },

  restart(room, me) {
    if (room.phase !== "end" || me.id !== room.hostId) return;
    for (const p of [...room.players.values()]) if (!p.connected) removePlayer(room, p.id);
    resetGame(room);
  },
};

/* ---------------- views ---------------- */

function bilan(room) {
  return {
    winner: room.winner,
    roles: room.order.filter((id) => room.players.has(id)).map((id) => {
      const p = room.players.get(id);
      return { name: p.name, role: roleInfo(p.role), alive: p.alive };
    }),
    elections: room.log.elections,
    nights: room.log.nights,
    days: room.log.days,
  };
}

function viewFor(room, me) {
  const players = room.order.filter((id) => room.players.has(id)).map((id) => {
    const p = room.players.get(id);
    return {
      id: p.id,
      name: p.name,
      connected: p.connected,
      alive: p.alive,
      isHost: p.id === room.hostId,
      isChef: p.id === room.chefId,
      // A role is public once the player is out, or at the end of the game.
      role: !p.alive || room.phase === "end" ? roleInfo(p.role) : null,
    };
  });
  const view = {
    type: "state",
    serverNow: Date.now(),
    code: room.code,
    phase: room.phase,
    endsAt: room.endsAt,
    night: room.night || 0,
    settings: room.settings,
    players,
    me: {
      id: me.id,
      name: me.name,
      alive: me.alive,
      isHost: me.id === room.hostId,
      isChef: me.id === room.chefId,
      role: roleInfo(me.role),
    },
  };
  // Ndoki know each other from the start.
  if (me.role === "ndoki") view.me.mates = [...room.players.values()].filter((p) => p.role === "ndoki" && p.id !== me.id).map((p) => p.id);

  switch (room.phase) {
    case "roles":
      view.roles = { ready: me.ready, readyCount: [...room.players.values()].filter((p) => p.ready).length };
      break;
    case "election": {
      const el = room.election;
      const counts = {};
      for (const t of el.votes.values()) counts[t] = (counts[t] || 0) + 1;
      view.election = { candidates: [...el.candidates], counts, myVote: el.votes.get(me.id) || null, voted: el.votes.size };
      break;
    }
    case "night_action": {
      const ns = room.nightState;
      const na = { done: ns.actions.has(me.id) || ns.ndokiVotes.has(me.id), choice: ns.actions.get(me.id) || ns.ndokiVotes.get(me.id) || null };
      if (me.role === "policier") na.forbidden = room.lastJail;
      if (me.role === "marabout") na.forbidden = room.lastBless;
      if (me.role === "gardien") na.used = room.gardienUsed;
      if (me.role === "ndoki" && me.alive) {
        na.ndokiVotes = Object.fromEntries(ns.ndokiVotes);
        na.ndokiChat = ns.ndokiChat.map((m) => ({ name: nameOf(room, m.from), text: m.text, mine: m.from === me.id }));
      }
      view.nightAction = na;
      break;
    }
    case "night_chat": {
      const ns = room.nightState;
      const arrested = ns.arrested === me.id;
      view.nightChat = {
        arrested,
        myPseudo: me.alive ? ns.pseudos.get(me.id) : null,
        messages: arrested ? [] : ns.chat.map((m) => ({ pseudo: m.pseudo, text: m.text, mine: m.from === me.id })),
      };
      break;
    }
    case "morning": {
      const m = room.morning;
      const victim = m.victim && room.players.get(m.victim);
      view.morning = {
        victim: victim ? { id: victim.id, name: victim.name, role: roleInfo(victim.role) } : null,
        saved: m.saved,
        vision: m.vision && m.vision.ngangaId === me.id ? m.vision : null,
        arrested: m.arrested === me.id,
        chefDied: !room.chefId,
      };
      break;
    }
    case "debate":
      view.debate = {
        messages: room.debate.messages.map((m) => ({ name: nameOf(room, m.from), text: m.text, mine: m.from === me.id })),
        nightChat: room.lastNightChat || [],
        minAt: room.debate.minAt,
      };
      break;
    case "vote": {
      const v = room.vote;
      view.vote = {
        intents: [...v.intents].map(([voter, target]) => ({ voter, target, confirmed: v.confirmed.has(voter) })),
        myVote: v.intents.get(me.id) || null,
        confirmed: v.confirmed.has(me.id),
        feed: v.feed,
        canSermon: me.alive && me.role === "pasteur" && !room.sermonUsed,
        sermon: v.sermon,
      };
      break;
    }
    case "tiebreak":
      view.tiebreak = { tied: room.tiebreak.tied };
      break;
    case "result": {
      const e = room.result.eliminated && room.players.get(room.result.eliminated);
      view.result = { eliminated: e ? { id: e.id, name: e.name, role: roleInfo(e.role) } : null, note: room.result.note, bouc: room.winner === "bouc" };
      break;
    }
    case "end":
      view.end = { winner: room.winner, bilanSeen: !!me.bilanSeen };
      break;
  }
  return view;
}

function broadcast(room) {
  room.lastActivity = Date.now();
  for (const p of room.players.values()) if (p.ws) p.ws.sendJSON(viewFor(room, p));
}

/* ---------------- connections ---------------- */

function removePlayer(room, id) {
  room.players.delete(id);
  room.order = room.order.filter((x) => x !== id);
  if (room.hostId === id) room.hostId = room.order[0] || null;
  if (!room.players.size) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
  }
}

function attach(room, player, ws) {
  if (player.ws && player.ws !== ws) player.ws.close(4000, "Ouvert ailleurs");
  clearTimeout(player.removeTimer);
  player.ws = ws;
  player.connected = true;
  ws.room = room;
  ws.player = player;
  ws.sendJSON({ type: "joined", code: room.code, token: player.token, id: player.id });
  broadcast(room);
}

function handleConnection(ws) {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    const error = (text) => ws.sendJSON({ type: "error", message: text });

    if (msg.type === "create") {
      const name = cleanName(msg.name);
      if (!name) return error("Choisis un pseudo.");
      const { room, player } = createRoom(name);
      resetGame(room);
      return attach(room, player, ws);
    }

    if (msg.type === "join") {
      const room = rooms.get(String(msg.code || "").toUpperCase().trim());
      const name = cleanName(msg.name);
      if (!room) return error("Aucune partie avec ce code.");
      if (!name) return error("Choisis un pseudo.");
      if (room.phase !== "lobby") return error("La partie a déjà commencé.");
      if (room.players.size >= MAX_PLAYERS) return error("La partie est complète (10 joueurs).");
      if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return error("Ce pseudo est déjà pris dans cette partie.");
      return attach(room, addPlayer(room, name), ws);
    }

    if (msg.type === "resume") {
      const room = rooms.get(String(msg.code || "").toUpperCase());
      const player = room && [...room.players.values()].find((p) => p.token === msg.token);
      if (!player) return ws.sendJSON({ type: "expired" });
      return attach(room, player, ws);
    }

    const room = ws.room;
    const me = ws.player;
    if (!room || !me || !room.players.has(me.id)) return;

    if (msg.type === "leave") {
      if (room.phase === "lobby" || room.phase === "end") {
        removePlayer(room, me.id);
        ws.room = ws.player = null;
        ws.sendJSON({ type: "left" });
        if (rooms.has(room.code)) broadcast(room);
      }
      return;
    }

    const handler = handlers[msg.type];
    if (!handler) return;
    const result = handler(room, me, msg);
    if (result === "__silent") return;
    if (typeof result === "string") return error(result);
    if (rooms.has(room.code)) broadcast(room);
  });

  ws.on("close", () => {
    const room = ws.room;
    const me = ws.player;
    if (!room || !me || me.ws !== ws) return;
    me.ws = null;
    me.connected = false;
    // In the lobby, a player who does not come back within a minute leaves the room.
    // The bilan only lives while someone is still connected to the finished game.
    if (room.phase === "end" && ![...room.players.values()].some((p) => p.connected)) {
      rooms.delete(room.code);
      return;
    }
    if (room.phase === "lobby") {
      me.removeTimer = setTimeout(() => {
        if (me.connected || room.phase !== "lobby") return;
        removePlayer(room, me.id);
        if (rooms.has(room.code)) broadcast(room);
      }, 60000);
    }
    if (rooms.has(room.code)) broadcast(room);
  });
}

// Rooms with nobody connected for 15 minutes are removed (the bilan disappears with them).
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.lastActivity > 15 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    }
  }
}, 60000).unref();

module.exports = { handleConnection, rooms, ROLES, drawRoles, T };
