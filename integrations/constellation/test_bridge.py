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

if __name__=='__main__':unittest.main()
