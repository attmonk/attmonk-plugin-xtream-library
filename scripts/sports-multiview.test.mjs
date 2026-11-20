import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function setup() {
  const channels = [{id:'a',sourceId:'one'}, {id:'b',sourceId:'one'}, {id:'c',sourceId:'two'}];
  const settings = {}, notices = []; let stopped = 0, renders = 0;
  const context = vm.createContext({navigator:{}, Date, document:{addEventListener(){}},
    prefs:()=>settings, savePrefs(){}, items:x=>Array.isArray(x)?x:[],
    state:{view:'player', app:{sourceMultiviewLimits:{one:1,two:2}}, multiviewTiles:[]},
    channelByID:id=>channels.find(c=>c.id===id), showAppToast:x=>notices.push(x),
    stopPlayback:()=>stopped++, stopCurrentWatch(){}, render:()=>renders++,
    escapeHTML:String,
  });
  for (const name of ['multiview.js','sports_multiview.js']) {
    const path = new URL('../internal/plugin/ui/'+name, import.meta.url);
    vm.runInContext(fs.existsSync(path)?fs.readFileSync(path,'utf8'):'',context);
  }
  const run = code=>vm.runInContext(code,context);
  return {context,settings,notices,run,stopped:()=>stopped,renders:()=>renders};
}
test('opening a split resolves authorized channels, deduplicates and respects each source limit in one render',()=>{
  const h=setup(); h.run('openSportsMultiview(["a","a","b","missing","c"], 4)');
  assert.deepEqual(Array.from(h.context.state.multiviewTiles,t=>t.channel.id),['a','c']);
  assert.equal(h.stopped(),1); assert.equal(h.renders(),1);
  assert.equal(h.context.state.view,'multiview');
});
test('unavailable presets preserve current playback and saved splits are profile preferences with bounded IDs',()=>{
  const h=setup(); h.run('openSportsMultiview(["missing"], 2)');
  assert.equal(h.stopped(),0); assert.equal(h.context.state.view,'player');
  h.run('openSportsMultiview(["a","c"], 2); saveSportsMultiviewPreset("Sunday")');
  const presets=Object.values(h.settings.sportsMultiviewPresets);
  assert.equal(presets.length,1); assert.equal(presets[0].name,'Sunday');
  assert.deepEqual(Array.from(presets[0].channelIds),['a','c']);
  assert.equal(presets[0].layout,2);
});
test('save-data limits and two-slot layouts constrain manual additions as well as suggested splits',()=>{
  const h=setup(); h.context.navigator.connection={saveData:true};
  h.run('openSportsMultiview(["a","c"], 4)');
  assert.equal(h.context.state.multiviewTiles.length,1);
  h.context.navigator.connection={};h.settings.sportsMultiviewLayout=2;
  assert.equal(h.run('multiviewConnectionLimit()'),2);
});
test('replacing a split closes watch sessions whose start response arrives after the tile was removed',async()=>{
  const h=setup(), requests=[];
  h.context.recordWatchPreference=()=>{};
  h.context.postJSON=(path,body)=>new Promise(resolve=>requests.push({path,body,resolve}));
  h.run('openSportsMultiview(["a"],2); Promise.resolve(startMultiviewWatch(state.multiviewTiles[0])).catch(()=>{}); state.multiviewTiles=[]');
  requests[0].resolve({session:{id:'late-session'}});
  await new Promise(setImmediate);
  assert.equal(requests.length,2);
  assert.match(requests[1].path,/watch\/stop$/);
  assert.equal(requests[1].body.sessionId,'late-session');
});
