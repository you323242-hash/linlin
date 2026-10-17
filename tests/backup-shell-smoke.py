"""Linux-only, actual shell templates with isolated paths and systemctl/node stubs."""
import os, pathlib, tempfile, subprocess, shutil, time, fcntl, re

repo=pathlib.Path(__file__).resolve().parents[1]
root=pathlib.Path(tempfile.mkdtemp(prefix='delta-backup-smoke-')).resolve()
try:
    (root/'deploy').mkdir(); (root/'bin').mkdir(); (root/'maintenance').mkdir(); (root/'backups').mkdir()
    key=root/'backup.key';key.write_text('fixture');key.chmod(0o600)
    for name in ['backup-cycle.sh','backup-resume.sh']:
        text=(repo/'deploy'/name).read_text().replace('/opt/delta-staging/current',str(root)).replace('/var/lib/delta-maintenance',str(root/'maintenance')).replace('/var/backups/delta-staging',str(root/'backups')).replace('/etc/delta/backup.key',str(key)).replace('/var/lib/delta-monitor/backup-status.json',str(root/'status')).replace('__NODE_BINARY__',str(root/'bin'/'node'))
        # Source placeholders and rendered Linux paths must both use the stub.
        text=re.sub(r'^NODE_BINARY=.*$', 'NODE_BINARY='+str(root/'bin'/'node'), text, flags=re.M)
        (root/'deploy'/name).write_text(text)
    stub='''#!/usr/bin/env python3
import os,sys,pathlib
r=pathlib.Path(os.environ['SIM_ROOT']);a=sys.argv[1:]
if a[0]=='show':
 if os.environ.get('FAIL_QUERY'):sys.exit(9)
 print(os.environ.get('APP_STATE', 'active' if (r/a[-1]).exists() else 'inactive'));sys.exit(0)
if a[0]=='is-active':sys.exit(0 if (r/a[-1]).exists() else 3)
for name in a[1:]:
 if a[0]=='start':
  if name=='delta-monitor.timer' and os.environ.get('FAIL_MONITOR'):sys.exit(7)
  if name=='delta-monitor.timer' and os.environ.get('FALSE_MONITOR'):sys.exit(0)
  if name=='delta-staging' and os.environ.get('FAIL_APP'):sys.exit(8)
  (r/name).touch()
 elif a[0]=='stop':(r/name).unlink(missing_ok=True)
'''
    (root/'bin'/'systemctl').write_text(stub)
    (root/'bin'/'node').write_text('''#!/usr/bin/env python3
import os,sys,pathlib
r=pathlib.Path(os.environ['SIM_ROOT']);a=sys.argv[1:]
if a[:2]==['scripts/backup.mjs','create'] and os.environ.get('FAIL_CREATE'):sys.exit(6)
if a[0]=='scripts/backup-status.mjs':(r/'status').write_text(a[1])
if a[0]=='scripts/recovery-check.mjs' and os.environ.get('STOP_DURING_RECOVERY'):(r/'delta-staging').unlink(missing_ok=True)
''')
    (root/'bin'/'df').write_text('#!/bin/sh\nprintf "Avail\\n99999999999\\n"\n')
    (root/'bin'/'curl').write_text('#!/bin/sh\nexit "${FAIL_HEALTH:-0}"\n')
    for file in (root/'bin').iterdir():file.chmod(0o700)
    env={**os.environ,'SIM_ROOT':str(root),'BETTER_AUTH_URL':'https://fixture.invalid','PATH':str(root/'bin')+':'+os.environ['PATH']}
    marker=root/'maintenance'/'paused';pending=root/'maintenance'/'monitor-pending';site=root/'delta-staging';monitor=root/'delta-monitor.timer'
    def reset(active=False):
        for file in [marker,pending,site,monitor,root/'status']:file.unlink(missing_ok=True)
        if active:site.touch();monitor.touch()
    def run(script,extra=None,arg=None):
        return subprocess.run(['/usr/bin/bash',str(root/'deploy'/script)]+([arg] if arg else []),env={**env,**(extra or {})},capture_output=True,text=True,timeout=15).returncode
    reset();marker.write_text('resume-monitor\n');assert run('backup-resume.sh',{'FAIL_MONITOR':'1'})!=0;assert site.exists() and not marker.exists() and pending.exists()
    reset();marker.write_text('resume-monitor\n');assert run('backup-resume.sh',{'FAIL_HEALTH':'22'})==22;assert site.exists() and monitor.exists() and not marker.exists()
    reset(True);assert run('backup-cycle.sh',{'FAIL_HEALTH':'22'})==22;assert site.exists() and monitor.exists() and not marker.exists();assert (root/'status').read_text()=='failed'
    reset();marker.write_text('resume-monitor\n');assert run('backup-resume.sh',{'FAIL_APP':'1'})==8;assert not site.exists() and monitor.exists() and marker.exists()
    reset();marker.write_text('resume-monitor\n');assert run('backup-resume.sh',{'BETTER_AUTH_URL':''})==64;assert site.exists() and monitor.exists() and not marker.exists()
    reset();marker.write_text('resume\n');assert run('backup-resume.sh',{'FAIL_HEALTH':'22'})==22;assert site.exists() and not monitor.exists() and not marker.exists()
    reset();marker.write_text('resume\n');os.utime(marker,(time.time()-7200,time.time()-7200));assert run('backup-resume.sh')==0;assert not site.exists() and not marker.exists()
    reset();marker.write_text('resume\n')
    with open(root/'maintenance'/'backup.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);assert run('backup-resume.sh')==0;assert not site.exists() and marker.exists()
    assert run('backup-resume.sh')==0;assert site.exists() and not marker.exists()
    reset();assert run('backup-cycle.sh')==0;assert run('backup-resume.sh')==0;assert not site.exists()
    reset(True);assert run('backup-cycle.sh',{'FAIL_CREATE':'1'})==6;assert site.exists() and not marker.exists();assert (root/'status').read_text()=='failed'
    reset(True);assert run('backup-cycle.sh',{'STOP_DURING_RECOVERY':'1'})==0;assert not site.exists() and not marker.exists();assert (root/'status').read_text()=='ok'
    def make_pending():
        pending.write_text('resume-monitor\n');pending.chmod(0o600)
    reset();site.touch();make_pending();assert run('backup-resume.sh',arg='monitor-only')==0;assert monitor.exists() and not pending.exists() and site.exists()
    reset();site.touch();make_pending();assert run('backup-resume.sh',{'FAIL_MONITOR':'1'},'monitor-only')==7;assert pending.exists() and not monitor.exists()
    reset();site.touch();make_pending();assert run('backup-resume.sh',{'FALSE_MONITOR':'1'},'monitor-only')!=0;assert pending.exists() and not monitor.exists()
    reset();make_pending();assert run('backup-resume.sh',arg='monitor-only')==0;assert not site.exists() and not monitor.exists() and pending.exists()
    reset();make_pending();marker.write_text('resume-monitor\n');assert run('backup-resume.sh',arg='monitor-only')==0;assert not site.exists() and not monitor.exists() and marker.exists()
    reset();site.touch();make_pending();os.utime(pending,(time.time()-7200,time.time()-7200));assert run('backup-resume.sh',arg='monitor-only')==75;assert pending.exists() and not monitor.exists()
    reset();site.touch();make_pending();pending.write_text('invalid\n');assert run('backup-resume.sh',arg='monitor-only')==65;assert pending.exists() and not monitor.exists()
    reset();site.touch();make_pending()
    with open(root/'maintenance'/'backup.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);assert run('backup-resume.sh',arg='monitor-only')==0;assert pending.exists() and not monitor.exists()
    assert run('backup-resume.sh',arg='monitor-only')==0;assert monitor.exists() and not pending.exists()
    reset();site.touch();make_pending();assert run('backup-resume.sh',{'FAIL_QUERY':'1'},'monitor-only')==9;assert pending.exists() and not monitor.exists()
    reset();site.touch();make_pending();assert run('backup-resume.sh',{'APP_STATE':'unknown'},'monitor-only')==65;assert pending.exists() and not monitor.exists()
    # Operational lock failure is not ordinary contention.
    (root/'bin'/'flock').write_text('#!/bin/sh\nexit 74\n');(root/'bin'/'flock').chmod(0o700)
    reset();site.touch();make_pending();assert run('backup-resume.sh',arg='monitor-only')==74;assert pending.exists() and not monitor.exists()
    print('PASS: 23 isolated shell scenarios; no real systemctl, backups or source data touched')
finally:
    assert root.parent==pathlib.Path(tempfile.gettempdir()).resolve() and root.name.startswith('delta-backup-smoke-')
    shutil.rmtree(root)
