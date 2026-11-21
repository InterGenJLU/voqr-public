#!/usr/bin/env python3
"""Offline check: does every package under node_modules match the tarball the lockfile pins?

For each package-lock.json entry with an sha512 integrity:
  1. find the tarball in the local npm cache (cacache stores content by its own sha512),
  2. recompute its sha512 and compare with the lockfile,
  3. read the tarball in memory (never extracted) and compare every regular file byte for byte
     with the installed copy; list files that differ, are missing, or exist only on disk.
No network, and no npm code is run. Exit code 1 if any installed package differs, is missing
from the cache, or has no sha512 in the lockfile.

Usage: python3 scripts/package/verify-node-modules.py <project dir> <npm cache>/_cacache <report file>
"""
import base64
import hashlib
import io
import json
import os
import sys
import tarfile

project, cache, report_path = sys.argv[1], sys.argv[2], sys.argv[3]
lock = json.load(open(os.path.join(project, 'package-lock.json'), encoding='utf-8'))
pkgs = lock.get('packages', {})
out = open(report_path, 'w', encoding='utf-8', newline='\n')


def say(line=''):
    out.write(line + '\n')


say(f"lockfileVersion {lock.get('lockfileVersion')} | entries {len(pkgs)} | project {project}")
totals = {'verified_clean': 0, 'verified_with_differences': 0, 'not_installed': 0, 'not_in_cache': 0,
          'hash_mismatch': 0, 'no_integrity': 0}
problem_lines = []
for key in sorted(pkgs):
    if not key:  # the root project itself
        continue
    meta = pkgs[key]
    name_ver = f"{key[len('node_modules/'):] if key.startswith('node_modules/') else key}@{meta.get('version')}"
    flags = ','.join(f for f in ('dev', 'optional', 'devOptional') if meta.get(f)) or 'prod'
    integ = meta.get('integrity', '')
    disk = os.path.join(project, *key.split('/'))
    if not os.path.isdir(disk):
        totals['not_installed'] += 1
        say(f"NOT-INSTALLED  {name_ver} [{flags}] os={meta.get('os')} cpu={meta.get('cpu')}")
        continue
    if not integ.startswith('sha512-'):
        totals['no_integrity'] += 1
        line = f"NO-INTEGRITY   {name_ver} [{flags}] integrity={integ!r} resolved={meta.get('resolved')}"
        say(line)
        problem_lines.append(line)
        continue
    hexd = base64.b64decode(integ[len('sha512-'):]).hex()
    blob = os.path.join(cache, 'content-v2', 'sha512', hexd[:2], hexd[2:4], hexd[4:])
    if not os.path.isfile(blob):
        totals['not_in_cache'] += 1
        line = f"NOT-IN-CACHE   {name_ver} [{flags}] resolved={meta.get('resolved')}"
        say(line)
        problem_lines.append(line)
        continue
    data = open(blob, 'rb').read()
    if hashlib.sha512(data).hexdigest() != hexd:
        totals['hash_mismatch'] += 1
        line = f"HASH-MISMATCH  {name_ver} [{flags}] cache blob does not hash to the lockfile integrity"
        say(line)
        problem_lines.append(line)
        continue
    same, differ, missing, tar_files = 0, [], [], set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            parts = m.name.replace('\\', '/').split('/', 1)
            if len(parts) < 2:
                continue
            rel = parts[1]
            tar_files.add(rel)
            p = os.path.join(disk, *rel.split('/'))
            if not os.path.isfile(p):
                missing.append(rel)
                continue
            if open(p, 'rb').read() == tf.extractfile(m).read():
                same += 1
            else:
                differ.append(rel)
    extra = []
    for root, dirs, files in os.walk(disk):
        rel_root = os.path.relpath(root, disk).replace('\\', '/')
        if rel_root == 'node_modules' or rel_root.startswith('node_modules/'):
            dirs[:] = []  # nested packages are separate lockfile entries
            continue
        if 'node_modules' in dirs:
            dirs.remove('node_modules')
        for f in files:
            rel = f if rel_root == '.' else f'{rel_root}/{f}'
            if rel not in tar_files:
                extra.append(rel)
    status = 'VERIFIED' if not (differ or missing or extra) else 'DIFFERS'
    totals['verified_clean' if status == 'VERIFIED' else 'verified_with_differences'] += 1
    line = (f"{status:<14} {name_ver} [{flags}] tarball sha512 ok | files same {same}, differ {len(differ)}, "
            f"missing {len(missing)}, extra on disk {len(extra)}")
    say(line)
    if status != 'VERIFIED':
        problem_lines.append(line)
        for label, items in (('differ', differ), ('missing', missing), ('extra', extra)):
            for it in sorted(items):
                detail = f"      {label}: {it}"
                say(detail)
                problem_lines.append(detail)

say()
say('TOTALS ' + json.dumps(totals))
out.close()
print('TOTALS', json.dumps(totals))
print('\n'.join(problem_lines) if problem_lines else 'no problems')
sys.exit(1 if problem_lines else 0)
