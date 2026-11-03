#!/usr/bin/env python3
"""Offline real-git protocol/effect checks; all compiler and host calls are argv-only."""
import argparse,json,os,pathlib,shutil,subprocess,tempfile
P=pathlib.Path
ROOT=P(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('host',type=P);ap.add_argument('--before',type=P);ap.add_argument('--evidence',type=P,default=ROOT/'build/protocol');a=ap.parse_args()
host=a.host.resolve();a.evidence.mkdir(parents=True,exist_ok=True);work=a.evidence.resolve()
env=dict(os.environ,HOME=str(work/'home'),LMCTL_HOME=str(work/'home/.lmctl'),LMSCRIPT_TOOL_CACHE=str(work/'cache'),GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_AUTHOR_DATE='2026-01-01T00:00:00Z',GIT_COMMITTER_DATE='2026-01-01T00:00:00Z')
env.pop('LMCODE_INVOCATION_FILE',None);env.pop('LMGIT_GIT',None)
(work/'home').mkdir(exist_ok=True)
real_git=shutil.which('git');assert real_git
env['LMGIT_GIT']=real_git
results=[]
def cmd(argv,**kwargs):return subprocess.run(list(map(str,argv)),capture_output=True,env=kwargs.pop('env',env),**kwargs)
def git(*args):
 r=cmd([real_git,*args]);assert r.returncode==0,(args,r.stderr);return r.stdout.decode().strip()
repo=work/'repository 水'
if not (repo/'.git').exists():
 repo.mkdir();git('init','-q','-b','main',repo);git('-C',repo,'config','user.name','Test User');git('-C',repo,'config','user.email','test@example.invalid')
 (repo/'tracked.txt').write_text('original\n');git('-C',repo,'add','.');git('-C',repo,'commit','-qm','initial');git('-C',repo,'tag','v1');git('-C',repo,'remote','add','origin',str(work/'offline-origin'))
def compile(name,body):
 source=work/(name+'.lms');out=work/(name+'.dslb')
 source.write_text('p = _lmcode_ schema='+json.dumps(str(ROOT/'schema/lmgit.dsl.json'),ensure_ascii=False)+';\n'+body+'\nend _lmcode_\n',encoding='utf8')
 r=cmd(['node',ROOT/'scripts/compile-fixture.mjs',source,out],cwd=ROOT)
 assert r.returncode==0,(name,r.stderr);assert out.read_bytes()[:6]==b'DSLB\0\6';return out
def envelope(r):
 assert r.stderr==b'',r.stderr
 lines=r.stdout.splitlines();begin=[i for i,l in enumerate(lines) if l==b'LMCODE_RETURN_BEGIN'];end=[i for i,l in enumerate(lines) if l==b'LMCODE_RETURN_END']
 assert len(begin)==len(end)==1 and end[0]==begin[0]+2 and end[0]==len(lines)-1,(r.returncode,r.stdout)
 assert r.stdout.endswith(b'LMCODE_RETURN_END\n')
 value=json.loads(lines[begin[0]+1]);assert value['ok']==(r.returncode==0)
 if not value['ok']:assert 'result' not in value and 'parts' not in value
 return value,b'\n'.join(lines[:begin[0]])
def run(files,meta=None,extra=None):
 e=dict(env,**(extra or {}))
 if meta is not None:
  m=work/'invocation.json';m.write_text(json.dumps(meta),encoding='utf8');e['LMCODE_INVOCATION_FILE']=str(m)
 r=cmd([host,*[v for f in files for v in ['--lmcode',f]]],env=e);return r,*envelope(r)
def metadata(files,dry=False,mode='single'):return dict(version=1,mode=mode,dry=dry,parts=[dict(index=i,file=str(f)) for i,f in enumerate(files)])
def check(name,condition,details=None):
 assert condition,(name,details);results.append(name);print('PASS',name,flush=True)
pure=compile('scalar','$return = 0.1 + 0.2;')
r,v,_=run([pure]);check('single exact float frame',r.returncode==0 and r.stdout==b'LMCODE_RETURN_BEGIN\n{"ok":true,"result":0.30000000000000004}\nLMCODE_RETURN_END\n',r)
p1=compile('part-one','report.add("a","one",""); $return = report.len();');p2=compile('part-two','$return = report.len();')
r,v,_=run([p1,p2],metadata([p1,p2],mode='builder'));check('builder shared host and separate results',v==dict(ok=True,result=[1,1],parts=2),v)
r,v,_=run([p1,p1]);check('standalone duplicate occurrences',v==dict(ok=True,result=[1,2],parts=2),v)
x=compile('index-zero','$return = 11;');y=compile('index-one','$return = 22;')
r,v,_=run([y,x],metadata([x,y],mode='builder'));check('manifest add order independent of argv order',v==dict(ok=True,result=[11,22],parts=2),v)
r,v,_=run([pure],metadata([pure],mode='builder'));check('one-slot builder',v==dict(ok=True,result=[0.30000000000000004],parts=1),v)
write=compile('write','git.dry_run(false); let r=git.open('+json.dumps(str(repo),ensure_ascii=False)+'); r.branch_create("must-not-exist"); report.write_text('+json.dumps(str(work/'must-not-write'),ensure_ascii=False)+'); $return = git.is_dry_run();')
trace=work/'git-trace.json';bad=metadata([write])
for value in ['missing',None,'false',0,[]]:
 m=dict(bad)
 if value=='missing':m.pop('dry')
 else:m['dry']=value
 trace.unlink(missing_ok=True);r,v,_=run([write],m,{'GIT_TRACE2_EVENT':str(trace)})
 check('malformed dry before dispatch '+str(value),r.returncode==2 and v['phase']=='cli' and v['code']=='CLI_USAGE' and not trace.exists() and not (work/'must-not-write').exists(),v)
trace.unlink(missing_ok=True);r,v,_=run([write],metadata([write],dry=True),{'GIT_TRACE2_EVENT':str(trace)})
check('immutable dry mode no git/report effects',v==dict(ok=True,result=True,dry=True) and not trace.exists() and not (work/'must-not-write').exists(),v)
check('dry branch not created',git('-C',repo,'branch','--list','must-not-exist')=='')
# Real execution still performs the same operation, only in this owned fixture.
r,v,_=run([write],metadata([write]));check('real write still dispatches',r.returncode==0 and git('-C',repo,'branch','--list','must-not-exist')!='' and (work/'must-not-write').exists(),v)
git('-C',repo,'branch','-D','must-not-exist');(work/'must-not-write').unlink()
app=compile('app-fail','report.add("test","failure","");report.fail_if_any();')
r,v,_=run([app]);check('application failure exit4',r.returncode==4 and v['phase']=='app' and v['code']=='APP_FAIL',v)
err=compile('run-fail','let z=0; print(str(1/z));')
r,v,_=run([pure,err],metadata([pure,err],mode='builder'));check('run failure first part association no partial result',r.returncode==3 and v['phase']=='run' and v['part']==1,v)
junk=work/'junk.dslb';junk.write_bytes(b'not bytecode');r,v,_=run([junk]);check('load failure exit3',r.returncode==3 and v['phase']=='load',v)
r,v,_=run([work/'missing.dslb']);check('unreadable input application exit4',r.returncode==4 and v['phase']=='app',v)
for field,change in [('version',2),('mode','batch'),('parts',[])]:
 m=metadata([pure]);m[field]=change;r,v,_=run([pure],m);check('invalid metadata '+field,r.returncode==2 and v['phase']=='cli',v)
for flag in ['--api','--cli-schema','--schema','--signatures','--'+'dsl','--'+'dsl-schema','--'+'dsl-signatures']:
 r=cmd([host,flag,str(work/'missing.dslb')]);v,_=envelope(r);check('retired flag refusal '+flag,r.returncode==2 and v['phase']=='cli',v)
# Introspection must ignore execution metadata and never touch git.
for args in [['--lmcode-schema'],['--lmcode-schema','--json'],['--lmcode-signatures']]:
 r=cmd([host,*args],env=dict(env,LMCODE_INVOCATION_FILE='missing',LMGIT_GIT='missing'))
 check('passive introspection '+' '.join(args),r.returncode==0 and not r.stderr and (args[0]!='--lmcode-schema' or r.stdout==(ROOT/'schema/lmgit.dsl.json').read_bytes()),r)
large=compile('large-result','$return = str_repeat("x", 2097153);')
r,v,_=run([large]);check('output beyond1MiB untruncated',r.returncode==0 and len(v['result'])==2097153)
limit=compile('large-log-limit','$return = git.open('+json.dumps(str(repo),ensure_ascii=False)+').log(1001).len();')
r,v,_=run([limit]);check('explicit log limit above1000',r.returncode==0 and v['result']==1,v)
# Compare domain observations against the saved original binary, on the SAME inputs.
parity=[]
if a.before:
 snippets=['let r=git.open(REPO);print(r.current_branch());','let r=git.open(REPO);print(str(r.status().len()));','let r=git.open(REPO);print(r.log(2).at(0).hash());','let r=git.open(REPO);print(r.tags().at(0));','let r=git.open(REPO);print(r.remote_url("origin"));','let r=git.open(REPO);print(r.config("user.name"));']
 for i,body in enumerate(snippets):
  file=compile('parity-'+str(i),body.replace('REPO',json.dumps(str(repo),ensure_ascii=False)))
  old=cmd([a.before.resolve(),'--lmcode',file]);new=cmd([host,'--lmcode',file]);nv,nt=envelope(new)
  oldlines=old.stdout.splitlines();assert json.loads(oldlines[-1])['ok'];ot=b'\n'.join(oldlines[:-1])
  check('before/new same-input operation '+str(i),old.returncode==new.returncode==0 and old.stderr==new.stderr==b'' and nt==ot,(old,new))
  parity.append(dict(case=i,trace=nt.decode()))
(work/'parity.json').write_text(json.dumps(parity,indent=2));(work/'checks.json').write_text(json.dumps(results,indent=2))
print('PASS',len(results),'real git/protocol/effect checks')
