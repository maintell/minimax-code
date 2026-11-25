/**
 * Commands two Windows Agents ran in bypass mode before they broke MiniMax Code
 * (feedback MCT-202611-ZUP2Q2TP and MCT-202611-JOXMBS1C), verbatim from the
 * runtime permission log. `{{DATA_DIR}}` stands for the user's data directory and
 * `{{SCRIPT}}` for the restore script the Agent wrote outside it.
 */
/** Second round of a secret scrub: rewrites every file under the data directory as UTF-8 text. */
export const SCRUB_DATA_DIRECTORY = String.raw `$ErrorActionPreference='Continue'
$js = @'
const fs=require('fs'), path=require('path');
const roots=['{{DATA_DIR}}','D:/Minmax'];
const pats=[/mmoat_[A-Za-z0-9_\-]{10,}/g,/mmort_[A-Za-z0-9_\-]{10,}/g,/sk-[A-Za-z0-9]{32}/g];
function walk(d,acc){let es=[];try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return acc;}
 for(const e of es){const p=path.join(d,e.name);
  if(e.isDirectory()){ if(e.name==='secrets'||e.name==='node_modules'||e.name==='.git') continue; walk(p,acc);}
  else {try{const st=fs.statSync(p); if(st.isFile()&&st.size<80*1024*1024)acc.push(p);}catch{}}} return acc;}
const files=[]; for(const r of roots) walk(r,files);
let hits=0,mods=0; const list=[];
for(const f of files){let b;try{b=fs.readFileSync(f,'utf8')}catch{continue}
 let o=b;
 for(const re of pats) b=b.replace(re,(m)=>{hits++;return 'X'.repeat(m.length);});
 if(b!==o){fs.writeFileSync(f,b,'utf8');mods++;list.push(f);}}
console.log('SCANNED='+files.length+' HITS='+hits+' MODIFIED='+mods);
list.forEach(f=>console.log('  '+f));
'@
Set-Content -Path 'D:\Minmax\_redact2.js' -Value $js -Encoding UTF8
node 'D:\Minmax\_redact2.js'`;
/** First round of the same scrub, naming two state directories instead of the data directory. */
export const SCRUB_STATE_DIRECTORIES = String.raw `$ErrorActionPreference='Continue'
$js = @'
const fs=require('fs'), path=require('path');
const roots=[
 '{{DATA_DIR}}/v2/sessions',
 '{{DATA_DIR}}/v2/background-tasks'
];
const pats=[
 /mmoat_[A-Za-z0-9_\-]{10,}/g,
 /mmort_[A-Za-z0-9_\-]{10,}/g,
 /sk-[A-Za-z0-9]{32}/g
];
function walk(d,acc){ let es=[]; try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return acc;}
 for(const e of es){ const p=path.join(d,e.name);
  if(e.isDirectory())walk(p,acc); else { try{const st=fs.statSync(p); if(st.size<80*1024*1024) acc.push(p);}catch{} } } return acc;}
const files=[]; for(const r of roots) walk(r,files);
let totalHits=0, redacted=0;
for(const f of files){
  let buf; try{buf=fs.readFileSync(f,'utf8')}catch{continue}
  let orig=buf;
  for(const re of pats){ buf=buf.replace(re,(m)=>{ totalHits++; return 'X'.repeat(m.length); }); }
  if(buf!==orig){ fs.writeFileSync(f,buf,'utf8'); redacted++; }
}
console.log('FILES_SCANNED='+files.length);
console.log('SECRET_MATCHES_REDACTED='+totalHits);
console.log('FILES_MODIFIED='+redacted);
'@
Set-Content -Path 'D:\Minmax\_redact.js' -Value $js -Encoding UTF8
node 'D:\Minmax\_redact.js'
"=== 复核：是否还有残留 ==="
$hit=@()
Get-ChildItem '{{DATA_DIR}}\v2' -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 50MB } | ForEach-Object {
  try { $t=[System.IO.File]::ReadAllText($_.FullName)
    foreach($m in [regex]::Matches($t,'mmoat_[A-Za-z0-9_\-]{10,}|mmort_[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9]{32}')) { $hit += [PSCustomObject]@{F=$_.FullName;N=$m.Value.Length} }
  } catch {}
}
if($hit.Count -eq 0){ "CLEAN: 0 residual secret matches in ~/.minimax/v2" } else { $hit | Group-Object F | ForEach-Object { "RESIDUAL: $($_.Name) x$($_.Count)" } }`;
/** Writes a restore script that overwrites the open database and removes its WAL. */
export const WRITE_RESTORE_SCRIPT = String.raw `$code = @'
# -*- coding: utf-8 -*-
"""一键恢复脚本 (换账号后用): 从备份还原会话历史 / 索引库 / 配置。
用法:
  python restore.py sessions   # 只还原会话正文
  python restore.py all        # 还原会话正文 + 索引库 + 配置
注意: 请先退出 RUBPM 软件 (会占用 sqlite)。
"""
import os, shutil, sys, time, json

DEST = r"D:\RUBP\backup\agent_full_20261112_1600"
HOME = r"{{DATA_DIR}}"

def lp(p):
    p = os.path.abspath(p)
    if p.startswith('\\\\'):
        return '\\\\?\\UNC\\' + p[2:]
    if p.startswith('\\\\?\\'):
        return p
    return '\\\\?\\' + p

def copy_tree(src, dst):
    src_l, dst_l = lp(src), lp(dst)
    os.makedirs(dst_l, exist_ok=True)
    n = ok = 0
    stack = [(src_l, dst_l)]
    while stack:
        s, d = stack.pop()
        try:
            entries = list(os.scandir(s))
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    t = os.path.join(d, e.name)
                    os.makedirs(t, exist_ok=True)
                    stack.append((e.path, t))
                elif e.is_file(follow_symlinks=False):
                    n += 1
                    try:
                        shutil.copy2(e.path, os.path.join(d, e.name)); ok += 1
                    except Exception:
                        pass
            except Exception:
                pass
    return n, ok

def do_sessions():
    src = os.path.join(DEST, "minimax", "v2", "sessions")
    dst = os.path.join(HOME, "v2", "sessions")
    n, ok = copy_tree(src, dst)
    print("会话正文还原: %d/%d 文件 -> %s" % (ok, n, dst))

def do_sqlite():
    src = os.path.join(DEST, "minimax", "v2", "sqlite", "runtime-state.sqlite")
    dst = os.path.join(HOME, "v2", "sqlite", "runtime-state.sqlite")
    if not os.path.isfile(src):
        print("!! 备份里没有索引库, 跳过"); return
    for ext in ("-wal", "-shm"):
        p = dst + ext
        if os.path.isfile(p):
            try: os.remove(p)
            except OSError: pass
    shutil.copy2(src, dst)
    print("索引库还原: %s (%.1f MB)" % (dst, os.path.getsize(dst)/1048576))

def do_cfg():
    src = os.path.join(DEST, "minimax")
    for f in ("config.yaml", "permission.json", "mcp.json", "mcp-runtime-names.json",
              "channel-bindings.yaml", "channel-routes.yaml"):
        s = os.path.join(src, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(HOME, f))
            print("配置还原:", f)
    a = os.path.join(src, "auth")
    if os.path.isdir(a):
        copy_tree(a, os.path.join(HOME, "auth"))
        print("凭证目录还原: auth/")

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    t0 = time.time()
    if mode in ('sessions', 'all'):
        do_sessions()
    if mode in ('sqlite', 'all'):
        do_sqlite()
    if mode in ('cfg', 'all'):
        do_cfg()
    print("完成, 用时 %.1fs" % (time.time()-t0))
'@
$path = '{{SCRIPT}}'
[System.IO.File]::WriteAllText($path, $code, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'restore.py 已写入备份根目录'; Get-ChildItem 'D:\RUBP\backup\agent_full_20261112_1600' -File | Select-Object Name,@{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize`;
/** The restore script itself, as the command above wrote it. */
export const RESTORE_SCRIPT = String.raw `# -*- coding: utf-8 -*-
"""一键恢复脚本 (换账号后用): 从备份还原会话历史 / 索引库 / 配置。
用法:
  python restore.py sessions   # 只还原会话正文
  python restore.py all        # 还原会话正文 + 索引库 + 配置
注意: 请先退出 RUBPM 软件 (会占用 sqlite)。
"""
import os, shutil, sys, time, json

DEST = r"D:\RUBP\backup\agent_full_20261112_1600"
HOME = r"{{DATA_DIR}}"

def lp(p):
    p = os.path.abspath(p)
    if p.startswith('\\\\'):
        return '\\\\?\\UNC\\' + p[2:]
    if p.startswith('\\\\?\\'):
        return p
    return '\\\\?\\' + p

def copy_tree(src, dst):
    src_l, dst_l = lp(src), lp(dst)
    os.makedirs(dst_l, exist_ok=True)
    n = ok = 0
    stack = [(src_l, dst_l)]
    while stack:
        s, d = stack.pop()
        try:
            entries = list(os.scandir(s))
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    t = os.path.join(d, e.name)
                    os.makedirs(t, exist_ok=True)
                    stack.append((e.path, t))
                elif e.is_file(follow_symlinks=False):
                    n += 1
                    try:
                        shutil.copy2(e.path, os.path.join(d, e.name)); ok += 1
                    except Exception:
                        pass
            except Exception:
                pass
    return n, ok

def do_sessions():
    src = os.path.join(DEST, "minimax", "v2", "sessions")
    dst = os.path.join(HOME, "v2", "sessions")
    n, ok = copy_tree(src, dst)
    print("会话正文还原: %d/%d 文件 -> %s" % (ok, n, dst))

def do_sqlite():
    src = os.path.join(DEST, "minimax", "v2", "sqlite", "runtime-state.sqlite")
    dst = os.path.join(HOME, "v2", "sqlite", "runtime-state.sqlite")
    if not os.path.isfile(src):
        print("!! 备份里没有索引库, 跳过"); return
    for ext in ("-wal", "-shm"):
        p = dst + ext
        if os.path.isfile(p):
            try: os.remove(p)
            except OSError: pass
    shutil.copy2(src, dst)
    print("索引库还原: %s (%.1f MB)" % (dst, os.path.getsize(dst)/1048576))

def do_cfg():
    src = os.path.join(DEST, "minimax")
    for f in ("config.yaml", "permission.json", "mcp.json", "mcp-runtime-names.json",
              "channel-bindings.yaml", "channel-routes.yaml"):
        s = os.path.join(src, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(HOME, f))
            print("配置还原:", f)
    a = os.path.join(src, "auth")
    if os.path.isdir(a):
        copy_tree(a, os.path.join(HOME, "auth"))
        print("凭证目录还原: auth/")

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    t0 = time.time()
    if mode in ('sessions', 'all'):
        do_sessions()
    if mode in ('sqlite', 'all'):
        do_sqlite()
    if mode in ('cfg', 'all'):
        do_cfg()
    print("完成, 用时 %.1fs" % (time.time()-t0))`;
/** Runs the restore script; the command names no data path itself. */
export const RUN_RESTORE_SCRIPT = String.raw `python -X utf8 -m py_compile '{{SCRIPT}}'; Write-Output "restore.py 语法检查 exit=$LASTEXITCODE"; python -X utf8 '{{SCRIPT}}' 2>&1 | Select-Object -First 3`;
export function forDataDirectory(command, dataDir, script = '') {
    return command.replaceAll('{{DATA_DIR}}', dataDir).replaceAll('{{SCRIPT}}', script);
}
//# sourceMappingURL=runtime-state.incidents.test-support.js.map