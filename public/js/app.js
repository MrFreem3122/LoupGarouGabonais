/* Loup-Garou gabonais: the whole client. The server sends a full view of the game
   after every change; this file draws the screen for the current phase. */

/* ---------------- helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v; // only our own icon strings
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(message) {
  let t = $(".toast");
  if (!t) { t = el("div", { class: "toast", role: "status" }); document.body.append(t); }
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

const ICON = {
  send: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
};

const IMG = {
  ndoki: "/img/ndoki.jpg",
  nganga: "/img/nganga.jpg",
  policier: "/img/policier.jpg",
  marabout: "/img/marabout.jpg",
  pasteur: "/img/pasteur.jpg",
  gardien: "/img/gardien-byeri.jpg",
  bouc: "/img/bouc-emissaire.jpg",
  habitant: "/img/habitant.jpg",
  chef: "/img/chef.jpg",
  nuit: "/img/nuit.jpg",
  maquis: "/img/maquis.jpg",
  poste: "/img/au-poste.jpg",
  mange: "/img/mange.jpg",
  village: "/img/victoire-village.jpg",
  ndokiWin: "/img/victoire-ndoki.jpg",
};

const ROLE_LIST = [
  ["nganga", "Nganga", "village", "Chaque nuit, découvre le rôle d'un joueur. Une vision sur cinq est floue."],
  ["ndoki", "Ndoki", "ndoki", "Chaque nuit, mange un voisin avec les autres Ndoki. Le jour, fais semblant."],
  ["policier", "Policier", "village", "Chaque nuit, met un joueur au poste : il ne peut ni agir ni lire le chat."],
  ["marabout", "Marabout", "village", "Chaque nuit, bénit un joueur pour le protéger des Ndoki."],
  ["pasteur", "Pasteur", "village", "Une fois : son sermon fait recommencer le vote."],
  ["gardien", "Gardien des byéri", "village", "Une fois : protège un joueur avec le reliquaire."],
  ["bouc", "Bouc émissaire", "seul", "Gagne seul s'il est chassé par le vote du jour."],
  ["habitant", "Habitant", "village", "Aucun pouvoir : écoute les rumeurs, débat, vote."],
  ["chef", "Chef de quartier", "titre", "Élu par le village. Clôture le débat et départage les égalités."],
];
const CAMP_LABEL = { village: "Camp du village", ndoki: "Camp des Ndoki", seul: "Joue seul", titre: "Titre élu" };

const COLORS = ["#1f9d6b", "#3a75c4", "#b8452f", "#8e5ab8", "#c97a1e", "#24808c", "#5e6270", "#b54a7d", "#6f8a1f", "#a0522d"];

/* ---------------- state ---------------- */

const Session = {
  KEY: "lg-session",
  get() { try { return JSON.parse(localStorage.getItem(this.KEY)) || null; } catch { return null; } },
  set(s) { try { localStorage.setItem(this.KEY, JSON.stringify(s)); } catch {} },
  clear() { try { localStorage.removeItem(this.KEY); } catch {} },
};

const Clock = { offset: 0, sync(t) { this.offset = t - Date.now(); }, now() { return Date.now() + this.offset; } };

let S = null; // last state from the server
const ui = { view: "home", bilan: null };
const app = $("#app");

/* ---------------- connection ---------------- */

const conn = (() => {
  let ws;
  let retry = 0;
  let banner;
  const queue = [];
  const setBanner = (text) => {
    if (!text) { banner && banner.remove(); banner = null; return; }
    if (!banner) { banner = el("div", { class: "banner", role: "status" }); document.body.append(banner); }
    banner.textContent = text;
  };
  function open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      setBanner(null);
      const s = Session.get();
      if (s) ws.send(JSON.stringify({ type: "resume", code: s.code, token: s.token }));
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      setBanner(retry > 1 ? "Connexion perdue, reconnexion…" : "Connexion au quartier…");
      retry++;
      setTimeout(open, Math.min(5000, 600 * retry));
    };
  }
  open();
  return {
    send(obj) {
      const text = JSON.stringify(obj);
      if (ws && ws.readyState === 1) ws.send(text);
      else queue.push(text);
    },
  };
})();
const send = (type, extra = {}) => conn.send({ type, ...extra });

function onMessage(m) {
  if (m.type === "joined") {
    Session.set({ code: m.code, token: m.token });
  } else if (m.type === "state") {
    Clock.sync(m.serverNow);
    if (S && S.phase !== m.phase && m.phase !== "end") ui.view = "game";
    if (!S || S.code !== m.code) ui.view = "game";
    S = m;
    render();
  } else if (m.type === "error") {
    toast(m.message);
  } else if (m.type === "expired" || m.type === "left") {
    Session.clear();
    S = null;
    ui.view = "home";
    render();
    if (m.type === "expired") toast("Cette partie est terminée.");
  } else if (m.type === "bilan") {
    ui.bilan = m.bilan;
    ui.view = "bilan";
    render();
  }
}

/* ---------------- building blocks ---------------- */

const playerById = (id) => S.players.find((p) => p.id === id);
const colorOf = (id) => COLORS[Math.max(0, S.players.findIndex((p) => p.id === id)) % COLORS.length];
const firstLetter = (name) => String(name || "?").trim().slice(0, 2).toUpperCase();

function avatar(p, small) {
  return el("span", { class: `av${small ? " sm" : ""}${p.alive === false ? " dead" : ""}`, style: `background:${colorOf(p.id)}`, "aria-hidden": "true" }, firstLetter(p.name));
}

function phaseBar(label, timer = true) {
  return el("div", { class: "phase" },
    el("span", {}, el("span", { class: "dot" }), label),
    timer && S.endsAt ? el("span", { class: "timer", "data-ends": S.endsAt }, "") : null);
}

function bleed(src, alt, short) {
  return el("img", { class: `bleed${short ? " short" : ""}`, src, alt });
}

function art(src, alt) {
  return el("img", { class: "art", src, alt });
}

function deadNote() {
  return S.me.alive ? null : el("p", { class: "dead-note" }, "Tu as quitté le quartier : tu regardes la suite sans jouer.");
}

function pickGrid(players, { selected, disabled, onPick, label }) {
  return el("div", { class: "pick-grid", role: "group", "aria-label": label },
    players.map((p) => el("button", {
      class: "pick",
      type: "button",
      "aria-pressed": String(p.id === selected),
      disabled: disabled ? disabled(p) : false,
      onclick: () => onPick(p),
    }, avatar(p), el("span", {}, p.name))));
}

function composer(id, placeholder, onSend) {
  const input = el("input", { class: "input", id, placeholder, maxlength: "280", autocomplete: "off", "aria-label": placeholder, "data-keep": "1" });
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = "";
    input.focus();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  return el("div", { class: "composer" }, input,
    el("button", { class: "btn", type: "button", "aria-label": "Envoyer", html: ICON.send, onclick: submit }));
}

function chatLog(id, messages, render, emptyText) {
  return el("div", { class: "chat", id, "data-scroll": "1" },
    messages.length ? messages.map(render) : el("p", { class: "muted small empty" }, emptyText));
}

function roleName(role) { return role ? role.name : "?"; }
function campClass(camp) { return `camp-${camp}`; }

/* ---------------- screens ---------------- */

function screenHome() {
  const params = new URLSearchParams(location.search);
  const code = el("input", { class: "input code", id: "code", maxlength: "4", autocomplete: "off", value: params.get("code") || "", placeholder: "KMBA", "data-keep": "1" });
  const name = el("input", { class: "input", id: "name", maxlength: "20", autocomplete: "nickname", value: localStorage.getItem("lg-name") || "", "data-keep": "1" });
  const remember = () => { try { localStorage.setItem("lg-name", name.value.trim()); } catch {} };
  return el("section", { class: "screen" },
    bleed(IMG.nuit, "Une rue du quartier la nuit, des voisins chuchotent sous les lampadaires"),
    el("p", { style: "color:var(--lamp);font-weight:700;font-size:17px" }, "Ce soir, au quartier"),
    el("h1", { style: "font-size:46px;line-height:0.95" }, "Loup-Garou gabonais"),
    el("p", { class: "muted", style: "font-size:16px;line-height:1.45" }, "Des Ndoki se cachent parmi vous. Trouvez-les au maquis avant qu'ils ne mangent tout le quartier."),
    el("label", { class: "field", for: "code" }, "Code de la partie", code),
    el("label", { class: "field", for: "name" }, "Ton pseudo", name),
    el("button", { class: "btn", type: "button", onclick: () => {
      if (code.value.trim().length !== 4) return toast("Entre le code de 4 lettres que l'hôte a partagé.");
      if (!name.value.trim()) return toast("Choisis un pseudo.");
      remember();
      send("join", { code: code.value.trim().toUpperCase(), name: name.value.trim() });
    } }, "Rejoindre la partie"),
    el("button", { class: "btn ghost", type: "button", onclick: () => {
      if (!name.value.trim()) return toast("Choisis un pseudo avant de créer la partie.");
      remember();
      send("create", { name: name.value.trim() });
    } }, "Créer une partie"),
    el("button", { class: "link-btn", type: "button", onclick: () => { ui.view = "rules"; render(); } }, "Voir les rôles du quartier"));
}

function screenRules() {
  return el("section", { class: "screen" },
    el("div", { class: "row" },
      el("button", { class: "link-btn", type: "button", "aria-label": "Retour", html: ICON.back, onclick: () => { ui.view = S ? "game" : "home"; render(); } }),
      el("h1", { style: "font-size:30px" }, "Les rôles")),
    el("p", { class: "muted small" }, "Chacun reçoit un rôle secret. Les Ndoki se reconnaissent entre eux. Un rôle n'est révélé qu'à l'élimination du joueur."),
    el("div", { class: "roles-grid" }, ROLE_LIST.map(([key, name, camp, text]) =>
      el("div", { class: "card role-card" },
        el("img", { src: IMG[key], alt: `Illustration du rôle ${name}`, loading: "lazy" }),
        el("h2", { style: "font-size:19px" }, name),
        el("p", { class: `small ${campClass(camp)}`, style: "font-weight:700" }, CAMP_LABEL[camp]),
        el("p", { class: "small muted" }, text)))));
}

function screenLobby() {
  const me = S.me;
  const link = `${location.origin}/j/${S.code}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`Viens jouer au Loup-Garou gabonais ! Code : ${S.code}\n${link}`)}`;
  const n = S.players.length;
  const host = S.players.find((p) => p.isHost);
  return el("section", { class: "screen" },
    phaseBar("Salon · en attente", false),
    el("div", { class: "card", style: "align-items:center;text-align:center" },
      el("p", { class: "small muted", style: "font-weight:600" }, "Code de la partie"),
      el("p", { style: "font-family:var(--display);font-weight:800;font-size:58px;letter-spacing:0.12em" }, S.code),
      el("a", { class: "btn green", href: wa, target: "_blank", rel: "noopener" }, "Partager sur WhatsApp"),
      el("button", { class: "link-btn", type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(link); toast("Lien copié."); } catch { toast(link); }
      } }, "Copier le lien")),
    el("div", { class: "row between" }, el("h2", { style: "font-size:22px" }, "Joueurs"), el("span", { class: "muted", style: "font-weight:600" }, `${n} / 10`)),
    el("div", { class: "card list" }, S.players.map((p) =>
      el("div", { class: "item" }, avatar(p), el("span", { class: "grow", style: "font-weight:600" }, p.name, p.id === me.id ? " (toi)" : ""),
        p.isHost ? el("span", { class: "tag" }, "hôte") : null,
        !p.connected ? el("span", { class: "tag off" }, "hors ligne") : null))),
    me.isHost
      ? el("label", { class: "field", for: "chatSecs" }, "Durée du chat de nuit",
          el("select", { class: "input", id: "chatSecs", onchange: (e) => send("settings", { chatSecs: Number(e.target.value) }) },
            [60, 90, 120].map((s) => el("option", { value: s, selected: S.settings.chatSecs === s }, `${s} secondes`))))
      : el("p", { class: "muted small" }, `Chat de nuit : ${S.settings.chatSecs} s. ${host ? host.name : "L'hôte"} lancera la partie.`),
    el("div", { class: "grow" }),
    me.isHost
      ? el("button", { class: "btn", type: "button", disabled: n < 4, onclick: () => send("start") }, n < 4 ? `Encore ${4 - n} joueur${4 - n > 1 ? "s" : ""} pour lancer` : "Lancer la partie")
      : null,
    el("button", { class: "link-btn", type: "button", onclick: () => send("leave") }, "Quitter la partie"));
}

function screenRoles() {
  const r = S.me.role;
  const mates = (S.me.mates || []).map(playerById).filter(Boolean);
  return el("section", { class: "screen" },
    phaseBar("Ton rôle, en secret"),
    art(IMG[r.key], `Illustration du rôle ${r.name}`),
    el("div", { class: "center stack" },
      el("h1", { style: "font-size:44px" }, r.name),
      el("p", { class: campClass(r.camp), style: "font-weight:700" }, CAMP_LABEL[r.camp]),
      el("p", { style: "font-size:16px;line-height:1.45" }, r.power),
      mates.length ? el("p", { class: "small" }, "Tes complices Ndoki : ", el("b", {}, mates.map((m) => m.name).join(", "))) : null,
      el("p", { class: "small muted" }, "Ne le montre à personne.")),
    el("div", { class: "grow" }),
    S.roles.ready
      ? el("p", { class: "center muted" }, `En attente des autres (${S.roles.readyCount} / ${S.players.length})`)
      : el("button", { class: "btn", type: "button", onclick: () => send("ready") }, "J'ai compris"));
}

function screenElection() {
  const e = S.election;
  const me = S.me;
  const living = S.players.filter((p) => p.alive);
  const pool = e.candidates.length ? e.candidates.map(playerById).filter(Boolean) : living;
  const isCandidate = e.candidates.includes(me.id);
  return el("section", { class: "screen" },
    bleed(IMG.chef, "Le Chef de quartier fait sonner sa cloche au maquis", true),
    phaseBar(S.night ? "Nouveau Chef de quartier" : "Élection du Chef"),
    deadNote(),
    el("h1", { style: "font-size:30px" }, "Qui sera Chef de quartier ?"),
    el("p", { class: "muted small" }, "Le Chef clôture le débat chaque jour et départage les égalités. Il garde son rôle secret."),
    me.alive ? el("button", { class: "btn ghost small", type: "button", onclick: () => send("candidate", { on: !isCandidate }) }, isCandidate ? "Retirer ma candidature" : "Me porter candidat") : null,
    el("p", { class: "small muted" }, e.candidates.length ? "Candidats :" : "Pas encore de candidat : tu peux voter pour n'importe qui."),
    el("div", { class: "stack" }, pool.map((p) => {
      const votes = e.counts[p.id] || 0;
      const mine = e.myVote === p.id;
      return el("button", {
        class: "card row between vote-row",
        type: "button",
        style: "flex-direction:row;padding:10px 14px",
        "aria-pressed": String(mine),
        disabled: !me.alive || p.id === me.id,
        onclick: () => send("elect", { target: p.id }),
      }, el("span", { class: "row" }, avatar(p), el("b", {}, p.name, p.id === me.id ? " (toi)" : "")), el("span", { style: "font-weight:700" }, `${votes} voix`));
    })),
    e.myVote ? el("p", { class: "small", style: "font-weight:600" }, `Tu as voté pour ${playerById(e.myVote)?.name}. Tu peux changer jusqu'à la fin.`) : null);
}

const NIGHT_PROMPTS = {
  nganga: ["Qui consulter cette nuit ?", "Les esprits te diront son rôle demain matin."],
  policier: ["Qui mettre au poste ?", "Il ne pourra ni agir ni lire le chat cette nuit."],
  marabout: ["Qui bénir cette nuit ?", "Ta bénédiction le protège des Ndoki. Tu peux te bénir toi-même."],
  gardien: ["Utiliser le reliquaire ?", "Une seule fois dans la partie : il protège un joueur pour cette nuit."],
};

function screenNightAction() {
  const me = S.me;
  const na = S.nightAction;
  const role = me.role.key;
  const living = S.players.filter((p) => p.alive);
  const others = living.filter((p) => p.id !== me.id);
  const bar = phaseBar(`Nuit ${S.night} · phase d'action`);

  if (!me.alive) {
    return el("section", { class: "screen" }, bleed(IMG.nuit, "La rue du quartier la nuit"), bar, deadNote(),
      el("h1", { style: "font-size:30px" }, "La nuit tombe sur le quartier."),
      el("p", { class: "muted" }, "Les rôles agissent en silence."));
  }

  if (role === "ndoki") {
    const mates = me.mates || [];
    const targets = living.filter((p) => p.id !== me.id && !mates.includes(p.id));
    const votes = na.ndokiVotes || {};
    const tally = {};
    for (const t of Object.values(votes)) tally[t] = (tally[t] || 0) + 1;
    return el("section", { class: "screen" },
      bleed(IMG.ndoki, "Une Ndoki souriante avec un hibou sur l'épaule", true), bar,
      el("h1", { style: "font-size:28px" }, "Qui manger cette nuit ?"),
      pickGrid(targets, { selected: na.choice, label: "Choisir la victime", onPick: (p) => send("night", { target: p.id }) }),
      Object.keys(tally).length
        ? el("p", { class: "small" }, "Votes des Ndoki : ", Object.entries(tally).map(([id, c]) => `${playerById(id)?.name} (${c})`).join(", "), ". Il faut être d'accord, sinon personne n'est mangé.")
        : el("p", { class: "small muted" }, "Mettez-vous d'accord : en cas d'égalité, personne n'est mangé."),
      mates.length ? el("div", { class: "card danger" },
        el("p", { class: "small", style: "font-weight:700;color:var(--red-soft)" }, "Canal des Ndoki"),
        chatLog("ndokiChat", na.ndokiChat || [], (m) => el("p", { class: "small" }, el("b", { style: "color:var(--red-soft)" }, `${m.name} : `), m.text), "Personne n'a encore parlé."),
        composer("ndokiMsg", "Écris à tes complices…", (text) => send("ndokiChat", { text }))) : null);
  }

  if (NIGHT_PROMPTS[role]) {
    const [title, help] = NIGHT_PROMPTS[role];
    if (role === "gardien" && na.used) {
      return el("section", { class: "screen" }, bleed(IMG.gardien, "Le Gardien des byéri serre son reliquaire"), bar,
        el("h1", { style: "font-size:28px" }, "Le reliquaire a déjà servi."), el("p", { class: "muted" }, "Repose-toi cette nuit."));
    }
    const pool = role === "marabout" || role === "gardien" ? living : others;
    const forbidden = na.forbidden;
    const chosen = na.choice && na.choice !== "skip" ? playerById(na.choice) : null;
    return el("section", { class: "screen" },
      bleed(IMG[role === "gardien" ? "gardien" : "nuit"], role === "gardien" ? "Le Gardien des byéri serre son reliquaire" : "La rue du quartier la nuit", true), bar,
      el("h1", { style: "font-size:28px" }, title),
      el("p", { class: "muted small" }, help),
      pickGrid(pool, {
        selected: na.choice,
        label: title,
        disabled: (p) => p.id === forbidden,
        onPick: (p) => send("night", { target: p.id }),
      }),
      forbidden ? el("p", { class: "small muted" }, `Pas ${playerById(forbidden)?.name} : déjà choisi la nuit dernière.`) : null,
      role === "gardien" ? el("button", { class: "btn ghost", type: "button", "aria-pressed": String(na.choice === "skip"), onclick: () => send("night", { target: "skip" }) }, na.choice === "skip" ? "Tu gardes le reliquaire cette nuit" : "Garder le reliquaire pour plus tard") : null,
      chosen ? el("p", { class: "small", style: "font-weight:600;color:var(--lamp)" }, `Choix enregistré : ${chosen.name}. Tu peux changer jusqu'à la fin.`) : null);
  }

  return el("section", { class: "screen" },
    bleed(IMG.nuit, "La rue du quartier la nuit, des voisins chuchotent sous les lampadaires"), bar,
    el("h1", { style: "font-size:30px" }, "Le quartier dort."),
    el("p", { class: "muted" }, role === "pasteur"
      ? "Rien à faire cette nuit. Ton sermon se garde pour un vote du jour."
      : "Rien à faire cette nuit. Le chat de nuit commence juste après."));
}

function screenNightChat() {
  const nc = S.nightChat;
  const bar = phaseBar(`Nuit ${S.night} · chat de nuit`);
  if (nc.arrested) {
    return el("section", { class: "screen" },
      bleed(IMG.poste, "Un voisin vexé, assis au poste, à qui un policier souhaite bonne nuit"), bar,
      el("h1", { style: "font-size:32px" }, "Tu passes la nuit au poste."),
      el("p", { class: "muted" }, "Pas d'action ni de chat cette nuit. Personne d'autre ne le saura."));
  }
  return el("section", { class: "screen" },
    bleed(IMG.nuit, "La rue du quartier la nuit", true), bar, deadNote(),
    el("h1", { style: "font-size:28px" }, "Rumeurs du quartier"),
    nc.myPseudo ? el("p", { class: "small muted" }, "Tout le monde écrit sous un pseudo tiré au hasard. Ce soir, tu es ", el("span", { class: "sign" }, nc.myPseudo)) : null,
    chatLog("nightChat", nc.messages, (m) => el("div", { class: `msg${m.mine ? " mine" : ""}` },
      el("span", { class: "sign" }, m.pseudo, m.mine ? " (toi)" : ""), el("p", { class: "bubble" }, m.text)), "Le quartier est silencieux… lance une rumeur."),
    el("div", { class: "grow" }),
    S.me.alive ? composer("nightMsg", "Écris une rumeur…", (text) => send("chat", { text })) : null);
}

function screenMorning() {
  const m = S.morning;
  const v = m.victim;
  const victim = v && playerById(v.id);
  return el("section", { class: "screen" },
    v ? bleed(IMG.mange, "Une chaise vide, une assiette renversée et des plumes de hibou devant une maison") : bleed(IMG.maquis, "Le maquis du quartier au matin"),
    phaseBar(`Jour ${S.night} · matin`),
    v
      ? el("div", { class: "row" }, avatar(victim || v), el("div", {}, el("h2", { style: "font-size:24px" }, `Les Ndoki ont mangé ${v.name}`), el("p", { class: "small muted" }, `C'était : ${roleName(v.role)}`)))
      : el("h2", { style: "font-size:26px" }, "Personne n'a été mangé cette nuit."),
    m.saved ? el("div", { class: "card" }, el("b", {}, "Une protection a agi cette nuit."), el("p", { class: "small muted" }, "Quelqu'un aurait dû mourir, mais a été protégé.")) : null,
    m.chefDied ? el("p", { class: "small", style: "font-weight:600" }, "Le Chef de quartier n'est plus là : le village va en élire un nouveau.") : null,
    m.vision ? el("div", { class: "card", style: "background:var(--night);color:var(--moon)" },
      el("p", { class: "small", style: "color:var(--lamp);font-weight:700" }, "Ta vision, rien que pour toi"),
      el("p", { style: "font-size:17px" }, el("b", {}, m.vision.name), m.vision.blurry
        ? ` est du camp ${m.vision.camp === "ndoki" ? "des Ndoki" : m.vision.camp === "seul" ? "solitaire" : "du village"}. La vision était floue.`
        : ` est ${m.vision.role.name}.`)) : null,
    m.arrested ? el("p", { class: "small muted" }, "Tu as passé la nuit au poste.") : null,
    el("div", { class: "grow" }),
    el("p", { class: "center muted small" }, "Le maquis ouvre dans ", el("span", { "data-ends": S.endsAt, "data-plain": "1" }, "")));
}

function screenDebate() {
  const d = S.debate;
  const me = S.me;
  const canClose = Clock.now() >= d.minAt;
  return el("section", { class: "screen" },
    bleed(IMG.maquis, "Des voisins débattent et s'accusent en riant autour d'une table du maquis", true),
    phaseBar(`Jour ${S.night} · débat au maquis`), deadNote(),
    d.nightChat.length ? el("details", { class: "card" },
      el("summary", { style: "cursor:pointer;font-weight:700" }, `Rumeurs de la nuit (${d.nightChat.length})`),
      el("div", { class: "stack", style: "margin-top:8px" }, d.nightChat.map((m) => el("p", { class: "small" }, el("b", {}, `${m.pseudo} : `), m.text)))) : null,
    chatLog("debateChat", d.messages, (m) => el("div", { class: `msg${m.mine ? " mine" : ""}` },
      el("span", { class: "who" }, m.name), el("p", { class: "bubble" }, m.text)), "Le maquis attend : accuse, défends-toi, raconte ton rêve."),
    el("div", { class: "grow" }),
    me.alive ? composer("debateMsg", "Accuser, défendre…", (text) => send("chat", { text })) : null,
    me.isChef ? el("button", { class: "btn", type: "button", disabled: !canClose, "data-enable-at": d.minAt, onclick: () => send("closeDebate") },
      "Chef : clôturer le débat") : el("p", { class: "center muted small" }, `Le Chef (${S.players.find((p) => p.isChef)?.name || "?"}) clôture le débat.`));
}

function screenVote() {
  const v = S.vote;
  const me = S.me;
  const living = S.players.filter((p) => p.alive);
  const byTarget = {};
  for (const i of v.intents) (byTarget[i.target] = byTarget[i.target] || []).push(i);
  const rows = [...living].sort((a, b) => (byTarget[b.id]?.length || 0) - (byTarget[a.id]?.length || 0));
  const feed = v.feed.map((f) => f.sermon ? "Sermon du Pasteur : le vote recommence à zéro !" : f.from ? `${f.voter} change d'avis : ${f.from} → ${f.to}` : `${f.voter} veut voter pour ${f.to}`);
  return el("section", { class: "screen" },
    phaseBar(`Jour ${S.night} · vote en direct`), deadNote(),
    el("h1", { style: "font-size:30px" }, "Qui quitte le quartier ?"),
    feed.length ? el("div", { class: "card feed" }, feed.map((t) => el("p", {}, t))) : null,
    el("div", { class: "stack" }, rows.map((p) => {
      const voters = byTarget[p.id] || [];
      return el("button", {
        class: "card vote-row",
        type: "button",
        "aria-pressed": String(v.myVote === p.id),
        disabled: !me.alive || p.id === me.id,
        onclick: () => send("vote", { target: p.id }),
      },
        el("span", { class: "row between" }, el("span", { class: "row" }, avatar(p), el("b", {}, p.name, p.id === me.id ? " (toi)" : "")), el("span", { class: "vote-count" }, voters.length)),
        el("span", { class: "voters" }, voters.map((i) => avatar(playerById(i.voter) || { id: i.voter, name: "?" }, true))));
    })),
    v.canSermon ? el("button", { class: "card row", type: "button", style: "flex-direction:row;gap:14px;cursor:pointer;color:inherit;border:0;text-align:left", onclick: () => send("sermon") },
      el("img", { src: IMG.pasteur, alt: "", style: "width:84px;height:84px;object-fit:cover;border-radius:14px;flex:none" }),
      el("span", {}, el("b", {}, "Lancer le sermon"), el("br"), el("span", { class: "small muted" }, "Le vote recommence à zéro. Une seule fois par partie."))) : null,
    el("div", { class: "grow" }),
    me.alive
      ? el("button", { class: "btn red", type: "button", disabled: !v.myVote || v.confirmed, onclick: () => send("confirm") },
          v.confirmed ? `Confirmé : ${playerById(v.myVote)?.name}` : v.myVote ? `Je confirme : ${playerById(v.myVote)?.name}` : "Choisis un joueur")
      : null,
    el("p", { class: "center muted small" }, "Le vote se ferme à la fin du temps, ou quand tout le monde a confirmé."));
}

function screenTiebreak() {
  const tied = S.tiebreak.tied.map(playerById).filter(Boolean);
  const isChef = S.me.isChef;
  return el("section", { class: "screen" },
    bleed(IMG.chef, "Le Chef de quartier fait sonner sa cloche", true),
    phaseBar("Égalité"),
    el("h1", { style: "font-size:30px" }, isChef ? "Égalité : à toi de trancher." : "Égalité : le Chef tranche."),
    el("p", { class: "muted small" }, `Ex-aequo : ${tied.map((p) => p.name).join(", ")}.`),
    isChef ? pickGrid(tied, { label: "Choisir qui quitte le quartier", onPick: (p) => send("tiebreak", { target: p.id }) }) : null);
}

function screenResult() {
  const r = S.result;
  const e = r.eliminated;
  return el("section", { class: "screen" },
    phaseBar(`Jour ${S.night} · résultat`, false),
    e ? art(IMG[e.role.key], `Illustration du rôle ${e.role.name}`) : art(IMG.maquis, "Le maquis du quartier"),
    el("div", { class: "center stack", style: "align-items:center" },
      e ? el("p", { class: "muted" }, "Le quartier chasse") : null,
      el("h1", { style: "font-size:42px" }, e ? e.name : "Personne ne part."),
      e ? el("span", { class: `sign${e.role.camp === "ndoki" ? " red" : ""}`, style: "font-size:16px;padding:8px 14px" }, `C'était : ${e.role.name}`) : null,
      r.note ? el("p", { class: "small muted" }, r.note) : null,
      r.bouc ? el("p", { style: "font-weight:700;color:var(--lamp)" }, "Le Bouc émissaire voulait justement être chassé : il gagne seul !") : null),
    el("div", { class: "grow" }),
    el("p", { class: "center muted small" }, "La suite dans ", el("span", { "data-ends": S.endsAt, "data-plain": "1" }, "")));
}

const WIN = {
  village: ["Victoire du village", "Le quartier dort tranquille.", IMG.village, "Les habitants dansent au lever du soleil"],
  ndoki: ["Victoire des Ndoki", "Le quartier a été mangé.", IMG.ndokiWin, "Les Ndoki satisfaites autour d'une grande marmite"],
  bouc: ["Victoire du Bouc émissaire", "Il voulait être chassé. C'est fait.", IMG.bouc, "Le Bouc émissaire et sa chèvre"],
};

function screenEnd() {
  const [label, title, img, alt] = WIN[S.end.winner] || WIN.village;
  return el("section", { class: "screen" },
    bleed(img, alt),
    el("p", { style: "color:var(--lamp);font-weight:700" }, label),
    el("h1", { style: "font-size:34px" }, title),
    el("div", { class: "pick-grid", style: "grid-template-columns:repeat(3,minmax(0,1fr))" }, S.players.map((p) =>
      el("div", { class: "stack center", style: "align-items:center;gap:4px" },
        el("img", { src: IMG[p.role?.key] || IMG.habitant, alt: "", style: `width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:14px;${p.alive ? "" : "filter:grayscale(0.8);opacity:0.7"}` }),
        el("b", { class: "small" }, p.name),
        el("span", { class: `small ${campClass(p.role?.camp)}`, style: "font-weight:700;font-size:12px" }, p.role?.name || "")))),
    el("div", { class: "grow" }),
    el("button", { class: "btn", type: "button", onclick: () => send("bilan") }, "Voir mon bilan"),
    el("p", { class: "center muted small" }, "Le bilan est privé, et il disparaît quand le dernier joueur quitte la partie."),
    S.me.isHost ? el("button", { class: "btn ghost", type: "button", onclick: () => send("restart") }, "Rejouer avec le même quartier") : null,
    el("button", { class: "link-btn", type: "button", onclick: () => send("leave") }, "Quitter"));
}

function screenBilan() {
  const b = ui.bilan;
  const list = (items) => el("ul", {}, items.map((t) => el("li", {}, t)));
  return el("section", { class: "screen bilan" },
    el("div", { class: "row" },
      el("button", { class: "link-btn", type: "button", "aria-label": "Retour", html: ICON.back, onclick: () => { ui.view = "game"; render(); } }),
      el("h1", { style: "font-size:30px" }, "Ton bilan")),
    el("h3", {}, "Les rôles"),
    list(b.roles.map((r) => `${r.name} : ${r.role?.name}${r.alive ? "" : " (éliminé)"}`)),
    b.elections.length ? el("h3", {}, "Les Chefs élus") : null,
    b.elections.length ? list(b.elections.map((e) => `${e.chef}${e.drawn ? " (tiré au sort)" : ""}. Votes : ${e.votes.map((v) => `${v.voter} → ${v.target}`).join(", ") || "aucun"}`)) : null,
    ...b.nights.map((n) => [
      el("h3", {}, `Nuit ${n.night}`),
      list([
        `Ndoki : ${n.ndokiVotes.map((v) => `${v.ndoki} → ${v.target}`).join(", ") || "aucun choix"}`,
        n.victim ? `Victime : ${n.victim}` : n.saved ? "La victime a été protégée." : "Personne n'a été mangé.",
        n.arrested ? `Au poste : ${n.arrested}` : null,
        n.blessed ? `Béni par le Marabout : ${n.blessed}` : null,
        n.reliquary ? `Protégé par le reliquaire : ${n.reliquary}` : null,
        n.vision ? `Vision de ${n.vision.nganga} : ${n.vision.target}${n.vision.blurry ? " (floue)" : ""}` : null,
        `Pseudos : ${n.pseudos.map((p) => `${p.pseudo} = ${p.name}`).join(", ")}`,
      ].filter(Boolean)),
      n.chat.length ? list(n.chat.map((m) => `${m.pseudo} (${m.name}) : ${m.text}`)) : null,
    ]).flat(),
    ...b.days.map((d) => [
      el("h3", {}, `Vote du jour ${d.day}`),
      list([
        ...d.history.map((h) => h.sermon ? `Sermon de ${h.by} : le vote recommence` : h.from ? `${h.voter} change : ${h.from} → ${h.to}` : `${h.voter} vote ${h.to}`),
        `Chassé : ${d.eliminated || "personne"}`,
      ]),
    ]).flat());
}

/* ---------------- render ---------------- */

const DAY_PHASES = ["lobby", "election", "morning", "debate", "vote", "tiebreak"];

function render() {
  // Keep what the player is typing and the scroll of chat logs across redraws.
  const active = document.activeElement && document.activeElement.id;
  const kept = {};
  document.querySelectorAll("[data-keep]").forEach((i) => (kept[i.id] = { value: i.value, start: i.selectionStart }));
  const scrolls = {};
  document.querySelectorAll("[data-scroll]").forEach((c) => (scrolls[c.id] = { top: c.scrollTop, atEnd: c.scrollTop + c.clientHeight >= c.scrollHeight - 30 }));
  const prevKey = app.dataset.key;

  let node;
  if (ui.view === "rules") node = screenRules();
  else if (!S) node = screenHome();
  else if (ui.view === "bilan" && ui.bilan) node = screenBilan();
  else {
    const screens = {
      lobby: screenLobby, roles: screenRoles, election: screenElection, night_action: screenNightAction,
      night_chat: screenNightChat, morning: screenMorning, debate: screenDebate, vote: screenVote,
      tiebreak: screenTiebreak, result: screenResult, end: screenEnd,
    };
    node = (screens[S.phase] || screenLobby)();
  }
  const key = S ? `${S.phase}:${S.night}:${ui.view}` : ui.view;
  document.body.classList.toggle("is-day", !!S && ui.view !== "rules" && DAY_PHASES.includes(S.phase) && ui.view !== "bilan");
  app.replaceChildren(node);
  app.dataset.key = key;

  for (const [id, k] of Object.entries(kept)) {
    const i = document.getElementById(id);
    if (i && k.value) { i.value = k.value; }
  }
  if (active && document.getElementById(active)) {
    const i = document.getElementById(active);
    i.focus();
    if (kept[active] && i.setSelectionRange) try { i.setSelectionRange(kept[active].start, kept[active].start); } catch {}
  }
  document.querySelectorAll("[data-scroll]").forEach((c) => {
    const s = scrolls[c.id];
    c.scrollTop = !s || s.atEnd ? c.scrollHeight : s.top;
  });
  if (prevKey !== key) window.scrollTo(0, 0);
  tick();
}

function tick() {
  const now = Clock.now();
  document.querySelectorAll("[data-ends]").forEach((t) => {
    const left = Math.max(0, Number(t.dataset.ends) - now);
    const s = Math.ceil(left / 1000);
    t.textContent = t.dataset.plain ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    t.classList.toggle("low", s <= 10);
  });
  document.querySelectorAll("[data-enable-at]").forEach((b) => {
    const left = Number(b.dataset.enableAt) - now;
    b.disabled = left > 0;
    b.textContent = left > 0 ? `Chef : clôturer (possible dans ${Math.ceil(left / 1000)} s)` : "Chef : clôturer le débat";
  });
}
setInterval(tick, 250);

render();
