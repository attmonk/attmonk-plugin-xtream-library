// Per-viewer, in-memory moments. Only mature channel-delay snapshots enter here.
class SportsMomentLedger {
  constructor() { this.ready = false; this.seen = new Set(); this.completed = false; this.score = ""; }
  ingest(data, notify = true) {
    const output = [], fresh = [];
    for (const play of (Array.isArray(data.plays) ? data.plays : [])) {
      const key = String(play.id || [play.period, play.clock, play.text].join("|"));
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const kind = play.scoring ? "score" : (play.injury || /\binjury (?:timeout|time out)\b/i.test(play.text || "")) ? "injury" : "";
      if (kind) fresh.push({id: "play:" + key, kind, text: String(play.text || (kind === "score" ? "Scoring play" : "Injury timeout"))});
    }
    const known = value => value !== undefined && value !== null && String(value) !== "";
    const score = known(data.homeScore) && known(data.awayScore) ? data.awayScore + " – " + data.homeScore : "";
    if (this.ready && notify) {
      output.push(...fresh.slice(0, 3));
      if (score && this.score && score !== this.score && !fresh.some(play => play.kind === "score"))
        output.push({id: "score:" + score, kind: "score", text: "Score update · " + score});
      if (data.completed && !this.completed) output.unshift({id: "final", kind: "final", text: "Final" + (score ? " · " + score : "")});
    }
    this.ready = true; this.completed = !!data.completed; this.score = score;
    this.seen = new Set([...this.seen].slice(-256));
    return output;
  }
}
const sportsMoments = {viewer: "", generation: 0, games: new Map(), queue: [], requests: new Map(), lastPoll: -Infinity, lastAnnounced: ""};
function stopSportsMoments() {
  sportsMoments.generation++;
  for (const request of sportsMoments.requests.values()) request.abort();
  sportsMoments.requests.clear(); sportsMoments.games.clear(); sportsMoments.queue = [];
  sportsMoments.lastPoll = -Infinity; sportsMoments.lastAnnounced = "";
  const banner = byId("sports-moment-banner");
  if (banner) banner.remove();
}
function sportsMomentEntry(event, channel) {
  const id = sportsEventStateID(event);
  let entry = sportsMoments.games.get(id);
  if (!entry) {
    entry = {event, channel, ledger: new SportsMomentLedger(), buffer: new SportsCompanionBuffer(), receipt: null, reset: false, lastScheduled: performance.now()};
    sportsMoments.games.set(id, entry);
  }
  entry.event = event; entry.channel = channel;
  return entry;
}
function sportsMomentObserve(entry, sample, active) {
  if (!sample || sample.at === entry.receipt) return;
  if (entry.reset) { entry.ledger = new SportsMomentLedger(); entry.reset = false; }
  entry.receipt = sample.at;
  const feedTime = Number(sample.data.updatedAtUnix) || 0;
  if (entry.feedTime && feedTime < entry.feedTime) return;
  entry.feedTime = feedTime;
  const budget = sportsCompanionDelay(entry.channel.id) + 75;
  const age = Date.now() / 1000 - feedTime;
  const fresh = active && feedTime > 0 && age >= -10 && age <= budget && performance.now() - sample.at <= budget * 1000;
  for (const moment of entry.ledger.ingest(sample.data, fresh)) {
    sportsMoments.queue.unshift({...moment, event: entry.event, channelID: String(entry.channel.id), received: performance.now()});
  }
  sportsMoments.queue = sportsMoments.queue.slice(0, 16);
}
function updateSportsMoments(event, sample) {
  const viewer = sportsCompanionViewer();
  if (sportsMoments.viewer !== viewer) { stopSportsMoments(); sportsMoments.viewer = viewer; }
  if (!prefs().sportsMomentsEnabled || !event || !state.currentChannel) { stopSportsMoments(); return; }
  const active = !document.hidden && !prefs().sportsSpoilersHidden && !prefs().sportsPlayerSpoilersHidden && sportsAssistPlaybackActive();
  const current = sportsMomentEntry(event, state.currentChannel);
  sportsMomentObserve(current, sample, active);
  if (!active) {
    sportsMoments.queue = [];
    for (const entry of sportsMoments.games.values()) entry.reset = true;
    for (const request of sportsMoments.requests.values()) request.abort();
    sportsMoments.requests.clear();
    renderSportsMomentBanner(null);
    return;
  }
  const candidates = typeof playerSportsEvents === "function" ? playerSportsEvents().filter(game => {
    return game.live && !game.completed && sportsEventStateID(game) !== sportsEventStateID(event) && sportsEventIsFollowed(game);
  }).slice(0, 3) : [];
  // A completed game can leave the live list before its delayed final matures.
  const scheduled = new Set(candidates.map(sportsEventStateID));
  for (const [id, entry] of sportsMoments.games) {
    if (candidates.length >= 3) break;
    if (id === sportsEventStateID(event) || scheduled.has(id) || entry.ledger.completed || !sportsEventIsFollowed(entry.event) || !channelByID(entry.channel.id)) continue;
    if (performance.now() - entry.lastScheduled > (sportsCompanionDelay(entry.channel.id) + 90) * 1000) continue;
    candidates.push(entry.event);
  }
  const keep = new Set([sportsEventStateID(event)]);
  for (const game of candidates) {
    const channel = playerSportsEventChannel(game);
    if (!channel || Number(channel.score) < 60 || !channelByID(channel.id)) continue;
    keep.add(sportsEventStateID(game));
    const entry = sportsMomentEntry(game, channel);
    if (scheduled.has(sportsEventStateID(game))) entry.lastScheduled = performance.now();
    sportsMomentObserve(entry, entry.buffer.read(sportsEventStateID(game), sportsCompanionDelay(channel.id), performance.now()), true);
  }
  for (const id of sportsMoments.games.keys()) if (!keep.has(id)) {
    sportsMoments.games.delete(id);
    const request = sportsMoments.requests.get(id); if (request) request.abort();
    sportsMoments.requests.delete(id);
  }
  if (performance.now() - sportsMoments.lastPoll >= 30000) {
    sportsMoments.lastPoll = performance.now();
    for (const [id, entry] of sportsMoments.games) {
      if (id === sportsEventStateID(event) || sportsMoments.requests.has(id)) continue;
      const abort = new AbortController(), generation = sportsMoments.generation;
      const timer = setTimeout(() => abort.abort(), 12000);
      sportsMoments.requests.set(id, abort);
      coreFetch(route("/dispatcharr/api/sports?game_stats=" + encodeURIComponent(id)), {credentials: "same-origin", signal: abort.signal})
        .then(response => { if (!response.ok) throw new Error("Moments unavailable"); return response.json(); })
        .then(data => {
          if (!abort.signal.aborted && generation === sportsMoments.generation && viewer === sportsCompanionViewer() && !document.hidden && prefs().sportsMomentsEnabled && sportsMoments.games.get(id) === entry && data.available)
            entry.buffer.push(id, data, performance.now());
        }).catch(() => {}).finally(() => { clearTimeout(timer); if (sportsMoments.requests.get(id) === abort) sportsMoments.requests.delete(id); });
    }
  }
  const latest = sportsMoments.queue[0];
  renderSportsMomentBanner(latest && performance.now() - latest.received < 8000 ? latest : null);
}
function sportsMomentButton(moment) {
  const label = sportsTeamName(moment.event.away) + " at " + sportsTeamName(moment.event.home);
  const text = '<strong>' + escapeHTML(label) + '</strong><span>' + escapeHTML(moment.text) + '</span>';
  return moment.channelID === String((state.currentChannel || {}).id)
    ? '<div class="sports-moment-item">' + text + '</div>'
    : '<button type="button" class="sports-moment-item" data-player-sports-channel="' + escapeHTML(moment.channelID) + '">' + text + '<small>Watch game</small></button>';
}
function renderSportsMomentBanner(moment) {
  let root = byId("sports-moment-banner");
  if (!moment) { if (root) root.remove(); return; }
  if (!root) {
    const stage = document.querySelector(".playback-stage"); if (!stage) return;
    root = document.createElement("aside"); root.id = "sports-moment-banner"; root.className = "sports-moment-banner";
    root.innerHTML = '<div data-moment-action></div><p class="sr-only" role="status"></p><button type="button" data-moment-dismiss aria-label="Dismiss game moment">×</button>';
    stage.appendChild(root);
  }
  const key = sportsEventStateID(moment.event) + ":" + moment.id;
  if (root.dataset.moment === key) return;
  root.dataset.moment = key;
  root.querySelector("[data-moment-action]").innerHTML = sportsMomentButton(moment);
  if (sportsMoments.lastAnnounced !== key) {
    root.querySelector('[role="status"]').textContent = sportsTeamName(moment.event.away) + " at " + sportsTeamName(moment.event.home) + ". " + moment.text;
    sportsMoments.lastAnnounced = key;
  }
}
function sportsMomentsMarkup() {
  return sportsMoments.queue.length ? '<ol class="sports-moment-list">' + sportsMoments.queue.map(moment => '<li>' + sportsMomentButton(moment) + '</li>').join("") + '</ol>' : '<p>No new moments.</p>';
}
document.addEventListener("click", event => {
  if (event.target.closest && event.target.closest("[data-moment-dismiss]")) {
    for (const moment of sportsMoments.queue) moment.received = -Infinity;
    renderSportsMomentBanner(null);
  }
});
