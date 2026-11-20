// Player identities come from the provider, never from display-name matching.
function sportsFavoritePlayers() {
  const result = {};
  Object.entries(prefs().sportsFavoritePlayers || {}).slice(0, 200).forEach(([id, player]) => {
    if (!/^espn:[a-z0-9/.-]+:[0-9]+$/.test(id) || !player || typeof player !== "object" || !player.name || !player.leagueId) return;
    result[id] = { name: String(player.name).slice(0, 120), leagueId: String(player.leagueId).slice(0, 80),
      teamSlug: String(player.teamSlug || "").slice(0, 120), teamName: String(player.teamName || "").slice(0, 120),
      observedAtUnix: Math.max(0, Math.min(Date.now() / 1000, Number(player.observedAtUnix) || 0)) };
  });
  return result;
}
function setSportsPlayerFollow(id, player) {
  if (!/^espn:[a-z0-9/.-]+:[0-9]+$/.test(id)) return false;
  const followed = sportsFavoritePlayers();
  if (player === null) delete followed[id];
  else {
    if (!player || !player.name || !player.leagueId || (!followed[id] && Object.keys(followed).length >= 200)) return false;
    followed[id] = player;
  }
  prefs().sportsFavoritePlayers = followed;
  prefs().sportsFavoritePlayers = sportsFavoritePlayers();
  savePrefs(true);
  return true;
}
function sportsFollowedPlayerCount(event) {
  if (!event) return 0;
  const teams = [event.home, event.away].filter(Boolean).map(team => sportsGamePassSlug(sportsTeamName(team)));
  return Object.values(sportsFavoritePlayers()).filter(player => player.leagueId === event.leagueId && player.observedAtUnix >= Date.now() / 1000 - 86400 && teams.includes(player.teamSlug)).length;
}
function sportsPlayerFollowButton(player, event, side, observedAtUnix, following) {
  if (!player.id) return "";
  const followed = !!(following || sportsFavoritePlayers())[player.id];
  const team = event[side] || {};
  return '<button type="button" class="sports-player-follow" data-sports-player-follow="' + escapeHTML(player.id) + '" data-player-name="' + escapeHTML(player.name) + '" data-player-league="' + escapeHTML(event.leagueId) + '" data-player-team="' + escapeHTML(sportsTeamName(team)) + '" data-player-observed="' + escapeHTML(String(Number(observedAtUnix) || 0)) + '" aria-pressed="' + followed + '" aria-label="' + escapeHTML((followed ? "Unfollow " : "Follow ") + player.name) + '">' + (followed ? "Following" : "Follow") + '</button>';
}
function observeSportsPlayers(event, data) {
  if (!event || !data || !data.live) return;
  const observedAt = Number(data.updatedAtUnix) || 0;
  if (observedAt <= 0 || Date.now() / 1000 - observedAt > 375 || observedAt > Date.now() / 1000 + 10) return;
  const followed = sportsFavoritePlayers();
  let changed = false;
  (data.boxScores || []).forEach(group => (group.players || []).forEach(player => {
    const saved = followed[player.id], teamName = sportsTeamName(event[group.side] || {});
    if (!saved || saved.leagueId !== event.leagueId || !teamName) return;
    const teamSlug = sportsGamePassSlug(teamName), now = observedAt;
    if (saved.teamSlug === teamSlug && now - saved.observedAtUnix < 1800) return;
    followed[player.id] = Object.assign({}, saved, { teamName, teamSlug, observedAtUnix: now });
    changed = true;
  }));
  if (changed) { prefs().sportsFavoritePlayers = followed; savePrefs(true); }
}
function renderSportsFollowedPlayers() {
  const players = Object.entries(sportsFavoritePlayers());
  if (!players.length) return "";
  return '<section class="sports-followed-players"><h2>Players</h2><ul>' + players.map(([id, player]) => '<li><span><strong>' + escapeHTML(player.name) + '</strong><small>' + escapeHTML(player.teamName ? "Last seen · " + player.teamName : player.leagueId.toUpperCase()) + '</small></span><button type="button" data-sports-player-remove="' + escapeHTML(id) + '" aria-label="' + escapeHTML("Unfollow " + player.name) + '">Unfollow</button></li>').join("") + '</ul></section>';
}
document.addEventListener("click", function(event) {
  const button = event.target.closest("[data-sports-player-follow], [data-sports-player-remove]");
  if (!button) return;
  const id = button.dataset.sportsPlayerFollow || button.dataset.sportsPlayerRemove;
  const remove = !!button.dataset.sportsPlayerRemove || !!sportsFavoritePlayers()[id];
  setSportsPlayerFollow(id, remove ? null : { name: button.dataset.playerName, leagueId: button.dataset.playerLeague,
    teamName: button.dataset.playerTeam, teamSlug: sportsGamePassSlug(button.dataset.playerTeam), observedAtUnix: Number(button.dataset.playerObserved) || 0 });
  if (state.view === "player") renderSportsCompanion();
  else if (typeof render === "function") render();
});
