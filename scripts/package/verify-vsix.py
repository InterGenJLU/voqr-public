#!/usr/bin/env python3
"""Read back a .vsix and prove where every byte of it came from.

Written separately from pack.py, so a fault or tampering in the packer shows up here.
Each member is matched to its declared source and compared byte for byte:
  extension/readme.md        git README at the commit; lines may differ only in link targets,
                             and only by the configured absolute bases
  extension/<file>           git <file> at the commit (after the redaction rules if text)
  extension/<built file>     the build output on disk (after the redaction rules if text)
  extension/node_modules/... the same file inside the npm tarball whose sha512 package-lock.json
                             pins, read from the local npm cache (never extracted, never run)
Also checked: no member without a declared source and no declared file missing; zip paths are
plain; the manifest's id, version, publisher and target, against the redacted package.json;
every asset it names exists; native files belong to the target only.
The deny scan reads every member, the manifest and [Content_Types].xml included, whatever its
type: its name, and its bytes as UTF-8 and as UTF-16LE at both byte alignments. The only
exceptions are those of the private file "denyExemptFile" (a pattern's key and the file
names it is allowed in); each one applied is printed. Every line printed is masked, because
a local path can hold a pattern (a home folder's name).
The redaction rules, the pattern list and the exemptions live in scripts/publish/, a folder
the public repository does not have. Where that folder is absent, the redaction and the deny
scan do not run and the output says NOT RUN; where it is present, a missing file stops this
script. With --release, a redaction or a deny scan that does not run fails the package.
Exit code 0 only if every check passes.

Usage:
  python3 scripts/package/verify-vsix.py --vsix <file.vsix> --config scripts/package/voqr-package.json \
      --npm-cache <npm cache>/_cacache [--target win32-x64] [--commit HEAD] [--release]
"""
import argparse
import base64
import fnmatch
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import traceback
import xml.etree.ElementTree as ET
import zipfile

TEXT_EXT = {'.py', '.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml', '.sh', '.css', '.html', '.mjs', '.map'}
TEXT_NAMES = {'LICENSE', '.gitignore', '.vscodeignore'}
TARGETS = {'win32-x64': ('win32', 'x64'), 'win32-arm64': ('win32', 'arm64'), 'linux-x64': ('linux', 'x64'),
           'linux-arm64': ('linux', 'arm64'), 'darwin-x64': ('darwin', 'x64'), 'darwin-arm64': ('darwin', 'arm64')}
NS = '{http://schemas.microsoft.com/developer/vsx-schema/2011}'
DECODINGS = (('utf-8', lambda b: b.decode('utf-8', 'replace')),
             ('utf-16le', lambda b: b.decode('utf-16-le', 'replace')),
             ('utf-16le, odd offset', lambda b: b[1:].decode('utf-16-le', 'replace')))


def key_of(pattern):
    return hashlib.sha256(pattern.encode('utf-8')).hexdigest()[:16]


class Mask:
    """Every pattern in a printed line becomes [pattern <key>]."""

    def __init__(self, patterns):
        self.keyed = [(p, key_of(p)) for p in patterns]

    def __call__(self, text):
        lines = []
        for line in str(text).split('\n'):
            for p, k in self.keyed:
                line = re.sub(re.escape(p), f'[pattern {k}]', line, flags=re.IGNORECASE)
            if any(p.casefold() in line.casefold() for p, _ in self.keyed):
                line = '[withheld: the line holds a deny pattern]'
            lines.append(line)
        return '\n'.join(lines)


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True).stdout


def is_text(name):
    base = name.rsplit('/', 1)[-1]
    return os.path.splitext(base)[1].lower() in TEXT_EXT or base in TEXT_NAMES


def read_patterns(path):
    return [l.strip() for l in open(path, encoding='utf-8') if l.strip() and not l.lstrip().startswith('#')]


def private_file(repo, cfg, field, mask):
    """(path, None) for the file a config field names, or (None, why) when the step it serves cannot
    run. Those files live in scripts/publish/, which publish.sh never copies, so a public clone has
    none of them. A file missing while its folder is present stops this script."""
    if not cfg.get(field):
        return None, f'the config names no file ("{field}")'
    path = os.path.join(repo, cfg[field])
    if os.path.isfile(path):
        return path, None
    if os.path.isdir(os.path.dirname(path)):
        sys.exit(mask(f'verify-vsix.py: {cfg[field]} ("{field}") is missing, while its folder is present'))
    return None, f'{cfg[field]} is absent, and so is its folder (as in the public repository)'


def beside_patterns():
    """The pattern list beside this script (absent in the public repository): it masks what is
    printed before the config is read, a traceback included."""
    try:
        return read_patterns(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'publish',
                                          'verify_patterns.txt'))
    except OSError:
        return []


def main():
    mask = Mask(beside_patterns())
    try:
        verify(mask)
    except SystemExit:
        raise
    except BaseException:  # a traceback can hold a local path: it is printed masked, like every other line
        sys.exit(mask('verify-vsix.py: stopped by an error\n' + traceback.format_exc()))


def verify(mask):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--vsix', required=True)
    ap.add_argument('--config', required=True)
    ap.add_argument('--npm-cache', required=True)
    ap.add_argument('--target', choices=sorted(TARGETS))
    ap.add_argument('--commit', default='HEAD')
    ap.add_argument('--release', action='store_true',
                    help='fail the package unless the redaction rules and a pattern list holding patterns were read')
    a = ap.parse_args()

    repo = git(os.path.dirname(os.path.abspath(a.config)), 'rev-parse', '--show-toplevel').decode().strip()
    commit = git(repo, 'rev-parse', a.commit).decode().strip()
    cfg = json.load(open(a.config, encoding='utf-8'))
    root = cfg.get('extensionRoot', '.')
    redact_path, redact_why = private_file(repo, cfg, 'redact', mask)
    deny_path, deny_why = private_file(repo, cfg, 'deny', mask)
    rules = []
    if redact_path:
        for line in open(redact_path, encoding='utf-8'):
            line = line.rstrip('\r\n')
            if line.strip() and not line.lstrip().startswith('#') and '|||' in line:
                p, r = line.split('|||', 1)
                if p and r and p != r:
                    rules.append((p, r))
    deny = read_patterns(deny_path) if deny_path else []
    if deny_path and not deny:
        deny_why = f'{cfg["deny"]} holds no pattern'
    beside = [p for p, _ in mask.keyed]
    mask = Mask(deny + [p for p in beside if p not in deny])  # the scan reads deny; the mask covers both
    if cfg.get('denyExempt'):
        sys.exit(mask('verify-vsix.py: the config carries exemptions ("denyExempt"); they belong in the private '
                      'file "denyExemptFile" names: a key can be recovered by guessing, and the config is public'))
    exempt = {}
    exempt_path, _ = private_file(repo, cfg, 'denyExemptFile', mask)
    if exempt_path:
        with open(exempt_path, encoding='utf-8') as fh:
            exempt = json.load(fh).get('exempt', {})

    def red(data):
        text = data.decode('utf-8')
        for p, r in rules:
            text = text.replace(p, r)
        return text.encode('utf-8')

    def tracked(path):
        return git(repo, 'show', f'{commit}:{os.path.normpath(os.path.join(root, path)).replace(os.sep, "/")}')

    problems, rows = [], []
    if a.release:
        problems += [f'release check: the redaction did not run: {redact_why}'] if not redact_path else []
        problems += [f'release check: the deny scan did not run: {deny_why}'] if not deny else []
    z = zipfile.ZipFile(a.vsix)
    bad = z.testzip()
    if bad:
        problems.append(f'zip CRC error in {bad}')
    names = [i.filename for i in z.infolist()]
    if len(names) != len(set(names)):
        problems.append('duplicate zip entries')
    for n in names:
        if n.startswith('/') or '\\' in n or '..' in n.split('/'):
            problems.append(f'unsafe zip path {n!r}')
        elif n not in ('extension.vsixmanifest', '[Content_Types].xml') and not n.startswith('extension/'):
            problems.append(f'member outside extension/: {n}')

    # Declared sources.
    expected = {}  # member -> (expected bytes or None for module files, note)
    if cfg.get('readme'):
        expected['extension/readme.md'] = ('readme', cfg['readme']['src'])
    for f in cfg.get('files', []):
        expected[f'extension/{f.get("dst", f["src"])}'] = ('file', f['src'])
    for b in cfg.get('built', []):
        expected[f'extension/{b}'] = ('built', b)
    modules = {m['name']: m for m in cfg.get('modules', [])}
    for m in expected:
        if m not in names:
            problems.append(f'declared member missing: {m}')

    lock = None  # read only when a module file has to be checked
    tar_cache = {}

    def tarball(mod):
        nonlocal lock
        if lock is None:
            lock = json.load(open(os.path.join(repo, root, 'package-lock.json'), encoding='utf-8')).get('packages', {})
        if mod not in tar_cache:
            entry = lock.get(f'node_modules/{mod}')
            if not entry or not entry.get('integrity', '').startswith('sha512-'):
                raise ValueError(f'no sha512 integrity for {mod} in package-lock.json')
            hexd = base64.b64decode(entry['integrity'][7:]).hex()
            blob = os.path.join(a.npm_cache, 'content-v2', 'sha512', hexd[:2], hexd[2:4], hexd[4:])
            data = open(blob, 'rb').read()
            if hashlib.sha512(data).hexdigest() != hexd:
                raise ValueError(f'cache blob for {mod} does not match the lockfile sha512')
            files = {}
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tf:
                for t in tf.getmembers():
                    if t.isfile() and '/' in t.name:
                        files[t.name.split('/', 1)[1]] = tf.extractfile(t).read()
            tar_cache[mod] = (entry.get('version'), files)
        return tar_cache[mod]

    for n in names:
        if n in ('extension.vsixmanifest', '[Content_Types].xml'):
            continue
        data = z.read(n)
        sha = hashlib.sha256(data).hexdigest()
        verdict, source = 'OK', ''
        try:
            if n in expected:
                kind, src = expected[n]
                source = f'{kind} {src}'
                if kind == 'readme':
                    want = red(tracked(src)).decode('utf-8').splitlines()
                    got = data.decode('utf-8').splitlines()
                    bases = (cfg['readme']['linkBase'], cfg['readme']['imageBase'])
                    if len(want) != len(got):
                        verdict = 'DIFFERS (line count)'
                    for w, g in zip(want, got):
                        if w != g:
                            g2 = g
                            for base in bases:
                                g2 = g2.replace('](' + base, '](')
                            if g2 != re.sub(r'\]\(\./', '](', w):
                                verdict = 'DIFFERS (beyond link targets)'
                elif kind == 'file':
                    blob = tracked(src)
                    if data != (red(blob) if is_text(n) else blob):
                        verdict = 'DIFFERS'
                else:
                    disk = open(os.path.join(repo, root, *src.split('/')), 'rb').read()
                    if data != (red(disk) if is_text(n) else disk):
                        verdict = 'DIFFERS'
            elif n.startswith('extension/node_modules/'):
                rest = n[len('extension/node_modules/'):]
                mod = next((m for m in sorted(modules, key=len, reverse=True) if rest.startswith(m + '/')), None)
                if mod is None:
                    verdict = 'NO DECLARED SOURCE'
                else:
                    rel = rest[len(mod) + 1:]
                    version, files = tarball(mod)
                    source = f'npm {mod}@{version} tarball'
                    if rel not in files:
                        verdict = 'NOT IN TARBALL'
                    elif files[rel] != data:
                        verdict = 'DIFFERS FROM TARBALL'
                    native = modules[mod].get('native')
                    if native and fnmatch.fnmatchcase(rel, native['all']):
                        if not a.target:
                            verdict = 'NATIVE FILE WITHOUT TARGET'
                        else:
                            plat, arch = TARGETS[a.target]
                            keep = native['dir'].format(platform=plat, arch=arch)
                            if not rel.startswith(keep) or rel.rsplit('/', 1)[-1] in native.get('omit', {}).get(plat, []):
                                verdict = f'NATIVE FILE NOT FOR {a.target}'
            else:
                verdict = 'NO DECLARED SOURCE'
        except Exception as e:  # report, never hide
            verdict = f'ERROR {e}'
        rows.append(f'{verdict:<12} {len(data):>10} {sha}  {n}  <- {source}')
        if verdict != 'OK':
            problems.append(f'{n}: {verdict}')

    # Deny scan: every member, the two generated ones included, whatever its type. A name is never exempted.
    applied = {}  # (member, key) -> [count, [decodings]]
    folded = [(p.casefold(), key_of(p)) for p in deny]
    for n in names:
        data = z.read(n)
        base = n.rsplit('/', 1)[-1]
        problems += [f'{n} (member name): pattern {k}' for p, k in folded if p in n.casefold()]
        for label, decode in DECODINGS:
            low = decode(data).casefold()
            for p, k in folded:
                count = low.count(p)
                if count and base in exempt.get(k, []):
                    entry = applied.setdefault((n, k), [0, []])
                    entry[0] += count
                    entry[1].append(label)
                elif count:
                    problems.append(f'{n} ({label}): pattern {k}')

    # Manifest, against the package.json that ships: pack.py writes the manifest from the redacted copy.
    pkg = json.loads(red(tracked('package.json')))
    try:
        man = ET.fromstring(z.read('extension.vsixmanifest'))
        ident = man.find(f'{NS}Metadata/{NS}Identity')
        for attr, want in (('Id', pkg['name']), ('Version', pkg['version']), ('Publisher', pkg['publisher'])):
            if ident.get(attr) != want:
                problems.append(f'manifest Identity {attr}={ident.get(attr)!r}, package.json says {want!r}')
        if ident.get('TargetPlatform') != a.target:
            problems.append(f'manifest TargetPlatform={ident.get("TargetPlatform")!r}, expected {a.target!r}')
        for asset in man.iter(f'{NS}Asset'):
            if asset.get('Path') not in names:
                problems.append(f'manifest asset {asset.get("Path")} is not in the package')
        ET.fromstring(z.read('[Content_Types].xml'))
    except Exception as e:
        problems.append(f'manifest unreadable: {e}')

    print(mask(f'vsix {a.vsix}\nsha256 {hashlib.sha256(open(a.vsix, "rb").read()).hexdigest()} | commit {commit} | '
               f'target {a.target} | members {len(names)}'))
    print(mask('\n'.join(rows)))
    print(mask(f'redaction: {len(rules)} rule(s) from {cfg["redact"]}' if redact_path
               else f'redaction: NOT RUN: {redact_why}'))
    scope = (f'{len(deny)} patterns, all {len(names)} members (each name, and its bytes as UTF-8 and as UTF-16LE at '
             f'both alignments)' if deny else f'NOT RUN: {deny_why}')
    print(mask(f'deny scan: {scope}; {len(applied)} exemption(s) applied'))
    for (n, k), (count, labels) in sorted(applied.items()):
        print(mask(f'  exempted: {n}: pattern {k}, {count} occurrence(s) ({", ".join(labels)}), allowed in files '
                   f'named {n.rsplit("/", 1)[-1]} by {cfg["denyExemptFile"]}'))
    if problems:
        print(mask(f'\nFAILED: {len(problems)} problem(s)\n  ' + '\n  '.join(problems)))
        sys.exit(1)
    print(f'\nPASSED: every member traced to its source ({len(rows)} files); the manifest checked; deny scan '
          + (f'clean over all {len(names)} members, {len(applied)} exemption(s) printed above' if deny else 'NOT RUN'))


if __name__ == '__main__':
    main()
