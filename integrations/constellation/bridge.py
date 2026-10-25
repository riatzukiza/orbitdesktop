#!/usr/bin/env python3
"""Orbit Constellation: explicit host adapters, owner dashboard and stdio MCP.

SPDX-License-Identifier: GPL-3.0-or-later
Only the standard library is required. Runtime configuration and job records are
private. This adapter never imports transcripts or mutates Rheos board state.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import fcntl
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = Path.home() / '.config/orbit/constellation.json'
MAX_BODY = 65536
LOCK = threading.Lock()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def config():
    path = Path(os.environ.get('ORBIT_CONSTELLATION_CONFIG', DEFAULT_CONFIG))
    if path.stat().st_mode & 0o077:
        raise ValueError('Constellation config must be owner-only (0600)')
    return json.loads(path.read_text())


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, data=None, token=None, basic=None, timeout=6):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if basic:
        import base64
        headers['Authorization'] = 'Basic ' + base64.b64encode(basic.encode()).decode()
    if data is not None:
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
        raw = response.read(4_000_001)
        if len(raw) > 4_000_000:
            raise ValueError('Upstream response exceeds limit')
        return json.loads(raw)


def safe_error(error):
    # Never reflect URLs, credentials, subprocess stderr or upstream bodies.
    if isinstance(error, urllib.error.HTTPError):
        return 'Upstream HTTP ' + str(error.code)
    return type(error).__name__


def attempt(fn):
    try:
        return {'ok': True, 'observed_at': now(), 'data': fn()}
    except Exception as error:
        return {'ok': False, 'observed_at': now(), 'error': safe_error(error)}


def executable(harness):
    candidates = {
        'codex': [Path.home()/'.bun/bin/codex', Path.home()/'.local/bin/codex'],
        'claude': [Path.home()/'.local/bin/claude'],
        'opencode': [Path.home()/'.opencode/bin/opencode'],
    }
    found = shutil.which(harness)
    if found:
        return found
    return next((str(p) for p in candidates[harness] if p.is_file()), None)


def codex_sessions():
    db = Path.home()/'.codex/state_5.sqlite'
    if not db.exists():
        return []
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=1) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(
            'SELECT id,title,cwd,updated_at,archived,source FROM threads ORDER BY updated_at DESC LIMIT 20')]


def claude_sessions():
    projects = Path.home()/'.claude/projects'
    if not projects.exists():
        return []
    # Filenames/times only: no speculative transcript parsing or private bodies.
    files = sorted(projects.glob('*/*.jsonl'), key=lambda p:p.stat().st_mtime, reverse=True)[:20]
    return [{'id':p.stem, 'title':p.stem, 'updated_at':int(p.stat().st_mtime),
             'state':'recorded; liveness unknown'} for p in files]


def probe(cfg):
    load = os.getloadavg()
    memory = {}
    if Path('/proc/meminfo').exists():
        memory = {line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
    processes = subprocess.run(['ps','-eo','comm='], capture_output=True, text=True, timeout=3).stdout.splitlines()
    harnesses = []
    for name, reader in [('codex',codex_sessions), ('claude',claude_sessions), ('opencode',lambda: fetch(cfg['opencode']['url']+'/session?limit=20', basic=cfg['opencode'].get('basic')) if cfg.get('opencode') else [])]:
        sessions = attempt(reader)
        # OpenCode returns a list. Do not expose arbitrary API object fields.
        if name == 'opencode' and sessions['ok']:
            rows = sessions['data']
            if not isinstance(rows, list):
                sessions = {'ok': False, 'observed_at': sessions['observed_at'], 'error': 'Unexpected OpenCode session response'}
            else:
                sessions['data'] = [{k:r[k] for k in ('id','title','directory','time','parentID') if k in r} for r in rows[:20] if isinstance(r, dict)]
        harnesses.append({'id':name, 'installed':bool(executable(name)),
                          'process_count':sum(1 for p in processes if p.strip()==name),
                          'sessions':sessions})
    services = {}
    for name, url in cfg.get('health', {}).items():
        services[name] = attempt(lambda url=url:fetch(url))
    return {'host':cfg.get('host',socket.gethostname()), 'hostname':socket.gethostname(),
            'observed_at':now(), 'load':list(load), 'memory':memory,
            'harnesses':harnesses, 'services':services}


def peer_call(peer, action, args):
    # No request text is interpolated into the remote shell command.
    script = peer['script']
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',script):
        raise ValueError('Invalid peer script')
    command = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','-o','IdentitiesOnly=yes','-o','ForwardAgent=no',peer['ssh'], 'python3 '+script+' rpc']
    done = subprocess.run(command, input=json.dumps({'action':action,'args':args}), text=True, capture_output=True, timeout=22)
    if done.returncode:
        raise RuntimeError('Peer unavailable')
    if len(done.stdout)>4_000_000:
        raise ValueError('Peer response exceeds limit')
    value = json.loads(done.stdout)
    if not value.get('ok'):
        raise RuntimeError(value.get('error','Peer operation failed'))
    return value['data']


def host_call(cfg, host, action, args):
    if host == cfg['host']:
        return rpc(cfg,action,args)
    if host not in cfg.get('peers',{}):
        raise ValueError('Unknown host')
    return peer_call(cfg['peers'][host],action,args)


def proxx_observation(cfg):
    service = cfg.get('proxx')
    if not service:
        return {'configured': False, 'status': 'unavailable'}
    parsed = urllib.parse.urlsplit(service['url'])
    if (parsed.scheme not in ('http', 'https') or parsed.username or parsed.password
            or parsed.query or parsed.fragment
            or (parsed.scheme == 'http' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'))):
        raise ValueError('Proxx requires HTTPS or loopback HTTP without URL credentials')
    base = service['url'].rstrip('/')
    def call(path):
        return fetch(base + path, token=service.get('token'))
    budgets = attempt(lambda: call('/api/v1/paid-budgets'))
    def usage():
        response = call('/api/v1/request-logs?limit=200')
        # Never forward prompts, credentials, metadata or arbitrary upstream fields.
        fields = ('id', 'timestamp', 'providerId', 'model', 'upstreamModel',
                  'status', 'costUsd', 'promptTokens', 'completionTokens', 'ttftMs', 'tps')
        return {'entries': [{k: entry[k] for k in fields if k in entry}
                            for entry in response.get('entries', [])[:200]],
                'limit': 200, 'coverage': 'recent attempts; not a billing statement'}
    return {'configured': True, 'label': service.get('label', 'Configured Proxx'),
            'observed_at': now(), 'budgets': budgets, 'usage': attempt(usage)}


def snapshot(cfg):
    hosts = [cfg['host'], *cfg.get('peers',{})]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {host:pool.submit(attempt,lambda host=host:host_call(cfg,host,'probe',{})) for host in hosts}
        memory_future = pool.submit(attempt,lambda:memory(cfg,'overview',{}))
        proxx_future = pool.submit(attempt,lambda:proxx_observation(cfg))
        return {'observed_at':now(), 'workspace_id':cfg.get('workspace_id'),
                'public_origin':cfg.get('public_origin'), 'hosts':{host:future.result() for host,future in futures.items()},
                'openplanner':memory_future.result(), 'proxx':proxx_future.result(), 'links':cfg.get('links',{}),
                'semantics':'Session records are history, process counts are observed; neither proves a session is active.'}


def memory(cfg, action, args):
    service = cfg.get('openplanner')
    if not service:
        raise ValueError('OpenPlanner is not configured on this host')
    def call(path, data=None):
        return fetch(service['url']+'/v1/'+path, data, token=service.get('token'))
    if action == 'overview':
        return {'health':attempt(lambda:call('health')), 'graph':attempt(lambda:call('graph/stats')),
                'sessions':attempt(lambda:call('sessions?limit=12'))}
    query = args.get('query','')
    if not isinstance(query,str) or not 1<=len(query)<=500:
        raise ValueError('Search query must contain 1–500 characters')
    return call('search/fts',{'q':query,'limit':12})


def workspace(cfg, action, args):
    workspace_id = cfg['workspace_id']
    runtime = Path(cfg['orbit_runtime'])
    record = json.loads((runtime/'workspace-access'/(workspace_id+'.json')).read_text())
    request = {'workspace_id':workspace_id,'action':action}
    if action == 'apply':
        # Orbit remains the validator, checkpoint and revision authority.
        for field in ('operations','base_revision','operation_id','intent'):
            if field not in args:
                raise ValueError('Missing '+field)
            request[field] = args[field]
    return fetch(record['api']+'/api/workspace/control',request,token=record['capability'])


def job_dir(cfg):
    return Path(cfg['state'])/'jobs'


def command_for(cfg, args):
    harness = args.get('harness')
    project = args.get('project')
    prompt = args.get('prompt')
    if harness not in ('codex','claude','opencode') or not executable(harness):
        raise ValueError('Harness unavailable')
    if project not in cfg.get('projects',{}):
        raise ValueError('Select an explicitly configured project')
    directory = str(Path(cfg['projects'][project]).resolve(strict=True))
    if not isinstance(prompt,str) or not 1<=len(prompt)<=12000:
        raise ValueError('Prompt must contain 1–12000 characters')
    # Prompts travel over stdin, never shell interpolation or process arguments.
    commands = {
        'codex':[executable('codex'),'exec','--json','-C',directory,'-'],
        'claude':[executable('claude'),'-p','--verbose','--output-format','stream-json'],
        'opencode':[executable('opencode'),'run','--format','json','--dir',directory],
    }
    return commands[harness], directory, prompt


def public_job(value):
    return {k:v for k,v in value.items() if k not in ('prompt','request_hash')}


def run_job(cfg, record, command, directory, prompt):
    path = job_dir(cfg)/(record['id']+'.json')
    try:
        with subprocess.Popen(command,cwd=directory,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True) as process:
            record.update(state='running',pid=process.pid,process_start=Path('/proc/'+str(process.pid)+'/stat').read_text().rsplit(')',1)[1].split()[19],boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),updated_at=now())
            write_private(path,record)
            process.stdin.write(prompt.encode());process.stdin.close()
            def terminate():
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
            timer = threading.Timer(900, terminate);timer.start()
            total = 0
            try:
                for raw in iter(lambda:process.stdout.readline(65537),b''):
                    total += len(raw)
                    if total > 10_000_000 or len(raw)>65536:
                        terminate();break
                    try:
                        event=json.loads(raw)
                    except (ValueError,UnicodeError):
                        continue
                    native_id=event.get('thread_id') if event.get('type')=='thread.started' else event.get('session_id') or event.get('sessionID') or event.get('part',{}).get('sessionID')
                    if isinstance(native_id,str) and len(native_id)<=160 and record.get('native_session_id')!=native_id:
                        record['native_session_id']=native_id
                        write_private(path,record)
                    text=''
                    if event.get('type')=='item.completed' and event.get('item',{}).get('type')=='agent_message':
                        text=event['item'].get('text','')
                    elif event.get('type')=='assistant':
                        text='\n'.join(part.get('text','') for part in event.get('message',{}).get('content',[]) if part.get('type')=='text')
                    elif event.get('type')=='text':
                        text=event.get('part',{}).get('text','')
                    if text:
                        record['answer']=(record.get('answer','')+'\n'+text)[-32000:]
                        record['updated_at']=now();write_private(path,record)
                code=process.wait(timeout=10)
            finally:
                timer.cancel()
            record.update(state='completed' if code==0 else 'failed',exit_code=code,updated_at=now())
    except Exception as error:
        record.update(state='failed',error=safe_error(error),updated_at=now())
    write_private(path,record)


def submit(cfg, args):
    key=args.get('operation_id','')
    if not isinstance(key,str) or not re.fullmatch(r'[a-f0-9-]{36}',key):
        raise ValueError('Retain a UUID operation_id for submission/recovery')
    command,directory,prompt=command_for(cfg,args)
    digest=hashlib.sha256(json.dumps(args,sort_keys=True).encode()).hexdigest()
    path=job_dir(cfg)/(key+'.json')
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with LOCK, open(path.parent/'.submission.lock','a') as lockfile:
        fcntl.flock(lockfile,fcntl.LOCK_EX)
        if path.exists():
            existing=json.loads(path.read_text())
            if existing['request_hash']!=digest:
                raise ValueError('Operation ID already belongs to a different request')
            return public_job(existing)
        record={'id':key,'host':cfg['host'],'harness':args['harness'],'project':args['project'],
                'directory':directory,'prompt':prompt,'request_hash':digest,'state':'accepted',
                'created_at':now(),'updated_at':now(), 'answer':'',
                'target':'New CLI worker; existing desktop chats are not resumed'}
        write_private(path,record)
        # The HTTP host owns this process. SSH rpc forks an explicit worker below.
        if os.environ.get('ORBIT_CONSTELLATION_RPC')=='1':
            subprocess.Popen([sys.executable,str(ROOT/'bridge.py'),'worker',key],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        else:
            threading.Thread(target=run_job,args=(cfg,record,command,directory,prompt),daemon=True).start()
    return public_job(record)


def jobs(cfg):
    files=sorted(job_dir(cfg).glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True)[:30]
    results=[]
    for path in files:
        record=json.loads(path.read_text())
        if record['state']=='accepted' and time.time()-datetime.datetime.fromisoformat(record['created_at']).timestamp()>60:
            record.update(state='outcome_unknown',error='Accepted request has no recorded worker identity; inspect the native harness before reconsidering.')
        if record['state']=='running':
            try:
                same=Path('/proc/sys/kernel/random/boot_id').read_text().strip()==record.get('boot_id') and Path('/proc/'+str(record['pid'])+'/stat').read_text().rsplit(')',1)[1].split()[19]==record.get('process_start')
            except (OSError,KeyError):same=False
            if not same:
                record.update(state='outcome_unknown',error='The recorded worker is no longer live; do not replay its submission.')
        results.append(public_job(record))
    return results


def rpc(cfg, action, args):
    if action=='probe':return probe(cfg)
    if action=='projects':return {'projects':list(cfg.get('projects',{})), 'harnesses':[h for h in ('codex','claude','opencode') if executable(h)]}
    if action=='submit':return submit(cfg,args)
    if action=='jobs':return jobs(cfg)
    raise ValueError('Unsupported host operation')


def tool_call(cfg, name, args):
    if cfg.get('controller'):
        remote=cfg['controller']
        return fetch(remote['url']+'/api/tool',{'name':name,'arguments':args},token=remote['token'],timeout=35)
    if name=='orbit_fleet':return snapshot(cfg)
    if name=='orbit_memory_search':return memory(cfg,'search',args)
    if name=='orbit_workspace_read':return workspace(cfg,'read',{})
    if name=='orbit_workspace_apply':return workspace(cfg,'apply',args)
    if name=='orbit_jobs':return host_call(cfg,args.get('host',cfg['host']),'jobs',{})
    if name=='orbit_projects':return host_call(cfg,args.get('host',cfg['host']),'projects',{})
    raise ValueError('Unknown tool')


def tools():
    def tool(name,description,properties,required=None,read=True):
        return {'name':name,'description':description,'inputSchema':{'type':'object','properties':properties,'required':required or [],'additionalProperties':False},
                'annotations':{'readOnlyHint':read,'destructiveHint':False,'openWorldHint':True}}
    return [tool('orbit_fleet','Observe configured machines, harness session metadata and OpenPlanner. Recorded sessions do not prove liveness.',{}),
            tool('orbit_memory_search','Search existing OpenPlanner memory with full-text search.',{'query':{'type':'string','maxLength':500}},['query']),
            tool('orbit_workspace_read','Read the shared Orbit workspace layout; no terminal buffers or chat contents.',{}),
            tool('orbit_workspace_apply','Apply owner-requested layout changes through Orbit revision/checkpoint validation. Read first; retain exact operation_id and payload on an unknown outcome.',
                 {'operations':{'type':'array','items':{'type':'object'},'minItems':1,'maxItems':32},'base_revision':{'type':'integer'},'operation_id':{'type':'string'},'intent':{'type':'string'}},['operations','base_revision','operation_id','intent'],False),
            tool('orbit_jobs','Read public results/status of Orbit-created CLI workers.',{'host':{'type':'string'}}),
            tool('orbit_projects','List explicitly configured dispatch projects and installed harnesses.',{'host':{'type':'string'}})]


def mcp(cfg):
    # MCP stdio transport is newline-delimited JSON-RPC, not Content-Length framing.
    for line in sys.stdin:
        request={}
        try:
            if len(line)>MAX_BODY:raise ValueError('Request exceeds limit')
            request=json.loads(line)
            if 'id' not in request:continue
            method=request.get('method')
            if method=='initialize':
                result={'protocolVersion':request.get('params',{}).get('protocolVersion','2024-11-05'),'capabilities':{'tools':{}},'serverInfo':{'name':'orbit-constellation','version':'0.1.0'}}
            elif method=='ping':result={}
            elif method=='tools/list':result={'tools':tools()}
            elif method=='tools/call':
                params=request.get('params',{})
                try:
                    value=tool_call(cfg,params['name'],params.get('arguments',{}))
                    result={'content':[{'type':'text','text':json.dumps(value)}]}
                except Exception as error:
                    result={'isError':True,'content':[{'type':'text','text':safe_error(error)}]}
            else:
                print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True);continue
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
        except Exception as error:
            print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32602,'message':safe_error(error)}}),flush=True)


def serve(cfg):
    expected=cfg['token']
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def respond(self,status,value,content_type='application/json'):
            raw=json.dumps(value).encode() if content_type=='application/json' else value
            self.send_response(status)
            self.send_header('Content-Type',content_type)
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self' http://127.0.0.1:4173 http://127.0.0.1:4318 https://orbit.promethean.rest; base-uri 'none'; form-action 'self'")
            self.send_header('Content-Length',str(len(raw)))
            self.end_headers();self.wfile.write(raw)
        def authorized(self):
            supplied=self.headers.get('Authorization','').removeprefix('Bearer ')
            return bool(supplied) and hmac.compare_digest(supplied,expected)
        def do_GET(self):
            url=urllib.parse.urlsplit(self.path)
            if url.path=='/health':return self.respond(200,{'ok':True,'service':'orbit-constellation'})
            # HTML/assets contain no private data. APIs require authentication.
            files={'/':'dashboard.html','/dashboard.js':'dashboard.js','/dashboard.css':'dashboard.css'}
            if url.path in files:
                file=ROOT/files[url.path]
                mime={'html':'text/html; charset=utf-8','js':'text/javascript','css':'text/css'}[file.suffix[1:]]
                return self.respond(200,file.read_bytes(),mime)
            if not self.authorized():return self.respond(401,{'error':'Unlock the dashboard with its owner token'})
            try:
                if url.path=='/api/snapshot':return self.respond(200,snapshot(cfg))
                if url.path=='/api/jobs':
                    host=urllib.parse.parse_qs(url.query).get('host',[cfg['host']])[0]
                    return self.respond(200,host_call(cfg,host,'jobs',{}))
                return self.respond(404,{'error':'Not found'})
            except Exception as error:return self.respond(502,{'error':safe_error(error)})
        def do_POST(self):
            if not self.authorized():return self.respond(401,{'error':'Authentication required'})
            origin=self.headers.get('Origin')
            allowed=cfg.get('origins',[])+[f'http://127.0.0.1:{cfg["port"]}']
            if origin and origin not in allowed:return self.respond(403,{'error':'Origin rejected'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=MAX_BODY:raise ValueError('Request exceeds limit')
                args=json.loads(self.rfile.read(size))
                if self.path=='/api/search':value=memory(cfg,'search',args)
                elif self.path=='/api/tool':value=tool_call(cfg,args['name'],args.get('arguments',{}))
                elif self.path=='/api/projects':value=host_call(cfg,args.get('host',cfg['host']),'projects',{})
                elif self.path=='/api/submit':
                    if args.pop('confirm',False) is not True:raise ValueError('Explicit dispatch confirmation required')
                    host=args.pop('host',cfg['host'])
                    value=host_call(cfg,host,'submit',args)
                else:return self.respond(404,{'error':'Not found'})
                return self.respond(200,value)
            except Exception as error:return self.respond(400,{'error':safe_error(error)})
    print('Orbit Constellation listening on loopback '+str(cfg['port']),file=sys.stderr)
    http.server.ThreadingHTTPServer(('127.0.0.1',cfg['port']),Handler).serve_forever()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['serve','mcp','probe','rpc','worker'])
    parser.add_argument('job',nargs='?')
    args=parser.parse_args();cfg=config()
    if args.mode=='serve':serve(cfg)
    elif args.mode=='mcp':mcp(cfg)
    elif args.mode=='probe':print(json.dumps(probe(cfg)))
    elif args.mode=='rpc':
        os.environ['ORBIT_CONSTELLATION_RPC']='1'
        try:
            raw=sys.stdin.read(MAX_BODY+1)
            if len(raw)>MAX_BODY:raise ValueError('Request exceeds limit')
            request=json.loads(raw);value=rpc(cfg,request['action'],request.get('args',{}))
            print(json.dumps({'ok':True,'data':value}))
        except Exception as error:print(json.dumps({'ok':False,'error':safe_error(error)}))
    else:
        if not args.job or not re.fullmatch(r'[a-f0-9-]{36}',args.job):raise ValueError('Invalid job ID')
        record=json.loads((job_dir(cfg)/(args.job+'.json')).read_text())
        command,directory,prompt=command_for(cfg,record)
        run_job(cfg,record,command,directory,prompt)


if __name__=='__main__':main()
