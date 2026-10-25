"""Boundary and recovery checks. No model calls or production mutations."""
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('bridge',Path(__file__).with_name('bridge.py'))
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.cfg={'host':'test','state':self.temp.name,'projects':{'fixture':self.temp.name}}
        self.args={'harness':'codex','project':'fixture','prompt':'A literal $(command) `payload`\nsecond line','operation_id':str(uuid.uuid4())}
    def tearDown(self):self.temp.cleanup()
    def test_dispatch_passes_prompt_on_stdin_and_keeps_harness_permissions(self):
        with patch.object(bridge,'executable',return_value='/usr/bin/harness'):
            for harness in ('codex','claude','opencode'):
                args={**self.args,'harness':harness}
                command,directory,prompt=bridge.command_for(self.cfg,args)
                self.assertNotIn(prompt,command)
                self.assertEqual(prompt,args['prompt'])
                self.assertEqual(directory,self.temp.name)
                self.assertFalse(any('dangerously' in arg for arg in command))
    def test_dispatch_rejects_unregistered_project(self):
        with patch.object(bridge,'executable',return_value='/usr/bin/harness'):
            with self.assertRaises(ValueError):bridge.command_for(self.cfg,{**self.args,'project':'/etc'})
    def test_duplicate_submission_does_not_launch_twice_and_payload_change_refuses(self):
        with patch.object(bridge,'executable',return_value='/usr/bin/harness'),patch.object(bridge.threading,'Thread') as thread:
            first=bridge.submit(self.cfg,self.args)
            second=bridge.submit(self.cfg,self.args)
            self.assertEqual(first['id'],second['id']);self.assertEqual(thread.call_count,1)
            self.assertNotIn('prompt',first)
            with self.assertRaises(ValueError):bridge.submit(self.cfg,{**self.args,'prompt':'changed'})
            self.assertEqual(thread.call_count,1)
    def test_upstream_errors_never_reflect_token_or_response(self):
        self.assertEqual(bridge.safe_error(ValueError('secret-token')),'ValueError')
    def test_peer_script_cannot_inject_a_shell_command(self):
        with self.assertRaises(ValueError):bridge.peer_call({'script':'/tmp/script; malicious','ssh':'peer'},'probe',{})
    def test_workspace_mutations_require_explicit_revision_and_operation_identity(self):
        self.cfg.update(workspace_id=str(uuid.uuid4()),orbit_runtime=self.temp.name)
        folder=Path(self.temp.name)/'workspace-access';folder.mkdir()
        (folder/(self.cfg['workspace_id']+'.json')).write_text(json.dumps({'api':'http://127.0.0.1:12345','capability':'secret'}))
        with patch.object(bridge,'fetch') as fetch:
            with self.assertRaises(ValueError):bridge.workspace(self.cfg,'apply',{'operations':[]})
            fetch.assert_not_called()
    def test_mcp_has_no_implicit_agent_dispatch_tool(self):
        self.assertNotIn('orbit_submit',{tool['name']for tool in bridge.tools()})
    def test_real_child_records_native_identity_public_answer_and_completion(self):
        record={'id':str(uuid.uuid4()),'host':'fixture','state':'accepted','created_at':bridge.now()}
        script="import sys,json; sys.stdin.read(); print(json.dumps({'type':'thread.started','thread_id':'native-fixture'})); print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Verified fixture answer'}}))"
        bridge.run_job(self.cfg,record,[sys.executable,'-c',script],self.temp.name,'Literal prompt')
        result=bridge.jobs(self.cfg)[0]
        self.assertEqual(result['state'],'completed')
        self.assertEqual(result['native_session_id'],'native-fixture')
        self.assertEqual(result['answer'].strip(),'Verified fixture answer')

    def test_proxx_is_explicit_and_never_assumes_unconfigured_budget_is_zero(self):
        self.assertEqual(bridge.proxx_observation(self.cfg), {'configured': False, 'status': 'unavailable'})
        for url in ('http://remote.example', 'https://user:secret@example.com', 'https://example.com?token=secret'):
            with self.assertRaises(ValueError):
                bridge.proxx_observation({**self.cfg, 'proxx': {'url': url, 'token': 'private'}})

    def test_proxx_projection_redacts_request_content_and_keeps_actual_route(self):
        cfg = {**self.cfg, 'proxx': {'url': 'http://127.0.0.1:8789', 'token': 'private', 'label': 'Bot ledger'}}
        entry = {'id': 'one', 'model': 'gemma4:31b', 'upstreamModel': 'google/gemma-4-31b-it',
                 'costUsd': 0, 'ttftMs': 123, 'tps': 38, 'status': 200,
                 'metadata': {'secret': 'hidden'}, 'prompt': 'private contents', 'accountId': 'credential-label'}
        def response(url, **kwargs):
            self.assertEqual(kwargs['token'], 'private')
            return {'budgets': []} if url.endswith('paid-budgets') else {'entries': [entry]}
        with patch.object(bridge, 'fetch', side_effect=response):
            result = bridge.proxx_observation(cfg)
        observed = result['usage']['data']['entries'][0]
        self.assertEqual(observed['upstreamModel'], 'google/gemma-4-31b-it')
        self.assertEqual(observed['costUsd'], 0)
        for field in ('metadata', 'prompt', 'accountId'):
            self.assertNotIn(field, observed)
        self.assertNotIn('private', json.dumps(result))

    def test_proxx_failure_never_reflects_credentials_or_response_body(self):
        cfg = {**self.cfg, 'proxx': {'url': 'https://example.com', 'token': 'secret'}}
        with patch.object(bridge, 'fetch', side_effect=ValueError('secret response')):
            result = bridge.proxx_observation(cfg)
        self.assertFalse(result['budgets']['ok'])
        self.assertNotIn('secret', json.dumps(result))

    def test_bad_opencode_response_preserves_other_host_evidence(self):
        self.cfg['opencode'] = {'url': 'http://127.0.0.1:12345'}
        with patch.object(bridge, 'fetch', return_value={'unexpected': 'shape'}), \
             patch.object(bridge, 'codex_sessions', return_value=[]), \
             patch.object(bridge, 'claude_sessions', return_value=[]):
            result = bridge.probe(self.cfg)
        self.assertIn('load', result)
        self.assertIn('memory', result)
        harnesses = {h['id']: h for h in result['harnesses']}
        self.assertTrue(harnesses['codex']['sessions']['ok'])
        self.assertTrue(harnesses['claude']['sessions']['ok'])
        self.assertFalse(harnesses['opencode']['sessions']['ok'])

if __name__=='__main__':unittest.main()
