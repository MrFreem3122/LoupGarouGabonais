// Loup-Garou gabonais: game rooms and rules.
// The server holds every secret (roles, night actions, the link between night pseudos
// and real names). Each player only ever receives the view they are allowed to see.

const crypto = require("crypto");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const SCALE = Math.max(0.01, Number(process.env.TIME_SCALE) || 1); // shorter timers for tests

// Durations in seconds (see the gameplay document).
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
  hunter: 25,
};
const CHAT_CHOICES = [60, 90, 120];

const ROLES = {
  ndoki: { name: "Ndoki", camp: "ndoki", power: "Chaque nuit, choisis avec les autres Ndoki un voisin à manger. Le jour, fais-toi passer pour un habitant." },
  nganga: { name: "Nganga", camp: "village", power: "Chaque nuit, consulte les esprits et découvre le rôle d'un joueur. Une vision sur cinq est floue : tu ne vois que son camp." },
  policier: { name: "Policier", camp: "village", power: "Chaque nuit, mets un joueur au poste : il ne peut ni agir ni lire le chat de nuit. Jamais le même deux nuits de suite." },
  marabout: { name: "Marabout", camp: "village", power: "Chaque nuit, bénis un joueur : il est protégé de tout ce qui arrive la nuit (Ndoki, feu, secte). Jamais le même deux nuits de suite." },
  pasteur: { name: "Pasteur", camp: "village", power: "Une fois par partie, pendant un vote, lance ton sermon : le vote recommence à zéro. La secte ne peut pas t'acheter, et si elle essaie, tu découvres le Gourou." },
  gardien: { name: "Gardien des byéri", camp: "village", power: "Une fois par partie, protège un joueur pour une nuit avec le reliquaire." },
  chasseur: { name: "Chasseur de brousse", camp: "village", power: "Quand tu meurs, de jour comme de nuit, tu tires un dernier coup de fusil sur le joueur de ton choix." },
  chauffeur: { name: "Chauffeur de clando", camp: "village", power: "Chaque nuit, emmène un joueur faire un tour : il n'est pas chez lui, les Ndoki, le feu et la secte le ratent. Mais si tu embarques un Ndoki, il te mange." },
  ivrogne: { name: "Ivrogne du maquis", camp: "village", power: "Tu croyais avoir un pouvoir, mais tu avais surtout bu. Tes actions de nuit ne servaient à rien." },
  bouc: { name: "Bouc émissaire", camp: "seul", power: "Aucun pouvoir. Tu gagnes seul si le village te chasse au vote du jour." },
  pyromane: { name: "Pyromane", camp: "pyromane", power: "Chaque nuit, arrose d'essence une maison, ou mets le feu : toutes les maisons arrosées brûlent. Tu gagnes si tu es le dernier debout." },
  gourou: { name: "Gourou des Rose-Croix", camp: "secte", power: "Chaque nuit, propose la richesse à un joueur : libre à lui d'accepter et d'entrer dans la secte. La secte gagne si elle reste seule dans le quartier." },
  adepte: { name: "Adepte de la secte", camp: "secte", power: "Tu as accepté la richesse. Aide la secte à rester seule dans le quartier. Si le Gourou meurt, le plus ancien Adepte prend sa place." },
  femme: { name: "Femme de nuit", camp: "couple", power: "La première nuit, choisis ton mari de nuit. Vous gagnez si vous êtes les deux derniers du quartier. Si l'un de vous meurt, l'autre meurt de chagrin." },
  habitant: { name: "Habitant", camp: "village", power: "Aucun pouvoir. Écoute les rumeurs de la nuit, débats au maquis et trouve les Ndoki." },
};
// Roles drawn at random besides the Ndoki and the Nganga, with the minimum number of players.
const SECONDARY = [
  ["policier", 4], ["marabout", 4], ["pasteur", 4], ["gardien", 4], ["bouc", 5], ["chasseur", 4],
  ["chauffeur", 5], ["ivrogne", 5], ["femme", 5], ["pyromane", 6], ["gourou", 7],
];
const SECONDARY_CHANCE = { 4: 0.05, 5: 0.1, 6: 0.15, 7: 0.22, 8: 0.3, 9: 0.38, 10: 0.45 };
const IVROGNE_DREAMS = ["nganga", "policier", "marabout"];

const PSEUDOS = [
  "Le Taximan", "La Mama", "Le Vendeur de brochettes", "La Coiffeuse", "Le Boutiquier",
  "La Tantine", "Le Laveur de voitures", "La Vendeuse de manioc", "Le Mécanicien",
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
const isSecte = (p) => p.role === "gourou" || p.role === "adepte";

function roleInfo(role) {
  return role ? { key: role, ...ROLES[role] } : null;
}

// The role a player believes they have: the Ivrogne dreams of a power role until he dies.
function shownRole(room, p) {
  if (p.role === "ivrogne" && p.alive && room.phase !== "end") return roleInfo(p.dream);
  return roleInfo(p.role);
}

// The power a player actually uses at night (the Ivrogne acts like his dream, without effect).
const nightRole = (p) => (p.role === "ivrogne" ? p.dream : p.role);

/* ---------------- roles ---------------- */

function ndokiCount(n) {
  if (n >= 10) return 3;
  if (n >= 6) return 2;
  return 1;
}

function drawRoles(n) {
  // Tests can force a set of roles, e.g. FORCE_ROLES=pyromane,gourou,femme
  if (process.env.FORCE_ROLES) {
    const forced = process.env.FORCE_ROLES.split(",").filter((r) => ROLES[r]).slice(0, n - ndokiCount(n) - 1);
    const roles = [...Array(ndokiCount(n)).fill("ndoki"), "nganga", ...forced];
    while (roles.length < n) roles.push("habitant");
    return shuffle(roles);
  }
  const roles = Array(ndokiCount(n)).fill("ndoki");
  roles.push("nganga");
  const free = n - roles.length;
  const chance = SECONDARY_CHANCE[n] ?? 0.45;
  const pool = shuffle(SECONDARY.filter(([, min]) => n >= min).map(([r]) => r));
  const drawn = pool.filter(() => crypto.randomInt(1000) < chance * 1000).slice(0, free);
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
  room.doused = new Set();
  room.couple = null; // { femme, mari }
  room.secteOrder = []; // join order, to pick the next Gourou
  room.secteNotes = new Map(); // playerId -> private notes for the morning
  room.hunters = []; // Chasseurs who died and still have to shoot
  room.log = { nights: [], days: [], elections: [] };
  for (const p of room.players.values()) {
    p.alive = true;
    p.role = null;
    p.firstRole = null;
    p.dream = null;
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
  players.forEach((p, i) => {
    p.role = roles[i];
    p.firstRole = roles[i];
    if (p.role === "ivrogne") p.dream = pick(IVROGNE_DREAMS);
    if (p.role === "gourou") room.secteOrder.push(p.id);
  });
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
  room.secteNotes = new Map();
  room.nightState = {
    actions: new Map(), // playerId -> targetId, "skip" or "ignite"
    ndokiVotes: new Map(),
    ndokiChat: [],
    secteChat: [],
    chat: [],
    pseudos: new Map(alive(room).map((p, i) => [p.id, pseudos[i]])),
    arrested: null,
  };
  setPhase(room, "night_action", T.action, () => startNightChat(room));
}

// Players who still have a night decision to make (the phase ends early when nobody is left).
function actionRoles(room) {
  const ns = room.nightState;
  return alive(room).filter((p) => {
    const r = nightRole(p);
    if (r === "ndoki") return !ns.ndokiVotes.has(p.id);
    if (r === "gardien") return !room.gardienUsed && !ns.actions.has(p.id);
    if (r === "femme") return !room.couple && room.night === 1 && !ns.actions.has(p.id);
    if (["nganga", "policier", "marabout", "chauffeur", "pyromane", "gourou"].includes(r)) return !ns.actions.has(p.id);
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
  ns.offer = prepareOffer(room);
  setPhase(room, "night_chat", room.settings.chatSecs, () => resolveNight(room));
}

// The secte's offer is made during the night chat: the target chooses to accept or refuse.
function prepareOffer(room) {
  const ns = room.nightState;
  const free = (p) => p && p.alive && p.id !== ns.arrested;
  const act = (p) => {
    const t = p && free(p) && ns.actions.get(p.id);
    return t && t !== "skip" ? t : null;
  };
  const gourou = alive(room).find((p) => p.role === "gourou" && free(p));
  const targetId = act(gourou);
  const t = targetId && room.players.get(targetId);
  if (!t || !t.alive || isSecte(t)) return null;
  const offer = { gourou: gourou.id, target: t.id, status: "pending", locked: null };
  const passenger = act(alive(room).find((p) => p.role === "chauffeur"));
  const gardien = alive(room).find((p) => p.role === "gardien");
  const protectedIds = [act(alive(room).find((p) => p.role === "marabout")), !room.gardienUsed ? act(gardien) : null];
  if (t.id === ns.arrested || t.id === passenger) offer.status = "absent";
  else if (protectedIds.includes(t.id)) offer.status = "protected";
  else {
    // Some players can never change side: they hear the offer but can only refuse.
    const femme = alive(room).find((p) => p.role === "femme");
    const couple = room.couple ? [room.couple.femme, room.couple.mari] : femme ? [femme.id, act(femme)] : [];
    if (t.role === "ndoki") offer.locked = "Un Ndoki ne se vend pas.";
    else if (t.role === "pyromane") offer.locked = "Le Pyromane ne travaille pour personne.";
    else if (couple.includes(t.id)) offer.locked = "Ton cœur est déjà pris par le couple de nuit.";
    else if (t.role === "pasteur") offer.locked = "Un homme de Dieu ne se vend pas.";
  }
  return offer;
}

function kill(room, id, cause, deaths) {
  const p = room.players.get(id);
  if (!p || !p.alive) return;
  p.alive = false;
  deaths.push({ id, cause });
  if (p.role === "chasseur") room.hunters.push(id);
  if (id === room.chefId) room.chefId = null;
  // Love is stronger than death: the other half of the couple follows.
  const c = room.couple;
  if (c && (id === c.femme || id === c.mari)) kill(room, id === c.femme ? c.mari : c.femme, "chagrin", deaths);
  // A dead Gourou is replaced by the oldest living Adepte.
  if (p.role === "gourou") {
    const next = room.secteOrder.map((x) => room.players.get(x)).find((x) => x && x.alive && x.role === "adepte");
    if (next) {
      next.role = "gourou";
      room.secteNotes.set(next.id, [...(room.secteNotes.get(next.id) || []), "Le Gourou est mort : tu deviens le nouveau Gourou de la secte."]);
    }
  }
}

function note(room, id, text) {
  room.secteNotes.set(id, [...(room.secteNotes.get(id) || []), text]);
}

function resolveNight(room) {
  const ns = room.nightState;
  const free = (p) => p && p.alive && p.id !== ns.arrested;
  const actor = (role) => alive(room).find((p) => p.role === role && free(p));
  const act = (p) => {
    const t = p && ns.actions.get(p.id);
    return t && t !== "skip" ? t : null;
  };
  const deaths = [];
  const log = { night: room.night, arrested: ns.arrested && nameOf(room, ns.arrested), events: [] };

  // 1. The Chauffeur takes someone out for the night.
  const chauffeur = actor("chauffeur");
  const passenger = act(chauffeur);
  const away = (id) => id && id === passenger;
  if (passenger) {
    log.events.push(`${nameOf(room, chauffeur.id)} (Chauffeur) emmène ${nameOf(room, passenger)} faire un tour.`);
    note(room, passenger, "Le Chauffeur de clando t'a fait faire un tour cette nuit : tu n'étais pas chez toi.");
  }

  // 2. Protections.
  const blessed = act(actor("marabout"));
  room.lastBless = blessed;
  let reliquary = null;
  const gardien = actor("gardien");
  if (gardien && !room.gardienUsed && act(gardien)) {
    reliquary = act(gardien);
    room.gardienUsed = true;
  }
  if (blessed) log.events.push(`Le Marabout bénit ${nameOf(room, blessed)}.`);
  if (reliquary) log.events.push(`Le Gardien protège ${nameOf(room, reliquary)} avec le reliquaire.`);
  const safe = (id) => id === blessed || id === reliquary;
  let saved = false;

  // 3. The Femme de nuit chooses her husband (first night only; at random if she forgot).
  const femme = alive(room).find((p) => p.role === "femme");
  if (femme && !room.couple && room.night === 1) {
    let mari = free(femme) ? act(femme) : null;
    if (!mari || !room.players.get(mari)?.alive || mari === femme.id) mari = pick(alive(room).filter((p) => p.id !== femme.id)).id;
    room.couple = { femme: femme.id, mari };
    note(room, mari, `Une Femme de nuit t'a choisi : tu es maintenant le mari de nuit de ${femme.name}. Votre but : être les deux derniers du quartier. Si l'un meurt, l'autre meurt de chagrin.`);
    note(room, femme.id, `${nameOf(room, mari)} est maintenant ton mari de nuit.`);
    log.events.push(`La Femme de nuit ${femme.name} choisit ${nameOf(room, mari)} comme mari de nuit.`);
  }
  const inCouple = (id) => room.couple && (id === room.couple.femme || id === room.couple.mari);

  // 4. The secte's offer, answered during the night chat (no answer means no).
  const offer = ns.offer;
  if (offer) {
    const t = room.players.get(offer.target);
    const g = room.players.get(offer.gourou);
    let outcome = null;
    if (!t.alive) outcome = null;
    else if (offer.status === "absent") outcome = `${t.name} n'était pas chez lui.`;
    else if (offer.status === "protected") { outcome = `${t.name} était protégé cette nuit.`; saved = true; }
    else if (offer.status === "accepted" && !offer.locked && !isSecte(t)) {
      t.role = "adepte";
      room.secteOrder.push(t.id);
      outcome = `${t.name} a accepté la richesse : il entre dans la secte.`;
      note(room, t.id, "Tu as accepté la richesse : tu es maintenant Adepte de la secte. Ton ancien pouvoir est perdu.");
    } else {
      outcome = `${t.name} a refusé la richesse.`;
      note(room, t.id, offer.locked ? `Un inconnu t'a proposé la richesse cette nuit. ${offer.locked} Tu as refusé.` : "Un inconnu t'a proposé la richesse cette nuit, et tu as refusé.");
      if (t.role === "pasteur") note(room, t.id, `La secte a essayé de t'acheter cette nuit. Le Gourou, c'est ${g.name}.`);
    }
    if (outcome) {
      for (const s of alive(room).filter(isSecte)) if (s.id !== t.id) note(room, s.id, outcome);
      log.events.push(`Le Gourou ${g.name} vise ${t.name} : ${outcome}`);
    }
  }

  // 5. Ndoki attack: the target with the most votes among free Ndoki; a tie means nobody.
  const counts = new Map();
  for (const [ndokiId, target] of ns.ndokiVotes) {
    if (ndokiId === ns.arrested || !room.players.get(ndokiId)?.alive) continue;
    if (!room.players.get(target)?.alive) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  const top = [...counts].filter(([, c]) => c === max);
  const target = max > 0 && top.length === 1 ? top[0][0] : null;
  log.ndokiVotes = [...ns.ndokiVotes].map(([n, t]) => ({ ndoki: nameOf(room, n), target: nameOf(room, t) }));
  if (target) {
    if (away(target)) log.events.push(`Les Ndoki visent ${nameOf(room, target)}, mais il n'était pas chez lui.`);
    else if (safe(target)) { saved = true; log.events.push(`Les Ndoki visent ${nameOf(room, target)}, protégé cette nuit.`); }
    else kill(room, target, "ndoki", deaths);
  }

  // 6. The Pyromane: pour petrol on a house, or set every soaked house on fire.
  const pyro = actor("pyromane");
  const pyroAct = pyro && ns.actions.get(pyro.id);
  if (pyroAct === "ignite") {
    const houses = [...room.doused].filter((id) => room.players.get(id)?.alive);
    log.events.push(`Le Pyromane ${pyro.name} met le feu (${houses.map((id) => nameOf(room, id)).join(", ") || "aucune maison arrosée"}).`);
    for (const id of houses) {
      if (away(id)) continue;
      if (safe(id)) { saved = true; continue; }
      kill(room, id, "feu", deaths);
    }
    room.doused.clear();
  } else if (pyroAct && pyroAct !== "skip") {
    room.doused.add(pyroAct);
    log.events.push(`Le Pyromane ${pyro.name} arrose la maison de ${nameOf(room, pyroAct)}.`);
  }

  // 7. A Chauffeur who picked up a Ndoki gets eaten by his passenger.
  if (chauffeur && passenger && room.players.get(passenger)?.role === "ndoki" && chauffeur.alive) {
    if (safe(chauffeur.id)) saved = true;
    else kill(room, chauffeur.id, "client", deaths);
  }

  // 8. Visions: the Nganga's, and the Ivrogne's dream of one.
  let vision = null;
  const seer = [...room.players.values()].find((p) => p.role === "nganga" && p.id !== ns.arrested && (p.alive || deaths.some((d) => d.id === p.id)));
  const seen = seer && act(seer);
  if (seen) {
    const t = room.players.get(seen);
    const blurry = rand(5) === 0;
    vision = { ngangaId: seer.id, targetId: seen, name: t.name, blurry, role: blurry ? null : roleInfo(t.role), camp: ROLES[t.role].camp };
    log.events.push(`Vision du Nganga ${seer.name} : ${t.name}${blurry ? " (floue)" : ""}.`);
  }
  const drunk = alive(room).concat(deaths.map((d) => room.players.get(d.id))).find((p) => p.role === "ivrogne" && p.dream === "nganga");
  const drunkSeen = drunk && drunk.id !== ns.arrested && act(drunk);
  const fakeVision = drunkSeen && {
    ngangaId: drunk.id, targetId: drunkSeen, name: nameOf(room, drunkSeen), blurry: false,
    role: roleInfo(pick(["habitant", "ndoki", "policier", "marabout", "habitant", "chasseur"])),
  };

  room.morning = { deaths, saved, vision, fakeVision, arrested: ns.arrested };
  log.deaths = deaths.map((d) => ({ name: nameOf(room, d.id), cause: d.cause }));
  log.vision = vision && { nganga: nameOf(room, vision.ngangaId), target: vision.name, blurry: vision.blurry };
  log.pseudos = [...ns.pseudos].map(([id, pseudo]) => ({ pseudo, name: nameOf(room, id) }));
  log.chat = ns.chat.map((m) => ({ pseudo: m.pseudo, name: nameOf(room, m.from), text: m.text }));
  room.log.nights.push(log);
  room.lastNightChat = ns.chat.map((m) => ({ pseudo: m.pseudo, text: m.text }));
  room.nightState = null;

  setPhase(room, "morning", T.morning, () => afterDeaths(room, () => {
    if (!room.chefId) startElection(room, () => startDebate(room));
    else startDebate(room);
  }));
}

// After any deaths: let dead Chasseurs shoot, then check who wins, then go on.
function afterDeaths(room, next) {
  if (room.hunters.length) {
    const hunterId = room.hunters.shift();
    room.hunt = { hunterId, shot: null };
    return setPhase(room, "hunter", T.hunter, () => {
      room.hunt = null;
      afterDeaths(room, next);
    });
  }
  if (checkWin(room)) return;
  next();
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
  for (const [voter, target] of v.intents) {
    if (!room.players.get(voter)?.alive || !room.players.get(target)?.alive) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  const tied = [...counts].filter(([, c]) => c === max).map(([id]) => id);
  room.log.days.push({
    day: room.night,
    final: [...v.intents].map(([voter, target]) => ({ voter: nameOf(room, voter), target: nameOf(room, target) })),
    history: v.history,
    sermon: v.sermon,
  });
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
  const deaths = [];
  if (id) kill(room, id, "vote", deaths);
  if (day) day.eliminated = id ? nameOf(room, id) : null;
  room.result = { eliminated: id, note: note || null, others: deaths.filter((d) => d.id !== id) };
  if (id && room.players.get(id).role === "bouc") {
    room.winner = "bouc";
    return setPhase(room, "result", T.result, () => endGame(room));
  }
  setPhase(room, "result", T.result, () => afterDeaths(room, () => {
    if (!room.chefId) startElection(room, () => startNight(room));
    else startNight(room);
  }));
}

// Which side each living player is on when counting who is left.
function sideOf(room, p) {
  const c = room.couple;
  if (c && (p.id === c.femme || p.id === c.mari)) return "couple";
  if (p.role === "ndoki") return "ndoki";
  if (isSecte(p)) return "secte";
  if (p.role === "pyromane") return "pyromane";
  return "village"; // the Bouc émissaire counts as a harmless neighbour
}

function checkWin(room) {
  const living = alive(room);
  if (!living.length) {
    room.winner = "personne";
    endGame(room);
    return true;
  }
  const sides = new Map();
  for (const p of living) sides.set(sideOf(room, p), (sides.get(sideOf(room, p)) || 0) + 1);
  const only = sides.size === 1 ? [...sides.keys()][0] : null;
  if (only) room.winner = only;
  else {
    // A team at parity with only harmless neighbours left wins: they can no longer be outvoted.
    const village = sides.get("village") || 0;
    const threats = [...sides.keys()].filter((s) => s !== "village");
    if (threats.length === 1 && ["ndoki", "secte"].includes(threats[0]) && sides.get(threats[0]) >= village) room.winner = threats[0];
    if (threats.length === 1 && threats[0] === "pyromane" && living.length === 2) room.winner = "pyromane";
  }
  if (room.winner) endGame(room);
  return !!room.winner;
}

function endGame(room) {
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
    const r = nightRole(me);
    if (r === "ndoki") {
      if (!isAliveTarget(room, t) || room.players.get(t).role === "ndoki") return "Choisis un voisin qui n'est pas Ndoki.";
      ns.ndokiVotes.set(me.id, t);
    } else if (r === "nganga" || r === "chauffeur") {
      if (!isAliveTarget(room, t, [me.id])) return;
      ns.actions.set(me.id, t);
    } else if (r === "policier") {
      if (t === room.lastJail && me.role === "policier") return "Tu as déjà mis ce joueur au poste la nuit dernière.";
      if (!isAliveTarget(room, t, [me.id])) return;
      ns.actions.set(me.id, t);
    } else if (r === "marabout") {
      if (t === room.lastBless && me.role === "marabout") return "Tu as déjà béni ce joueur la nuit dernière.";
      if (!isAliveTarget(room, t)) return;
      ns.actions.set(me.id, t);
    } else if (r === "gardien") {
      if (room.gardienUsed) return "Le reliquaire a déjà servi.";
      if (t === "skip") ns.actions.set(me.id, "skip");
      else if (isAliveTarget(room, t)) ns.actions.set(me.id, t);
    } else if (r === "pyromane") {
      if (t === "ignite") {
        if (![...room.doused].some((id) => room.players.get(id)?.alive)) return "Aucune maison n'est encore arrosée.";
        ns.actions.set(me.id, "ignite");
      } else if (t === "skip") ns.actions.set(me.id, "skip");
      else if (isAliveTarget(room, t, [me.id])) ns.actions.set(me.id, t);
    } else if (r === "gourou") {
      if (!isAliveTarget(room, t, [me.id]) || isSecte(room.players.get(t))) return "Choisis quelqu'un qui n'est pas encore dans la secte.";
      ns.actions.set(me.id, t);
    } else if (r === "femme") {
      if (room.couple || room.night !== 1) return;
      if (!isAliveTarget(room, t, [me.id])) return;
      ns.actions.set(me.id, t);
    } else return;
    if (actionRoles(room).length === 0) endPhase(room);
  },

  ndokiChat(room, me, msg) {
    if (room.phase !== "night_action" || !me.alive || me.role !== "ndoki") return;
    const text = cleanText(msg.text);
    if (text) room.nightState.ndokiChat.push({ from: me.id, text });
  },

  secteChat(room, me, msg) {
    if (room.phase !== "night_action" || !me.alive || !isSecte(me)) return;
    const text = cleanText(msg.text);
    if (text) room.nightState.secteChat.push({ from: me.id, text });
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

  offer(room, me, msg) {
    if (room.phase !== "night_chat" || !me.alive) return;
    const o = room.nightState.offer;
    if (!o || o.target !== me.id || o.status !== "pending" || o.locked) return;
    o.status = msg.accept ? "accepted" : "refused";
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

  shoot(room, me, msg) {
    if (room.phase !== "hunter" || !room.hunt || room.hunt.hunterId !== me.id || room.hunt.shot) return;
    const deaths = [];
    if (msg.target !== "skip") {
      if (!isAliveTarget(room, msg.target)) return;
      kill(room, msg.target, "fusil", deaths);
    }
    room.hunt.shot = msg.target;
    room.hunt.deaths = deaths;
    room.log.nights.push({ hunt: true, hunter: me.name, target: msg.target === "skip" ? null : nameOf(room, msg.target), deaths: deaths.map((d) => ({ name: nameOf(room, d.id), cause: d.cause })) });
    // Show the shot for a few seconds, then continue.
    clearTimeout(room.timer);
    room.endsAt = Date.now() + secs(6);
    room.timer = setTimeout(() => endPhase(room), secs(6));
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
    couple: room.couple && { femme: nameOf(room, room.couple.femme), mari: nameOf(room, room.couple.mari) },
    roles: room.order.filter((id) => room.players.has(id)).map((id) => {
      const p = room.players.get(id);
      return { name: p.name, role: roleInfo(p.role), firstRole: p.firstRole !== p.role ? roleInfo(p.firstRole) : null, dream: p.dream && roleInfo(p.dream), alive: p.alive };
    }),
    elections: room.log.elections,
    nights: room.log.nights,
    days: room.log.days,
  };
}

const deathView = (room, d) => {
  const p = room.players.get(d.id);
  return { id: p.id, name: p.name, role: roleInfo(p.role), cause: d.cause };
};

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
      role: shownRole(room, me),
    },
  };
  // Teams know each other: the Ndoki from the start, the secte as it grows, and the couple.
  if (me.role === "ndoki") view.me.mates = [...room.players.values()].filter((p) => p.role === "ndoki" && p.id !== me.id).map((p) => p.id);
  if (isSecte(me)) view.me.secte = [...room.players.values()].filter((p) => isSecte(p) && p.id !== me.id).map((p) => ({ id: p.id, gourou: p.role === "gourou" }));
  if (room.couple && (me.id === room.couple.femme || me.id === room.couple.mari)) view.me.partner = me.id === room.couple.femme ? room.couple.mari : room.couple.femme;

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
      const r = nightRole(me);
      const na = { role: r, done: ns.actions.has(me.id) || ns.ndokiVotes.has(me.id), choice: ns.actions.get(me.id) || ns.ndokiVotes.get(me.id) || null };
      if (r === "policier" && me.role === "policier") na.forbidden = room.lastJail;
      if (r === "marabout" && me.role === "marabout") na.forbidden = room.lastBless;
      if (r === "gardien") na.used = room.gardienUsed;
      if (r === "femme") na.married = !!room.couple || room.night !== 1;
      if (r === "pyromane") na.doused = [...room.doused].filter((id) => room.players.get(id)?.alive);
      if (me.role === "ndoki" && me.alive) {
        na.ndokiVotes = Object.fromEntries(ns.ndokiVotes);
        na.ndokiChat = ns.ndokiChat.map((m) => ({ name: nameOf(room, m.from), text: m.text, mine: m.from === me.id }));
      }
      if (isSecte(me) && me.alive) {
        const g = alive(room).find((p) => p.role === "gourou");
        na.gourouChoice = g ? ns.actions.get(g.id) || null : null;
        na.secteChat = ns.secteChat.map((m) => ({ name: nameOf(room, m.from), text: m.text, mine: m.from === me.id }));
      }
      view.nightAction = na;
      break;
    }
    case "night_chat": {
      const ns = room.nightState;
      const arrested = ns.arrested === me.id;
      const o = ns.offer;
      view.nightChat = {
        offer: o && o.target === me.id && me.alive && o.status !== "absent" && o.status !== "protected" ? { status: o.status, locked: o.locked } : null,
        arrested,
        myPseudo: me.alive ? ns.pseudos.get(me.id) : null,
        messages: arrested ? [] : ns.chat.map((m) => ({ pseudo: m.pseudo, text: m.text, mine: m.from === me.id })),
      };
      break;
    }
    case "morning": {
      const m = room.morning;
      const vision = m.vision && m.vision.ngangaId === me.id ? m.vision : m.fakeVision && m.fakeVision.ngangaId === me.id ? m.fakeVision : null;
      view.morning = {
        deaths: m.deaths.map((d) => deathView(room, d)),
        saved: m.saved,
        vision,
        notes: room.secteNotes.get(me.id) || [],
        arrested: m.arrested === me.id,
        chefDied: !room.chefId,
      };
      break;
    }
    case "hunter": {
      const h = room.hunt;
      view.hunter = {
        hunter: { id: h.hunterId, name: nameOf(room, h.hunterId) },
        isMe: h.hunterId === me.id,
        shot: h.shot,
        deaths: (h.deaths || []).map((d) => deathView(room, d)),
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
      view.result = {
        eliminated: e ? { id: e.id, name: e.name, role: roleInfo(e.role) } : null,
        others: room.result.others.map((d) => deathView(room, d)),
        note: room.result.note,
        bouc: room.winner === "bouc",
      };
      break;
    }
    case "end":
      view.end = {
        winner: room.winner,
        couple: room.couple && [room.couple.femme, room.couple.mari],
        bilanSeen: !!me.bilanSeen,
      };
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
