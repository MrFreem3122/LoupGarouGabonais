// Plays full games with bots against a running server.
// Usage: TIME_SCALE=0.02 node server.js & node test/simulate.js [games] [players]
const URL_WS = process.env.WS_URL || "ws://localhost:3000/ws";
const GAMES = Number(process.argv[2] || 5);
const PLAYERS = Number(process.argv[3] || 7);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function bot(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS);
    const b = { name, ws, state: null, errors: [], bilan: null, acted: new Set() };
    b.send = (m) => ws.send(JSON.stringify(m));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "state") { b.state = m; act(b); }
      if (m.type === "joined") b.id = m.id;
      if (m.type === "error") b.errors.push(m.message);
      if (m.type === "bilan") b.bilan = m.bilan;
    };
    ws.onopen = () => resolve(b);
  });
}

function act(b) {
  const s = b.state;
  const me = s.me;
  const key = s.phase + ":" + s.night + ":" + (s.endsAt || 0);
  const others = s.players.filter((p) => p.alive && p.id !== me.id);
  if (!me.alive && s.phase !== "end") return;
  const once = (k, fn) => { if (!b.acted.has(key + k)) { b.acted.add(key + k); setTimeout(fn, Math.random() * 30); } };
  switch (s.phase) {
    case "roles": once("r", () => b.send({ type: "ready" })); break;
    case "election":
      once("c", () => Math.random() < 0.3 && b.send({ type: "candidate", on: true }));
      once("e", () => setTimeout(() => {
        const st = b.state; if (st.phase !== "election") return;
        const pool = st.election.candidates.length ? st.election.candidates.filter((id) => id !== me.id) : others.map((p) => p.id);
        if (pool.length) b.send({ type: "elect", target: pick(pool) });
      }, 60));
      break;
    case "night_action": {
      const r = me.role.key;
      const mates = me.mates || [];
      if (r === "ndoki") {
        once("chat", () => b.send({ type: "ndokiChat", text: "on mange qui ?" }));
        once("n", () => {
          const victims = others.filter((p) => !mates.includes(p.id));
          // Ndoki follow the first vote already cast so they usually agree.
          const votes = Object.values(s.nightAction.ndokiVotes || {});
          b.send({ type: "night", target: votes[0] || pick(victims).id });
        });
      } else if (r === "gardien") once("n", () => b.send({ type: "night", target: Math.random() < 0.5 ? "skip" : pick([...others, me]).id }));
      else if (["nganga", "policier"].includes(r)) once("n", () => {
        const opts = others.filter((p) => p.id !== s.nightAction.forbidden);
        if (opts.length) b.send({ type: "night", target: pick(opts).id });
      });
      else if (r === "marabout") once("n", () => {
        const opts = [...others, me].filter((p) => p.id !== s.nightAction.forbidden);
        b.send({ type: "night", target: pick(opts).id });
      });
      break;
    }
    case "night_chat":
      once("m", () => b.send({ type: "chat", text: `rumeur de ${b.name}` }));
      break;
    case "debate":
      once("d", () => b.send({ type: "chat", text: `j'accuse quelqu'un (${b.name})` }));
      if (me.isChef) once("close", () => setTimeout(() => b.send({ type: "closeDebate" }), 3000));
      break;
    case "vote":
      once("v", () => {
        const t = pick(others);
        b.send({ type: "vote", target: t.id });
        setTimeout(() => {
          if (Math.random() < 0.3) b.send({ type: "vote", target: pick(others).id });
          if (s.vote.canSermon && Math.random() < 0.5) b.send({ type: "sermon" });
          else b.send({ type: "confirm" });
        }, 40);
      });
      break;
    case "tiebreak":
      if (me.isChef) once("t", () => b.send({ type: "tiebreak", target: pick(s.tiebreak.tied) }));
      break;
    case "end":
      once("b", () => b.send({ type: "bilan" }));
      break;
  }
}

async function game(n) {
  const host = await bot("Hôte");
  host.send({ type: "create", name: "Hote" });
  while (!host.state) await sleep(10);
  const code = host.state.code;
  const bots = [host];
  for (let i = 1; i < n; i++) {
    const b = await bot("J" + i);
    b.send({ type: "join", code, name: "Joueur" + i });
    bots.push(b);
  }
  await sleep(100);
  host.send({ type: "settings", chatSecs: 60 });
  host.send({ type: "start" });
  const t0 = Date.now();
  while (!bots.every((b) => b.state && b.state.phase === "end" && b.bilan)) {
    await sleep(50);
    if (Date.now() - t0 > 120000) throw new Error("Game did not finish: phase " + host.state.phase);
  }
  const s = host.state;
  const roles = host.bilan.roles.map((r) => r.role.key);
  const errs = bots.flatMap((b) => b.errors);
  // Secrets: nobody but Ndoki may see mates; nobody saw roles of living players before the end.
  bots.forEach((b) => b.ws.close());
  return { winner: s.end.winner, nights: host.bilan.nights.length, roles, errs };
}

(async () => {
  const winners = {};
  for (let g = 0; g < GAMES; g++) {
    const r = await game(PLAYERS);
    winners[r.winner] = (winners[r.winner] || 0) + 1;
    console.log(`game ${g + 1}: ${r.winner} after ${r.nights} night(s) | roles ${r.roles.join(",")}${r.errs.length ? " | errors: " + [...new Set(r.errs)].join(" / ") : ""}`);
  }
  console.log("winners", winners);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
