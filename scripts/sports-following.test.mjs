import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const path = new URL('../internal/plugin/ui/sports_following.js', import.meta.url);
function setup() {
  const values = {sportsFavoritePlayers: {}}, handlers = {}; let saves = 0;
  const context = vm.createContext({document: {addEventListener: (kind, fn) => {handlers[kind] = fn;}}, Date,
    prefs: () => values, savePrefs: () => saves++, sportsGamePassSlug: x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    sportsTeamName: x => x?.name || '', state: {view: 'player'}, renderSportsCompanion() {}, escapeHTML: String,
  });
  vm.runInContext(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '', context);
  const run = code => vm.runInContext(code, context);
  return {values, run, context, saves: () => saves};
}
test('player follows keep provider identities separate and reject malformed preference records', () => {
  const h = setup();
  h.run('setSportsPlayerFollow("espn:basketball/nba:11", {name:"Same Name", leagueId:"nba", teamSlug:"new-york-knicks", teamName:"New York Knicks", observedAtUnix:Date.now()/1000})');
  h.run('setSportsPlayerFollow("espn:football/nfl:11", {name:"Same Name", leagueId:"nfl", teamSlug:"new-york-giants", teamName:"New York Giants", observedAtUnix:Date.now()/1000})');
  assert.equal(Object.keys(h.values.sportsFavoritePlayers).length, 2);
  assert.equal(h.run('setSportsPlayerFollow("__proto__", {name:"Bad"})'), false);
  h.run('setSportsPlayerFollow("espn:basketball/nba:11", null)');
  assert.deepEqual(Object.keys(h.values.sportsFavoritePlayers), ['espn:football/nfl:11']);
});
test('player game suggestions use recent observed teams in the same league', () => {
  const h = setup();
  const now = Date.now()/1000;
  h.values.sportsFavoritePlayers = {'espn:basketball/nba:11': {name: 'Player', leagueId: 'nba', teamSlug: 'new-york-knicks', teamName: 'New York Knicks', observedAtUnix: now}};
  h.context.game = {leagueId: 'nba', home: {name: 'New York Knicks'}, away: {name: 'Boston Celtics'}};
  assert.equal(h.run('sportsFollowedPlayerCount(game)'), 1);
  h.context.game.leagueId = 'wnba';
  assert.equal(h.run('sportsFollowedPlayerCount(game)'), 0);
  h.context.game.leagueId = 'nba'; h.values.sportsFavoritePlayers['espn:basketball/nba:11'].observedAtUnix = now - 86401;
  assert.equal(h.run('sportsFollowedPlayerCount(game)'), 0, 'an old team association must not guess a player’s roster');
});
