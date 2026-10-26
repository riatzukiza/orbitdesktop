import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';

test('real gateway preserves valid login and confines forwarded terminal frames', {timeout:15000}, async () => {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-gateway-boundary-'));
  const token='fixture-owner-token-'.repeat(3);
  let pane='own'; const frames=[]; let forwardedBodies=0;
  const upstream=http.createServer(async (req,res)=> {
    let raw='';for await(const chunk of req)raw+=chunk;
    if(req.url==='/api/body-fixture'){forwardedBodies++;res.end('fixture forwarded');return;}
    assert.equal(req.url,'/api/workspace');
    assert.equal(req.headers.authorization,'Bearer '+token);
    assert.equal(JSON.parse(raw).workspace_id,'shared');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({workspace_id:'shared',state:{monitors:[{layout:{type:'pane',pane:{id:pane,kind:'terminal'}}}]}}));
  });
  const wss=new WebSocketServer({server:upstream});
  wss.on('connection',ws=>ws.on('message',raw=>frames.push(JSON.parse(raw))));
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const base=`http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(scratch,'token'),token,{mode:0o600});
  fs.writeFileSync(path.join(scratch,'config'),JSON.stringify({gateway_port:port,orbit_port:upstream.address().port,public_origin:base,workspace_id:'shared',orbit_token_file:path.join(scratch,'token')}),{mode:0o600});
  const child=spawn(process.execPath,[new URL('./gateway.mjs',import.meta.url).pathname],{env:{...process.env,ORBIT_CONSTELLATION_CONFIG:path.join(scratch,'config')},stdio:'ignore'});
  const sockets=[];
  try {
    for(let i=0;i<60;i++) {try {if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.equal((await fetch(base+'/constellation/api/tool',{method:'POST',headers:{Origin:base,Authorization:'Bearer undefined','Content-Type':'application/json'},body:'{}'})).status,401,'missing MCP configuration must never authenticate a literal undefined token');
    const oversized=await new Promise((resolve,reject)=>{
      const request=http.request(base+'/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded','Content-Length':'12000'}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,connection:response.headers.connection,body:Buffer.concat(chunks).toString()}));
      });
      request.on('error',reject);
      request.setTimeout(2000,()=>request.destroy(Error('oversized refusal stalled')));
      request.write('x'.repeat(8192));
    });
    assert.equal(oversized.status,400);
    assert.equal(oversized.connection,'close');
    assert.match(oversized.body,/Invalid request/);
    assert.equal((await fetch(base+'/health')).status,200);
    const login=token=>fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
    for(let i=0;i<14;i++)assert.ok([401,429].includes((await login('wrong')).status));
    const valid=await login(token);assert.equal(valid.status,303);
    const cookie=valid.headers.get('set-cookie').split(';')[0];
    for(const contentType of ['text/plain','application/json',undefined]) {
      const headers={Origin:base,Cookie:cookie,...(contentType?{'Content-Type':contentType}:{})};
      const mismatch=await fetch(base+'/api/body-fixture',{method:'POST',headers,body:JSON.stringify({workspace_id:'foreign'})});
      assert.equal(mismatch.status,403,'JSON workspace mismatch must not depend on content type');
    }
    assert.equal(forwardedBodies,0);
    for(const payload of ['not JSON','null','[]',JSON.stringify({workspace_id:'shared'})]) {
      const response=await fetch(base+'/api/body-fixture',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'text/plain'},body:payload});
      assert.equal(response.status,200,'defensive workspace inspection preserves other payloads');
    }
    const connect=async()=>{const ws=new WebSocket(base.replace('http','ws')+'/api/terminal',{headers:{Origin:base,Cookie:cookie}});sockets.push(ws);await once(ws,'open');return ws;};
    const foreign=await connect();foreign.send(JSON.stringify({type:'auth',pane_id:'foreign'}));await once(foreign,'close');assert.equal(frames.length,0);
    const own=await connect();own.send(JSON.stringify({type:'auth',pane_id:'own'}));own.send(JSON.stringify({type:'input',data:'allowed'}));
    for(let i=0;i<60&&frames.length<2;i++)await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(frames.map(f=>f.type),['auth','input']);
    pane='removed';own.send(JSON.stringify({type:'history'}));await once(own,'close');assert.equal(frames.length,2);
  } finally {
    for(const ws of sockets)ws.terminate();
    child.kill('SIGTERM');await once(child,'exit');
    for(const ws of wss.clients)ws.terminate();
    await new Promise(r=>wss.close(r));await new Promise(r=>upstream.close(r));
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});
