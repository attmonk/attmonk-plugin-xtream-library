function sportsMultiviewPresets() {
  const result = {};
  Object.entries(prefs().sportsMultiviewPresets || {}).slice(0, 8).forEach(([id, preset]) => {
    if (!/^split-[a-z0-9-]+$/.test(id) || !preset || !preset.name || !Array.isArray(preset.channelIds)) return;
    result[id] = { name: String(preset.name).slice(0, 40), layout: preset.layout === 2 ? 2 : 4,
      channelIds: [...new Set(preset.channelIds.filter(id => typeof id === "string" && id.length <= 256))].slice(0, 4) };
  });
  return result;
}
function multiviewSourceAllows(channel, selected) {
  const source = String(channel.sourceId || "");
  const limits = state.app && state.app.sourceMultiviewLimits || {};
  if (!Object.prototype.hasOwnProperty.call(limits, source)) return true;
  const limit = Math.max(0, Math.min(4, Number(limits[source]) || 0));
  return selected.filter(item => String(item.sourceId || "") === source).length < limit;
}
function openSportsMultiview(ids, layout) {
  const requestedLayout = layout === 2 ? 2 : 4;
  const previousLayout = prefs().sportsMultiviewLayout;
  prefs().sportsMultiviewLayout = requestedLayout;
  const selected = [], limit = multiviewConnectionLimit();
  items(ids).slice(0, 32).forEach(id => {
    const channel = channelByID(String(id));
    if (selected.length >= limit || !channel || selected.some(item => item.id === channel.id) || !multiviewSourceAllows(channel, selected)) return;
    selected.push(channel);
  });
  if (!selected.length) {
    prefs().sportsMultiviewLayout = previousLayout;
    showAppToast("These channels are unavailable. Choose another split."); return;
  }
  if (state.view === "player") { stopPlayback(); stopCurrentWatch("open_sports_split"); }
  if (items(state.multiviewTiles).length) stopAllMultiview("replace_sports_split");
  state.multiviewTiles = selected.map(channel => ({id: multiviewTileKey(channel.id), channelID: channel.id, channel,
    videoID: multiviewTileKey("video-" + channel.id), hls: null, tsPlayer: null, session: null, attached: false}));
  state.multiviewActiveTileID = state.multiviewTiles[0].id;
  state.view = "multiview";
  savePrefs(true); render();
  if (selected.length < new Set(ids).size) showAppToast("Opened available channels within this layout and connection limits.");
}
function sportsMultiviewPicks() {
  const payload = state.sports;
  if (!payload || payload.error || payload.incomplete || payload.refreshing || (Date.now() / 1000 - Number(payload.updatedAtUnix || 0) > 180 || Date.now() / 1000 - Number(payload.updatedAtUnix || 0) < -30)) return [];
  const hidden = prefs().sportsSpoilersHidden || prefs().sportsPlayerSpoilersHidden || sportsCompanionDelay() > 0;
  const selected = [];
  return items(payload.events).filter(event => event.live && !event.completed).map(event => {
    const channel = playerSportsEventChannel(event);
    return { event, channel: channel && Number(channel.score) >= 60 && channelByID(channel.id),
      priority: (sportsEventIsFollowed(event) ? 100 : 0) + (!hidden ? Math.max(0, Math.min(10, Number((event.ranking || {}).score) || 0)) : 0) };
  }).filter(row => row.channel).sort((a, b) => b.priority - a.priority || String(a.channel.id).localeCompare(String(b.channel.id))).filter(row => {
    if (selected.some(channel => channel.id === row.channel.id) || !multiviewSourceAllows(row.channel, selected)) return false;
    selected.push(row.channel); return true;
  });
}
function renderSportsSplitSuggestion() {
  const picks = sportsMultiviewPicks();
  const current = String((state.currentChannel || {}).id || "");
  return picks.some(pick => pick.channel.id === current) && picks.some(pick => pick.channel.id !== current && pick.priority >= 7) && multiviewConnectionLimit() >= 2
    ? '<button type="button" class="chip" data-sports-split>Watch a Sports split</button>' : "";
}
function saveSportsMultiviewPreset(name) {
  name = String(name || "").trim().slice(0, 40);
  const channelIds = items(state.multiviewTiles).map(tile => String((tile.channel || {}).id || "")).filter(Boolean).slice(0, 4);
  if (!name || !channelIds.length) return false;
  const presets = sportsMultiviewPresets();
  const existing = Object.keys(presets).find(id => presets[id].name === name);
  if (!existing && Object.keys(presets).length >= 8) { showAppToast("Remove a saved split before adding another."); return false; }
  const id = existing || "split-" + Date.now().toString(36);
  presets[id] = {name, channelIds, layout: prefs().sportsMultiviewLayout === 2 ? 2 : 4};
  prefs().sportsMultiviewPresets = presets; savePrefs(true); return true;
}
function sportsMultiviewControls() {
  const presets = sportsMultiviewPresets();
  return '<section id="sports-split-controls" class="sports-split-controls" aria-label="Multiview layouts"><div><label>Layout <select data-sports-split-layout><option value="2"' + (prefs().sportsMultiviewLayout === 2 ? ' selected' : '') + '>2 channels</option><option value="4"' + (prefs().sportsMultiviewLayout !== 2 ? ' selected' : '') + '>4 channels</option></select></label>' +
    (sportsMultiviewPicks().length >= 2 ? '<button type="button" data-sports-split>Suggested Sports split</button>' : '') + '</div>' +
    '<div class="sports-saved-splits">' + Object.entries(presets).map(([id, preset]) => '<span><button type="button" data-sports-split-load="' + id + '">' + escapeHTML(preset.name) + '</button><button type="button" data-sports-split-remove="' + id + '" aria-label="' + escapeHTML("Remove " + preset.name) + '">×</button></span>').join("") + '</div>' +
    (items(state.multiviewTiles).length ? '<form id="sports-save-split"><label>Save split <input name="splitName" required maxlength="40" placeholder="Split name" autocomplete="off"></label><button type="submit">Save</button></form>' : '') + '</section>';
}
function refreshSportsSplitControls() {
  const root = byId("sports-split-controls");
  if (root) root.outerHTML = sportsMultiviewControls();
}
document.addEventListener("change", event => {
  if (!event.target.matches("[data-sports-split-layout]")) return;
  const layout = Number(event.target.value) === 2 ? 2 : 4;
  if (items(state.multiviewTiles).length > layout) {
    event.target.value = String(prefs().sportsMultiviewLayout === 2 ? 2 : 4);
    showAppToast("Remove channels before selecting a smaller layout."); return;
  }
  prefs().sportsMultiviewLayout = layout; savePrefs(true);
  const grid = document.querySelector(".multiview-grid");
  if (grid) grid.dataset.layout = String(layout);
  // Changing the layout does not restart any video or watch session.
  const picker = byId("multiview-picker");
  if (picker) picker.hidden = items(state.multiviewTiles).length >= multiviewConnectionLimit();
});
document.addEventListener("submit", event => {
  if (event.target.id !== "sports-save-split") return;
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  if (saveSportsMultiviewPreset(new FormData(event.target).get("splitName"))) {
    showAppToast("Split saved."); refreshSportsSplitControls();
    const input = document.querySelector('#sports-save-split input'); if (input) input.focus();
  }
});
document.addEventListener("click", event => {
  const button = event.target.closest("[data-sports-split], [data-sports-split-load], [data-sports-split-remove]");
  if (!button) return;
  if (button.hasAttribute("data-sports-split-remove")) {
    const presets = sportsMultiviewPresets(); delete presets[button.dataset.sportsSplitRemove];
    prefs().sportsMultiviewPresets = presets; savePrefs(true); refreshSportsSplitControls(); return;
  }
  if (button.hasAttribute("data-sports-split-load")) {
    const preset = sportsMultiviewPresets()[button.dataset.sportsSplitLoad];
    if (preset) openSportsMultiview(preset.channelIds, preset.layout); return;
  }
  const picks = sportsMultiviewPicks(), current = state.view === "player" && state.currentChannel;
  openSportsMultiview((current ? [current.id] : []).concat(picks.map(pick => pick.channel.id)), current ? 2 : (prefs().sportsMultiviewLayout === 2 ? 2 : 4));
});
