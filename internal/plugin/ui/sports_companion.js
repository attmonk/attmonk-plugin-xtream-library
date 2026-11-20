// Shared with Xtream. A snapshot's receipt time, never the upstream clock,
// determines when it may be shown. Keep enough history for the maximum delay.
class SportsCompanionBuffer {
  constructor() {
    this.game = "";
    this.snapshots = [];
  }
  push(game, data, now) {
    if (game !== this.game) {
      this.game = game;
      this.snapshots = [];
    }
    this.snapshots.push({ data: data, at: now });
    this.snapshots = this.snapshots
      .filter((x) => now - x.at <= 360000)
      .slice(-32);
  }
  read(game, seconds, now) {
    if (game !== this.game) return null;
    return (
      this.snapshots.filter((x) => x.at <= now - seconds * 1000).slice(-1)[0] ||
      null
    );
  }
  calibrate(period, clock, now) {
    const target = sportsClockSeconds(clock);
    if (!Number.isInteger(Number(period)) || Number(period) < 1 || target === null)
      return {error: "Enter a period and a clock such as 8:42."};
    const rows = this.snapshots;
    for (let i = 1; i < rows.length; i++) {
      const before = rows[i - 1], after = rows[i];
      if (Number(before.data.period) !== Number(period) || Number(after.data.period) !== Number(period)) continue;
      const a = sportsClockSeconds(before.data.clock), b = sportsClockSeconds(after.data.clock);
      if (a === null || b === null || a === b || Math.abs(a - b) > 90) continue;
      if (target < Math.min(a, b) || target > Math.max(a, b) || target === a) continue;
      // Use the observation BEFORE the entered clock. Interpolating game time
      // through stoppages could show a score before it reaches the video.
      const delay = Math.ceil((now - before.at) / 1000);
      if (delay < 0 || delay > 300) return {error: "That clock is outside the five-minute delay window."};
      return {delay};
    }
    return {error: "That clock is not in the recent feed yet. Keep the game playing, then try again."};
  }
}
function sportsClockSeconds(value) {
  const text = String(value ?? "").trim();
  const match = /^(?:(\d{1,3}):)?(\d{1,2}(?:\.\d)?)$/.exec(text);
  if (!match || Number(match[2]) >= 60) return null;
  return Number(match[1] || 0) * 60 + Number(match[2]);
}
const sportsCompanion = {
  buffer: new SportsCompanionBuffer(),
  timer: null,
  abort: null,
  generation: 0,
  event: null,
  lastFetch: -Infinity,
  pending: false,
  tab: "box",
  team: "all",
  stale: false,
  viewer: "",
};
function sportsCompanionDelay(channelID) {
  const settings = prefs();
  const id = channelID === undefined
    ? String((state.currentChannel && state.currentChannel.id) || "")
    : String(channelID || "");
  const delays = settings.sportsChannelDelays || {};
  const fallback = Math.max(0, Math.min(300, Number(settings.sportsStatsDelaySeconds) || 0));
  const value = Object.prototype.hasOwnProperty.call(delays, id) ? delays[id] : null;
  return value !== null && value !== "" && Number.isFinite(Number(value))
    ? Math.max(0, Math.min(300, Math.round(Number(value)))) : fallback;
}
function sportsCompanionViewer() {
  if (typeof activeViewerProfileID === "function") return activeViewerProfileID();
  return typeof coreStoredValue === "function" ? coreStoredValue("profile_id") : "";
}
function sportsCompanionCurrent() {
  const events = playerSportsEvents();
  const current = events.find(
      (event) =>
        state.currentChannel &&
        playerSportsChannelMatches(event, state.currentChannel.id),
    );
  // Keep the current game's mature ending after it leaves the live schedule.
  const previous = sportsCompanion.event;
  return current || (previous && sportsCompanion.viewer === sportsCompanionViewer() && state.currentChannel && playerSportsChannelMatches(previous, state.currentChannel.id) ? previous : null);
}
function startSportsCompanion() {
  stopSportsCompanion();
  sportsCompanion.event = null;
  sportsCompanion.buffer = new SportsCompanionBuffer();
  if (!sportsFirstPlayerActive()) return;
  const generation = sportsCompanion.generation;
  function tick() {
    if (state.view !== "player" || !byId("player-sports-drawer")) {
      stopSportsCompanion();
      return;
    }
    if (typeof sportsAssistTick === "function") sportsAssistTick();
    if (document.hidden) return;
    const event = sportsCompanionCurrent();
    const id = sportsEventStateID(event);
    const viewer = sportsCompanionViewer();
    if (id !== sportsEventStateID(sportsCompanion.event) || viewer !== sportsCompanion.viewer) {
      sportsCompanion.viewer = viewer;
      if (sportsCompanion.abort) sportsCompanion.abort.abort();
      sportsCompanion.event = event;
      sportsCompanion.buffer = new SportsCompanionBuffer();
      sportsCompanion.lastFetch = -Infinity;
      sportsCompanion.pending = false;
      sportsCompanion.stale = false;
    }
    renderSportsCompanion();
    if (
      !id ||
      sportsCompanion.pending ||
      performance.now() - sportsCompanion.lastFetch < 30000
    )
      return;
    sportsCompanion.pending = true;
    sportsCompanion.lastFetch = performance.now();
    const abort = new AbortController();
    sportsCompanion.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 12000);
    coreFetch(
      route("/dispatcharr/api/sports?game_stats=" + encodeURIComponent(id)),
      { signal: abort.signal, credentials: "same-origin" },
    )
      .then((r) => {
        if (!r.ok) throw new Error("Stats unavailable");
        return r.json();
      })
      .then((data) => {
        if (
          generation !== sportsCompanion.generation ||
          viewer !== sportsCompanionViewer() ||
          id !== sportsEventStateID(sportsCompanion.event) ||
          abort.signal.aborted
        )
          return;
        if (
          data.available ||
          (data.homeScore !== undefined &&
            data.homeScore !== "" &&
            data.awayScore !== undefined &&
            data.awayScore !== "")
        ) {
          sportsCompanion.buffer.push(id, data, performance.now());
          sportsCompanion.stale = false;
        } else sportsCompanion.stale = true;
      })
      .catch(() => {
        if (
          generation === sportsCompanion.generation &&
          sportsCompanion.abort === abort &&
          id === sportsEventStateID(sportsCompanion.event)
        )
          sportsCompanion.stale = true;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (sportsCompanion.abort === abort) {
          sportsCompanion.pending = false;
          sportsCompanion.abort = null;
          renderSportsCompanion();
        }
      });
  }
  tick();
  sportsCompanion.timer = setInterval(tick, 1000);
}
function stopSportsCompanion() {
  if (typeof stopSportsMoments === "function") stopSportsMoments();
  const clockDialog = byId("sports-clock-dialog");
  if (clockDialog && typeof clockDialog.close === "function") clockDialog.close();
  if (typeof stopSportsAssist === "function") stopSportsAssist();
  sportsCompanion.generation++;
  if (sportsCompanion.timer) clearInterval(sportsCompanion.timer);
  if (sportsCompanion.abort) sportsCompanion.abort.abort();
  sportsCompanion.timer = null;
  sportsCompanion.abort = null;
  sportsCompanion.pending = false;
  sportsCompanion.stale = false;
  sportsCompanion.event = null;
  sportsCompanion.buffer = new SportsCompanionBuffer();
  const overlay = byId("sports-score-overlay");
  if (overlay) overlay.remove();
  const panel = byId("sports-companion-panel");
  if (panel) panel.remove();
}
function sportsCompanionMarkup(event, sample) {
  const esc = escapeHTML;
  const delay = sportsCompanionDelay();
  const hidden = !!(
    prefs().sportsSpoilersHidden || prefs().sportsPlayerSpoilersHidden
  );
  const channelID = String((state.currentChannel && state.currentChannel.id) || "");
  const override = !!channelID && Object.prototype.hasOwnProperty.call(prefs().sportsChannelDelays || {}, channelID);
  const defaultDelay = sportsCompanionDelay(null);
  const choices = [0, 30, 60, 90, 120, 180, 300];
  if (!choices.includes(delay)) choices.push(delay);
  let html = '<section class="sports-companion" aria-label="Game companion"><div class="companion-toolbar"><strong>Game companion</strong><label>' +
    (channelID ? "Channel delay" : "Delay") +
    ' <select data-companion-delay aria-label="Delay game statistics">' +
    (channelID ? '<option value="default"' + (!override ? " selected" : "") + '>Profile default (' + defaultDelay + 's)</option>' : "") +
    choices.sort((a, b) => a - b).map(n => '<option value="' + n + '"' +
      ((channelID ? override : true) && delay === n ? " selected" : "") + '>' +
      (n ? n + "s" : "Live") + '</option>').join("") + '</select></label>' +
    (event && sportsCompanion.buffer.snapshots.some(row => sportsClockSeconds(row.data.clock) !== null)
      ? '<button type="button" class="chip" data-companion-clock>Sync clock</button>' : '') + '</div>';
  if (typeof renderSportsAssistControls === "function") html += renderSportsAssistControls();
  if (typeof renderSportsSplitSuggestion === "function") html += renderSportsSplitSuggestion();
  if (typeof sportsMomentsMarkup === "function") html += '<label class="companion-moments-toggle" for="sports-moments-enabled"><input id="sports-moments-enabled" type="checkbox" data-companion-moments' + (prefs().sportsMomentsEnabled ? ' checked' : '') + '>Game moments</label>';
  if (!event)
    return (
      html + "<p>No game has a confident match to this channel.</p></section>"
    );
  html +=
    '<p class="companion-match">' +
    esc(sportsTeamName(event.away)) +
    " at " +
    esc(sportsTeamName(event.home)) +
    "</p>";
  if (hidden)
    return (
      html +
      "<p>Scores and statistics are hidden. Use the scores control to show them.</p></section>"
    );
  if (!sample)
    return (
      html +
      '<p role="status">' +
      (sportsCompanion.stale
        ? "Game statistics are unavailable. Retrying shortly."
        : delay
          ? "Building a " + delay + "s delay…"
          : "Waiting for game statistics…") +
      "</p></section>"
    );
  const data = sample.data;
  html +=
    '<p class="companion-freshness">' +
    esc(data.statusText || "") +
    (sportsCompanion.stale ||
    performance.now() - sample.at > (delay + 75) * 1000
      ? " · Updates delayed"
      : "") +
    "</p>";
  html +=
    '<div class="companion-tabs" aria-label="Game detail view">' +
    [
      ["box", "Box score"],
      ["stats", "Statistics"],
      ["plays", "Play-by-play"],
      ...(prefs().sportsMomentsEnabled ? [["moments", "Moments"]] : []),
    ]
      .map(
        (pair) =>
          '<button type="button" data-companion-tab="' +
          pair[0] +
          '" aria-pressed="' +
          (sportsCompanion.tab === pair[0]) +
          '">' +
          pair[1] +
          "</button>",
      )
      .join("") +
    "</div>";
  if (sportsCompanion.tab === "moments" && typeof sportsMomentsMarkup === "function") return html + sportsMomentsMarkup() + "</section>";
  if (sportsCompanion.tab !== "plays")
    html +=
      '<div class="companion-teams" aria-label="Filter teams">' +
      [
        ["all", "Both teams"],
        ["away", sportsTeamName(event.away)],
        ["home", sportsTeamName(event.home)],
      ]
        .map(
          (pair) =>
            '<button type="button" data-companion-team="' +
            pair[0] +
            '" aria-pressed="' +
            (sportsCompanion.team === pair[0]) +
            '">' +
            esc(pair[1]) +
            "</button>",
        )
        .join("") +
      "</div>";
  if (sportsCompanion.tab === "box") {
    const following = typeof sportsFavoritePlayers === "function" ? sportsFavoritePlayers() : {};
    const groups = items(data.boxScores).filter(
      (g) => sportsCompanion.team === "all" || g.side === sportsCompanion.team,
    );
    html += groups
      .map(
        (g) =>
          "<h3>" +
          esc(sportsTeamName(event[g.side])) +
          " · " +
          esc(g.category || "Players") +
          '</h3><div class="companion-table-wrap" tabindex="0" role="region" aria-label="' +
          esc(sportsTeamName(event[g.side]) + " player statistics") +
          '"><table><thead><tr><th scope="col">Player</th>' +
          items(g.columns)
            .map((c) => '<th scope="col">' + esc(c) + "</th>")
            .join("") +
          "</tr></thead><tbody>" +
          items(g.players)
            .map(
              (p) =>
                '<tr' + (p.id && following[p.id] ? ' class="followed-player"' : '') + '><th scope="row">' +
                esc(p.name) +
                (typeof sportsPlayerFollowButton === "function" ? sportsPlayerFollowButton(p, event, g.side, data.updatedAtUnix, following) : "") +
                "<small>" +
                esc(
                  [p.jersey, p.position, p.starter ? "Starter" : ""]
                    .filter(Boolean)
                    .join(" · "),
                ) +
                "</small></th>" +
                (p.didNotPlay
                  ? '<td colspan="' + g.columns.length + '">Did not play</td>'
                  : items(p.stats)
                      .map((v) => "<td>" + esc(v) + "</td>")
                      .join("")) +
                "</tr>",
            )
            .join("") +
          "</tbody></table></div>",
      )
      .join("");
    if (!groups.length) html += "<p>No player box score is available yet.</p>";
  } else if (sportsCompanion.tab === "stats") {
    html +=
      '<div class="companion-table-wrap" tabindex="0" role="region" aria-label="Team statistics"><table><thead><tr><th scope="col">Statistic</th>' +
      ["away", "home"]
        .filter(
          (side) =>
            sportsCompanion.team === "all" || sportsCompanion.team === side,
        )
        .map(
          (side) =>
            '<th scope="col">' + esc(sportsTeamName(event[side])) + "</th>",
        )
        .join("") +
      "</tr></thead><tbody>" +
      items(data.rows)
        .map(
          (row) =>
            '<tr><th scope="row">' +
            esc(row.label) +
            "</th>" +
            ["away", "home"]
              .filter(
                (side) =>
                  sportsCompanion.team === "all" ||
                  sportsCompanion.team === side,
              )
              .map((side) => "<td>" + esc(row[side]) + "</td>")
              .join("") +
            "</tr>",
        )
        .join("") +
      "</tbody></table></div>";
    html +=
      '<div class="companion-leaders">' +
      items(data.leaders)
        .filter(
          (p) =>
            sportsCompanion.team === "all" || p.side === sportsCompanion.team,
        )
        .map(
          (p) =>
            "<article><small>" +
            esc(p.label) +
            "</small><strong>" +
            esc(p.name) +
            "</strong><span>" +
            esc(p.value) +
            "</span></article>",
        )
        .join("") +
      "</div>";
    if (!items(data.rows).length && !items(data.leaders).length)
      html += "<p>No team statistics are available yet.</p>";
  } else {
    html +=
      '<ol class="companion-plays">' +
      items(data.plays)
        .map(
          (p) =>
            "<li><small>" +
            esc([p.period, p.clock].filter(Boolean).join(" · ")) +
            "</small><p>" +
            esc(p.text) +
            "</p></li>",
        )
        .join("") +
      "</ol>";
    if (!items(data.plays).length)
      html += "<p>No recent plays are available yet.</p>";
  }
  return html + "</section>";
}
function renderSportsCompanion() {
  if (state.view !== "player") return;
  const drawer = byId("player-sports-drawer");
  if (!drawer) return;
  const event = sportsCompanion.event;
  const sample = sportsCompanion.viewer === sportsCompanionViewer() ? sportsCompanion.buffer.read(
    sportsEventStateID(event),
    sportsCompanionDelay(),
    performance.now(),
  ) : null;
  if (typeof updateSportsMoments === "function") updateSportsMoments(event, sample);
  if (sample && typeof observeSportsPlayers === "function") observeSportsPlayers(event, sample.data);
  let overlay = byId("sports-score-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sports-score-overlay";
    overlay.className = "sports-score-overlay";
    document.querySelector(".playback-stage").appendChild(overlay);
  }
  const hidden =
    prefs().sportsSpoilersHidden || prefs().sportsPlayerSpoilersHidden;
  overlay.hidden = !event;
  const accessibleScore = event
    ? ["away", "home"]
        .map(
          (side) =>
            sportsTeamName(event[side]) +
            " " +
            (hidden || !sample
              ? "score withheld"
              : sample.data[side + "Score"] || "score unavailable"),
        )
        .join(", ") +
      ". " +
      (hidden
        ? "Scores hidden"
        : sample
          ? sample.data.statusText || ""
          : sportsCompanionDelay()
            ? "Delay warming up"
            : "Waiting for stats") +
      ". Open game companion"
    : "";
  const score = event
    ? '<button type="button" data-player-action="sports" aria-label="' +
      escapeHTML(accessibleScore) +
      '">' +
      ["away", "home"]
        .map(
          (side) =>
            "<span>" +
            renderSportsTeamLogo(event[side], "companion-team-logo") +
            escCompanionTeam(event[side]) +
            "<b>" +
            escapeHTML(
              hidden || !sample ? "—" : sample.data[side + "Score"] || "—",
            ) +
            "</b></span>",
        )
        .join("") +
      "<small>" +
      escapeHTML(
        hidden
          ? "Scores hidden"
          : sample
            ? sample.data.statusText || ""
            : sportsCompanionDelay()
              ? "Delay warming up"
              : "Waiting for stats",
      ) +
      "</small></button>"
    : "";
  if (overlay.innerHTML !== score) overlay.innerHTML = score;
  if (!state.playerSportsOpen) return;
  let root = byId("sports-companion-panel");
  if (!root) {
    root = document.createElement("div");
    root.id = "sports-companion-panel";
    const body = drawer.querySelector(".player-sports-body") || drawer;
    body.prepend(root);
  }
  const markup = sportsCompanionMarkup(event, sample);
  if (root.companionMarkup !== markup) {
    const active = root.contains(document.activeElement)
      ? document.activeElement
      : null;
    const selector =
      active && active.dataset.sportsPlayerFollow
        ? '[data-sports-player-follow="' + active.dataset.sportsPlayerFollow + '"]'
        : active && active.matches("[data-companion-moments]")
        ? "[data-companion-moments]"
        : active && active.matches("[data-companion-delay]")
        ? "[data-companion-delay]"
        : active && active.dataset.companionTab
          ? '[data-companion-tab="' + active.dataset.companionTab + '"]'
          : active && active.dataset.companionTeam
            ? '[data-companion-team="' + active.dataset.companionTeam + '"]'
            : active && active.hasAttribute("data-companion-clock")
              ? "[data-companion-clock]" : "";
    if (active && active.tagName === "SELECT") return;
    root.innerHTML = markup;
    root.companionMarkup = markup;
    if (selector && root.querySelector(selector))
      root.querySelector(selector).focus({ preventScroll: true });
  }
}
function escCompanionTeam(team) {
  return (
    "<span>" +
    escapeHTML((team && (team.abbreviation || team.name)) || "Team") +
    "</span>"
  );
}
document.addEventListener("click", function (event) {
  if (event.target.closest && event.target.closest("[data-companion-clock]")) {
    openSportsClockCalibration();
    return;
  }
  const button =
    event.target.closest &&
    event.target.closest("[data-companion-tab], [data-companion-team]");
  if (!button) return;
  if (button.hasAttribute("data-companion-tab"))
    sportsCompanion.tab = button.dataset.companionTab;
  if (button.hasAttribute("data-companion-team"))
    sportsCompanion.team = button.dataset.companionTeam;
  const root = byId("sports-companion-panel");
  if (root) {
    root.innerHTML = sportsCompanionMarkup(
      sportsCompanion.event,
      sportsCompanion.buffer.read(
        sportsEventStateID(sportsCompanion.event),
        sportsCompanionDelay(),
        performance.now(),
      ),
    );
    root
      .querySelector(
        "[data-companion-" +
          (button.hasAttribute("data-companion-tab")
            ? 'tab="' + sportsCompanion.tab
            : 'team="' + sportsCompanion.team) +
          '"]',
      )
      .focus();
  }
});
document.addEventListener("change", function (event) {
  if (event.target.matches("[data-companion-moments]")) {
    prefs().sportsMomentsEnabled = event.target.checked;
    if (typeof stopSportsMoments === "function") stopSportsMoments();
    if (!event.target.checked && sportsCompanion.tab === "moments") sportsCompanion.tab = "box";
    savePrefs(); renderSportsCompanion(); return;
  }
  if (!event.target.matches("[data-companion-delay]")) return;
  const id = String((state.currentChannel && state.currentChannel.id) || "");
  if (id && id !== "__proto__" && id !== "constructor" && id !== "prototype") {
    const delays = Object.assign({}, prefs().sportsChannelDelays || {});
    if (event.target.value === "default") delete delays[id];
    else if (Number.isFinite(Number(event.target.value))) delays[id] = Math.max(0, Math.min(300, Math.round(Number(event.target.value))));
    const edited = Object.prototype.hasOwnProperty.call(delays, id);
    const retained = Object.entries(delays).filter(([key]) => key !== id).slice(edited ? -255 : -256);
    if (edited) retained.push([id, delays[id]]);
    prefs().sportsChannelDelays = Object.fromEntries(retained);
  } else if (Number.isFinite(Number(event.target.value))) {
    prefs().sportsStatsDelaySeconds = Math.max(0, Math.min(300, Number(event.target.value)));
  }
  savePrefs();
  renderPlayerSportsDrawer();
  renderSportsCompanion();
});

function openSportsClockCalibration() {
  if (byId("sports-clock-dialog")) return;
  const channel = String((state.currentChannel && state.currentChannel.id) || "");
  const game = sportsEventStateID(sportsCompanion.event), viewer = sportsCompanionViewer();
  if (!channel || !game) return;
  const dialog = document.createElement("dialog");
  dialog.id = "sports-clock-dialog";
  dialog.className = "sports-practice-dialog sports-clock-dialog";
  dialog.setAttribute("aria-labelledby", "sports-clock-title");
  dialog.innerHTML = '<h2 id="sports-clock-title">Sync game clock</h2><p>Enter the period and clock shown on your video. Recent feed observations set this channel’s delay.</p>' +
    '<form class="sports-clock-form" aria-labelledby="sports-clock-title" method="dialog">' +
    '<label for="sports-clock-period">Period</label><input id="sports-clock-period" name="period" type="number" min="1" max="20" step="1" required autofocus>' +
    '<label for="sports-clock-time">Clock (minutes:seconds)</label><input id="sports-clock-time" name="clock" type="text" maxlength="9" placeholder="8:42" required autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">' +
    '<p id="sports-clock-error" role="status" tabindex="-1"></p><div class="sports-practice-actions"><button type="button" data-clock-cancel>Cancel</button><button type="submit">Sync clock</button></div></form>';
  const form = dialog.querySelector("form"), error = dialog.querySelector("#sports-clock-error");
  form.querySelectorAll("input").forEach(input => input.setAttribute("aria-invalid", "false"));
  form.addEventListener("invalid", event => event.target.setAttribute("aria-invalid", "true"), true);
  form.addEventListener("input", event => {
    if (event.target.validity.valid) event.target.setAttribute("aria-invalid", "false");
    error.textContent = "";
  });
  dialog.querySelector("[data-clock-cancel]").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", event => {
    event.preventDefault();
    let result;
    if (channel !== String((state.currentChannel && state.currentChannel.id) || "") || game !== sportsEventStateID(sportsCompanion.event) || viewer !== sportsCompanionViewer()) {
      result = {error: "The game or profile changed. Open Sync clock again."};
    } else {
      result = sportsCompanion.buffer.calibrate(form.elements.period.value, form.elements.clock.value, performance.now());
    }
    if (result.error) { error.textContent = result.error; error.focus(); return; }
    const delays = Object.entries(prefs().sportsChannelDelays || {}).filter(([key]) => key !== channel).slice(-255);
    if (["__proto__", "constructor", "prototype"].includes(channel)) return;
    prefs().sportsChannelDelays = Object.fromEntries(delays.concat([[channel, result.delay]]));
    savePrefs();
    dialog.close();
    renderPlayerSportsDrawer();
    renderSportsCompanion();
  });
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.appendChild(dialog);
  dialog.showModal();
}
