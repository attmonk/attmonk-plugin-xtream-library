import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const path = new URL('../internal/plugin/ui/sports_moments.js', import.meta.url);
function ledger() {
  const context = vm.createContext({document: {addEventListener() {}}, Map, Set});
  vm.runInContext((fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '') + '\nglobalThis.ledger = new SportsMomentLedger()', context);
  return context.ledger;
}
test('moments start at the first mature snapshot and deduplicate new plays and final results', () => {
  const l = ledger();
  const initial = {homeScore: '10', awayScore: '8', plays: [{id: 'old', text: 'Old score', scoring: true}]};
  assert.equal(l.ingest(initial).length, 0);
  const next = {...initial, homeScore: '12', plays: [{id: 'new', text: 'New basket', scoring: true}, ...initial.plays]};
  assert.equal(l.ingest(next)[0].text, 'New basket');
  assert.equal(l.ingest(next).length, 0);
  const final = {...next, completed: true};
  assert.equal(l.ingest(final)[0].kind, 'final');
  assert.equal(l.ingest(final).length, 0);
});
test('hidden or paused moments are absorbed without replaying them after resume', () => {
  const l = ledger();
  l.ingest({homeScore: '0', awayScore: '0'});
  const injury = {homeScore: '0', awayScore: '0', plays: [{id: 'injury', text: 'Injury timeout', injury: true}]};
  assert.equal(l.ingest(injury, false).length, 0);
  assert.equal(l.ingest(injury).length, 0);
  assert.equal(l.ingest({...injury, plays: [{id: 'next', text: 'Another injury timeout', injury: true}]} )[0].kind, 'injury');
});
test('missing scores are not fabricated and score corrections remain honest updates', () => {
  const l = ledger();
  l.ingest({});
  assert.equal(l.ingest({homeScore: '0', awayScore: '0'}).length, 0);
  assert.equal(l.ingest({homeScore: '3', awayScore: '0'})[0].text, 'Score update · 0 – 3');
  assert.equal(l.ingest({homeScore: '2', awayScore: '0'})[0].kind, 'score');
});

test('moment polling is bounded and profile changes or hiding abort and reject late results', async () => {
  let profile = 'one', now = 1000;
  const requests = [], values = {sportsMomentsEnabled: true};
  const games = Array.from({length: 8}, (_, i) => ({id: 'game-' + i, live:true, channel: {id: 'channel-' + i, score: 90}}));
  const context = vm.createContext({
    document: {hidden: false, addEventListener() {}}, Map, Set, Date, AbortController,
    state: {currentChannel: games[0].channel}, prefs: () => values,
    performance: {now: () => now}, activeViewerProfileID: () => profile,
    byId: () => null, items: v => Array.isArray(v) ? v : [],
    playerSportsEvents: () => games, sportsEventIsFollowed: () => true,
    sportsEventStateID: e => e?.id || '', sportsAssistPlaybackActive: () => true,
    playerSportsEventChannel: e => e.channel, channelByID: id => games.find(g => g.channel.id === id)?.channel,
    route: v => v, setTimeout: () => 1, clearTimeout() {}, setInterval, clearInterval,
    coreFetch: (url, options) => new Promise(resolve => requests.push({url, options, resolve})),
  });
  vm.runInContext(fs.readFileSync(new URL('../internal/plugin/ui/sports_companion.js', import.meta.url), 'utf8') + '\n' + fs.readFileSync(path, 'utf8'), context);
  const tick = () => {context.game = games[0]; vm.runInContext('updateSportsMoments(game, {at: performance.now(), data: {homeScore:"0",awayScore:"0"}})', context);};
  tick();
  assert.equal(requests.length, 3);
  profile = 'two'; now += 1000; tick();
  assert.ok(requests.slice(0, 3).every(r => r.options.signal.aborted));
  for (const r of requests.slice(0, 3)) r.resolve({ok: true, json: async () => ({available: true, homeScore: '99'})});
  await new Promise(setImmediate);
  assert.equal(vm.runInContext('sportsMoments.games.get("game-1").buffer.snapshots.length', context), 0);
  context.document.hidden = true; now += 1000; tick();
  assert.ok(requests.slice(3).every(r => r.options.signal.aborted));
  vm.runInContext('stopSportsMoments()', context);
  assert.equal(vm.runInContext('sportsMoments.games.size', context), 0);
  context.document.hidden = false;
  context.playerSportsEvents = () => games.slice(0, 2);
  values.sportsChannelDelays = {'channel-1': 30};
  vm.runInContext('renderSportsMomentBanner = function() {}', context);
  now = 100000; tick();
  requests.at(-1).resolve({ok:true,json:async()=>({available:true,live:true,updatedAtUnix:Date.now()/1000,homeScore:'10',awayScore:'8'})});
  await new Promise(setImmediate);
  now = 130001; tick();
  requests.at(-1).resolve({ok:true,json:async()=>({available:true,completed:true,updatedAtUnix:Date.now()/1000,homeScore:'10',awayScore:'8'})});
  await new Promise(setImmediate);
  context.playerSportsEvents = () => games.slice(0, 1);
  now = 160002; tick();
  assert.equal(vm.runInContext('sportsMoments.queue[0]?.kind', context), 'final', 'a followed game leaving the live schedule must still deliver its delayed final');
  vm.runInContext('stopSportsMoments()', context);
});
