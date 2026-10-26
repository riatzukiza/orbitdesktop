import assert from 'node:assert/strict';
import test from 'node:test';
import {createTerminalScope} from './terminal-scope.mjs';
const fixture = (id='own', kind='terminal') => ({workspace_id:'shared',state:{monitors:[{layout:{type:'pane',pane:{id,kind}}}]}});
test('terminal auth and input require current membership in the configured workspace', async () => {
  let snapshot=fixture();
  const scope=createTerminalScope({workspaceId:'shared',readWorkspace:async()=>snapshot});
  await scope(Buffer.from(JSON.stringify({type:'auth',pane_id:'own'})));
  await scope(Buffer.from(JSON.stringify({type:'input',data:'safe'})));
  snapshot=fixture('different');
  await assert.rejects(scope(Buffer.from(JSON.stringify({type:'input',data:'blocked'}))));
});
test('foreign panes, browser panes, mismatched workspaces and identity changes fail closed', async () => {
  for (const snapshot of [fixture('foreign'),fixture('own','browser'),{...fixture(),workspace_id:'foreign'}]) {
    const scope=createTerminalScope({workspaceId:'shared',readWorkspace:async()=>snapshot});
    await assert.rejects(scope(Buffer.from(JSON.stringify({type:'auth',pane_id:'own'}))));
  }
  const scope=createTerminalScope({workspaceId:'shared',readWorkspace:async()=>fixture()});
  await scope(Buffer.from(JSON.stringify({type:'auth',pane_id:'own'})));
  await assert.rejects(scope(Buffer.from(JSON.stringify({type:'history',pane_id:'foreign'}))));
  await assert.rejects(scope(Buffer.from(JSON.stringify({type:'input',workspace_id:'foreign'}))));
});
