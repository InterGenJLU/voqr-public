#!/usr/bin/env python3
"""Build a VS Code extension package (.vsix) from an explicit list of files.

Python standard library only. No network access, and no third-party code is run.
What goes into the package, and from where:
  * "files": tracked files, read from a git commit (never from uncommitted edits);
  * "built": build outputs named one by one (for example dist/extension.js);
  * "modules": runtime npm modules copied from node_modules. A module's native parts
    are taken for the requested --target platform only.
Project text files pass through the redaction rules ("redact"), and the manifest
(extension.vsixmanifest) is written from the redacted package.json.
Before anything is written, every member of the package, the manifest and
[Content_Types].xml included, is scanned for the deny patterns ("deny": fixed strings, in
any letter case), whatever the member's type: its name, and its bytes read as UTF-8 and as
UTF-16LE at both byte alignments. A hit stops the build and nothing is written. The only
exceptions are those of "denyExemptFile": a pattern's key (the first 16 hex digits of its
sha256) and the file names it is allowed in. That file stays beside the pattern list,
outside the public repository, because a short pattern can be recovered from its key by
guessing. Each exemption applied is printed with its count. Every line printed is masked,
because a local path can hold a pattern (a home folder's name).
The redaction rules, the pattern list and the exemptions live in scripts/publish/, a folder
the public repository does not have. Where that folder is absent, the redaction and the deny
scan do not run and the output says NOT RUN; where it is present, a missing file stops the
build.
The package layout follows the one vsce produced for VOQR 0.2.0.

Usage:
  python3 scripts/package/pack.py --config scripts/package/voqr-package.json \
      --out <folder outside the tree>/voqr-<version>-<target>.vsix --target win32-x64
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import traceback
import zipfile
import zlib
from xml.sax.saxutils import escape

TARGETS = {
    'win32-x64': ('win32', 'x64'), 'win32-arm64': ('win32', 'arm64'),
    'linux-x64': ('linux', 'x64'), 'linux-arm64': ('linux', 'arm64'),
    'darwin-x64': ('darwin', 'x64'), 'darwin-arm64': ('darwin', 'arm64'),
}
# Same set publish.sh treats as text, plus source maps.
TEXT_EXT = {'.py', '.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml', '.sh', '.css', '.html', '.mjs', '.map'}
TEXT_NAMES = {'LICENSE', '.gitignore', '.vscodeignore'}
MIME = {'.css': 'text/css', '.gif': 'image/gif', '.js': 'application/javascript', '.json': 'application/json',
        '.map': 'application/json', '.md': 'text/markdown', '.mjs': 'application/javascript', '.png': 'image/png',
        '.txt': 'text/plain', '.vsixmanifest': 'text/xml', '.wasm': 'application/wasm'}
# package.json contribution points this packer knows how to describe. vsce derives gallery
# tags from some others (themes, snippets, languages ...); stop rather than guess.
KNOWN_CONTRIBUTES = {'commands', 'keybindings', 'configuration'}
# Every entry gets the same time, so equal inputs give an equal file when built with the same
# zlib. Python builds differ (3.14 on Windows ships zlib-ng): the output names the one used.
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
# How the deny scan reads a member's bytes.
DECODINGS = (('utf-8', lambda b: b.decode('utf-8', 'replace')),
             ('utf-16le', lambda b: b.decode('utf-16-le', 'replace')),
             ('utf-16le, odd offset', lambda b: b[1:].decode('utf-16-le', 'replace')))


def say(text):
    print(_deny.mask_lines(text))


def fail(msg):
    sys.exit(_deny.mask_lines(f'pack.py: {msg}'))


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True).stdout


def is_text(path):
    base = path.rsplit('/', 1)[-1]
    return os.path.splitext(base)[1].lower() in TEXT_EXT or base in TEXT_NAMES


def load_redactions(path):
    rules = []
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\r\n')
        if not line.strip() or line.lstrip().startswith('#') or '|||' not in line:
            continue
        pattern, replacement = line.split('|||', 1)
        if pattern and replacement and pattern != replacement:
            rules.append((pattern, replacement))
    return rules


def load_deny(path):
    return [l.strip() for l in open(path, encoding='utf-8') if l.strip() and not l.lstrip().startswith('#')]


def private_file(repo, cfg, field):
    """(path, None) for the file a config field names, or (None, why) when the step it serves cannot
    run. The redaction rules, the pattern list and the exemptions live in scripts/publish/, which
    publish.sh never copies, so a public clone has none of them: there the step is skipped and the
    output says so. A file missing while its folder is present stops the build."""
    if not cfg.get(field):
        return None, f'the config names no file ("{field}")'
    path = os.path.join(repo, cfg[field])
    if os.path.isfile(path):
        return path, None
    if os.path.isdir(os.path.dirname(path)):
        fail(f'{cfg[field]} ("{field}") is missing, while its folder is present')
    return None, f'{cfg[field]} is absent, and so is its folder (as in the public repository)'


def pattern_key(pattern):
    """First 16 hex digits of the pattern's sha256: how the exemptions and the output name a pattern."""
    return hashlib.sha256(pattern.encode('utf-8')).hexdigest()[:16]


class Deny:
    """The deny scan, and the mask on every line this script prints."""

    def __init__(self, patterns, exempt, also_mask=()):
        self.plain = [(p, pattern_key(p)) for p in patterns]
        self.folded = [(p.casefold(), k) for p, k in self.plain]
        self.exempt = exempt  # {pattern key: [file names]}
        self.masked = self.plain + [(p, pattern_key(p)) for p in also_mask if p not in patterns]

    def mask(self, line):
        out = line
        for p, k in self.masked:
            out = re.sub(re.escape(p), f'[pattern {k}]', out, flags=re.IGNORECASE)
        low = out.casefold()
        return '[withheld: the line holds a deny pattern]' if any(p.casefold() in low for p, _ in self.masked) else out

    def mask_lines(self, text):
        return '\n'.join(self.mask(line) for line in text.split('\n'))

    def scan(self, name, data):
        """One member: hits as (place, key), and the exemptions applied as {key: (count, decodings)}.
        A name is never exempted."""
        shown, base = self.mask(name), name.rsplit('/', 1)[-1]
        low = name.casefold()
        hits = [(f'{shown} (member name)', k) for p, k in self.folded if p in low]
        exempted = {}
        for label, decode in DECODINGS:
            low = decode(data).casefold()
            for p, k in self.folded:
                n = low.count(p)
                if not n:
                    continue
                if base in self.exempt.get(k, []):
                    count, labels = exempted.get(k, (0, []))
                    exempted[k] = (count + n, labels + [label])
                else:
                    hits.append((f'{shown} ({label})', k))
        return hits, exempted


_deny = Deny([], {})  # replaced as soon as a pattern list is read


def use(deny):
    global _deny
    _deny = deny


def early_patterns():
    """The pattern list beside this script, read before the config so that an early error, which can
    print a local path, is masked too. Absent in the public repository."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'publish', 'verify_patterns.txt')
    try:
        return load_deny(path)
    except OSError:
        return []


def load_exempt(repo, cfg):
    """{pattern key: [file names]} from the file "denyExemptFile" names. A key of a short pattern can
    be recovered by guessing, so the keys stay beside the pattern list, never in this public config."""
    if cfg.get('denyExempt'):
        fail('the config carries exemptions ("denyExempt"); move them to the private file "denyExemptFile" '
             'names: a key can be recovered by guessing, and this config is copied to the public repository')
    path, _ = private_file(repo, cfg, 'denyExemptFile')
    if not path:
        return {}
    with open(path, encoding='utf-8') as fh:
        exempt = json.load(fh).get('exempt', {})
    if not all(re.fullmatch(r'[0-9a-f]{16}', k) and isinstance(v, list) for k, v in exempt.items()):
        fail(f'{cfg["denyExemptFile"]}: "exempt" must map 16-hex-digit pattern keys to lists of file names')
    return exempt


def redact(data, rules):
    text = data.decode('utf-8')
    for pattern, replacement in rules:
        text = text.replace(pattern, replacement)
    return text.encode('utf-8')


LINK = re.compile(r'(!?)\[([^\]]*)\]\(([^)\s]+)\)')


def rewrite_readme(data, link_base, image_base):
    """Relative markdown links and images become absolute, as vsce did for 0.2.0."""
    def sub(m):
        bang, label, url = m.groups()
        if re.match(r'^(?:[a-z][a-z0-9+.-]*:|#|/)', url, re.I):
            return m.group(0)
        url = url[2:] if url.startswith('./') else url
        return f'{bang}[{label}]({image_base if bang else link_base}{url})'
    return LINK.sub(sub, data.decode('utf-8')).encode('utf-8')


def manifest_xml(pkg, target, members):
    unknown = set(pkg.get('contributes', {})) - KNOWN_CONTRIBUTES
    for key in ('extensionDependencies', 'extensionPack', 'extensionKind', 'browser', 'pricing', 'preview',
                'sponsor', 'enabledApiProposals', 'l10n'):
        if pkg.get(key):
            unknown.add(key)
    if unknown:
        fail(f'package.json uses {sorted(unknown)}, which this packer does not describe; extend it first')
    tags = list(pkg.get('keywords', []))
    if pkg.get('contributes', {}).get('keybindings'):
        tags.append('keybindings')
    props = [
        ('Microsoft.VisualStudio.Code.Engine', pkg['engines']['vscode']),
        ('Microsoft.VisualStudio.Code.ExtensionDependencies', ''),
        ('Microsoft.VisualStudio.Code.ExtensionPack', ''),
        ('Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'),
        ('Microsoft.VisualStudio.Code.LocalizedLanguages', ''),
        ('Microsoft.VisualStudio.Code.EnabledApiProposals', ''),
    ]
    lines = [f'\t\t\t\t<Property Id="{k}" Value="{escape(v, {chr(34): "&quot;"})}" />' for k, v in props]
    lines.append('\t\t\t\t')
    if pkg.get('main'):
        lines.append('\t\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />')
    lines.append('\t\t\t\t')
    repo = (pkg.get('repository') or {}).get('url', '') if isinstance(pkg.get('repository'), dict) else pkg.get('repository', '')
    if repo:
        repo = repo[:-4] if repo.endswith('.git') else repo
        for kind in ('Source', 'Getstarted', 'GitHub'):
            lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.{kind}" Value="{escape(repo)}.git" />')
    if (pkg.get('bugs') or {}).get('url'):
        lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{escape(pkg["bugs"]["url"])}" />')
    if repo:
        lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{escape(repo)}#readme" />')
    banner = pkg.get('galleryBanner') or {}
    if banner.get('color'):
        lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="{escape(banner["color"])}" />')
    if banner.get('theme'):
        lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="{escape(banner["theme"])}" />')
    lines.append('\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />')
    lines.append('\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>')
    lines.append('\n\t\t\t\t')
    if pkg.get('qna'):
        lines.append(f'\t\t\t\t<Property Id="Microsoft.VisualStudio.Services.CustomerQnALink" Value="{escape(pkg["qna"])}" />')
    target_attr = f' TargetPlatform="{target}"' if target else ''
    assets = [('Microsoft.VisualStudio.Code.Manifest', 'extension/package.json')]
    for kind, path in (('Microsoft.VisualStudio.Services.Content.Details', 'extension/readme.md'),
                       ('Microsoft.VisualStudio.Services.Content.Changelog', 'extension/changelog.md'),
                       ('Microsoft.VisualStudio.Services.Content.License', 'extension/LICENSE.txt')):
        if path in members:
            assets.append((kind, path))
    icon = f'extension/{pkg["icon"]}' if pkg.get('icon') else None
    if icon:
        if icon not in members:
            fail(f'package.json names icon {pkg["icon"]} but it is not in the file list')
        assets.append(('Microsoft.VisualStudio.Services.Icons.Default', icon))
    meta_tail = ''
    if 'extension/LICENSE.txt' in members:
        meta_tail += '\t\t\t<License>extension/LICENSE.txt</License>\n'
    if icon:
        meta_tail += f'\t\t\t<Icon>{escape(icon)}</Icon>\n'
    asset_lines = '\n'.join(f'<Asset Type="{t}" Path="{escape(p)}" Addressable="true" />' for t, p in assets)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '\t<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" '
            'xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">\n'
            '\t\t<Metadata>\n'
            f'\t\t\t<Identity Language="en-US" Id="{escape(pkg["name"])}" Version="{escape(pkg["version"])}" '
            f'Publisher="{escape(pkg["publisher"])}"{target_attr} />\n'
            f'\t\t\t<DisplayName>{escape(pkg.get("displayName", pkg["name"]))}</DisplayName>\n'
            f'\t\t\t<Description xml:space="preserve">{escape(pkg.get("description", ""))}</Description>\n'
            f'\t\t\t<Tags>{escape(",".join(tags))}</Tags>\n'
            f'\t\t\t<Categories>{escape(",".join(pkg.get("categories", [])))}</Categories>\n'
            '\t\t\t<GalleryFlags>Public</GalleryFlags>\n'
            '\t\t\t\n'
            '\t\t\t<Properties>\n' + '\n'.join(lines) + '\n'
            '\t\t\t</Properties>\n' + meta_tail +
            '\t\t</Metadata>\n'
            '\t\t<Installation>\n'
            '\t\t\t<InstallationTarget Id="Microsoft.VisualStudio.Code"/>\n'
            '\t\t</Installation>\n'
            '\t\t<Dependencies/>\n'
            '\t\t<Assets>\n' + asset_lines + '\n'
            '\t\t</Assets>\n'
            '\t</PackageManifest>\n').encode('utf-8')


def content_types_xml(names):
    exts = {'.vsixmanifest': 'text/xml', '.json': 'application/json'}
    for n in names:
        ext = os.path.splitext(n.rsplit('/', 1)[-1])[1].lower()
        if ext:
            exts[ext] = MIME.get(ext, 'application/octet-stream')
    body = ''.join(f'<Default Extension="{e}" ContentType="{t}"/>' for e, t in sorted(exts.items()))
    return ('<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/'
            f'content-types">{body}</Types>').encode('utf-8')


def module_files(repo, root, mod, target):
    base = os.path.join(repo, root, 'node_modules', *mod['name'].split('/'))
    if not os.path.isdir(base):
        fail(f'module {mod["name"]} is not installed under node_modules')
    native = mod.get('native')
    if native and not target:
        fail(f'module {mod["name"]} has native parts: give --target')
    if native:
        plat, arch = TARGETS[target]
        keep_dir = native['dir'].format(platform=plat, arch=arch)
        omit = set(native.get('omit', {}).get(plat, []))
    out, have_native = [], False
    for dirpath, dirs, files in os.walk(base):
        rel_dir = os.path.relpath(dirpath, base).replace('\\', '/')
        if rel_dir == 'node_modules' or rel_dir.startswith('node_modules/'):
            dirs[:] = []
            continue
        for f in files:
            rel = f if rel_dir == '.' else f'{rel_dir}/{f}'
            if any(fnmatch.fnmatchcase(rel, p) for p in mod.get('exclude', [])):
                continue
            if native and fnmatch.fnmatchcase(rel, native['all']):
                if not rel.startswith(keep_dir) or f in omit:
                    continue
                have_native = True
            out.append((rel, os.path.join(dirpath, f)))
    if native and not have_native:
        fail(f'module {mod["name"]} has no native files for {target} under {keep_dir}')
    return out


def build():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--target', choices=sorted(TARGETS))
    ap.add_argument('--commit', default='HEAD')
    a = ap.parse_args()

    repo = git(os.path.dirname(os.path.abspath(a.config)), 'rev-parse', '--show-toplevel').decode().strip()
    cfg = json.load(open(a.config, encoding='utf-8'))
    root = cfg.get('extensionRoot', '.')
    out_abs = os.path.abspath(a.out)
    if os.path.commonpath([out_abs, os.path.abspath(repo)]) == os.path.abspath(repo):
        fail('--out must be outside the working tree (publish.sh copies the working tree)')
    if git(repo, 'status', '--porcelain', '--untracked-files=no').strip():
        fail('tracked files have uncommitted changes; a package is built from a commit')
    commit = git(repo, 'rev-parse', a.commit).decode().strip()
    redact_path, redact_why = private_file(repo, cfg, 'redact')
    deny_path, deny_why = private_file(repo, cfg, 'deny')
    rules = load_redactions(redact_path) if redact_path else []
    deny = load_deny(deny_path) if deny_path else []
    if deny_path and not deny:
        deny_why = f'{cfg["deny"]} holds no pattern'
    early = early_patterns()
    use(Deny(deny, {}, also_mask=early))  # masks what load_exempt may print
    use(Deny(deny, load_exempt(repo, cfg), also_mask=early))

    def tracked(path):
        return git(repo, 'show', f'{commit}:{os.path.normpath(os.path.join(root, path)).replace(os.sep, "/")}')

    members = {}  # zip name -> (bytes, source note)

    def add(name, data, note):
        if name in members:
            fail(f'{name} is listed twice')
        members[name] = (data, note)

    if cfg.get('readme'):
        r = cfg['readme']
        data = rewrite_readme(tracked(r['src']), r['linkBase'], r['imageBase'])
        add('extension/readme.md', redact(data, rules), f'git {r["src"]} (links made absolute, redacted)')
    for f in cfg.get('files', []):
        dst = f.get('dst', f['src'])
        data = tracked(f['src'])
        if is_text(dst):
            data, note = redact(data, rules), f'git {f["src"]} (redacted)'
        else:
            note = f'git {f["src"]}'
        add(f'extension/{dst}', data, note)
    for b in cfg.get('built', []):
        p = os.path.join(repo, root, *b.split('/'))
        if not os.path.isfile(p):
            fail(f'build output {b} is missing; run the build first')
        data = open(p, 'rb').read()
        add(f'extension/{b}', redact(data, rules) if is_text(b) else data, f'build {b}' + (' (redacted)' if is_text(b) else ''))
    for mod in cfg.get('modules', []):
        for rel, path in module_files(repo, root, mod, a.target):
            add(f'extension/node_modules/{mod["name"]}/{rel}', open(path, 'rb').read(), f'module {mod["name"]}')

    # The manifest describes the package.json that ships, so it is written from the redacted copy.
    if 'extension/package.json' not in members:
        fail('package.json is not in the file list; the manifest is written from it')
    pkg = json.loads(members['extension/package.json'][0])
    manifest = manifest_xml(pkg, a.target, members)
    names = ['extension.vsixmanifest', '[Content_Types].xml'] + sorted(members)
    content = {'extension.vsixmanifest': manifest, '[Content_Types].xml': content_types_xml(names)}
    content.update((name, data) for name, (data, _) in members.items())

    # Every member, the two generated ones included, before anything is written.
    hits, applied = [], []
    for name in names:
        found, exempted = _deny.scan(name, content[name])
        hits += found
        applied += [(name, k, n, labels) for k, (n, labels) in sorted(exempted.items())]
    if hits:
        fail('deny patterns found, nothing written:\n' + '\n'.join(f'  {place}: pattern {k}' for place, k in hits))
    say(f'redaction: {len(rules)} rule(s) from {cfg["redact"]}' if redact_path else f'redaction: NOT RUN: {redact_why}')
    if deny:
        say(f'deny scan: {len(_deny.plain)} patterns, all {len(names)} members (each name, and its bytes as UTF-8 and '
            f'as UTF-16LE at both alignments): no hit outside the exemptions; {len(applied)} exemption(s) applied')
    else:
        say(f'deny scan: NOT RUN: {deny_why}')
    for name, k, n, labels in applied:
        say(f'  exempted: {name}: pattern {k}, {n} occurrence(s) ({", ".join(labels)}), allowed in files named '
            f'{name.rsplit("/", 1)[-1]} by {cfg["denyExemptFile"]}')

    os.makedirs(os.path.dirname(out_abs) or '.', exist_ok=True)
    tmp = out_abs + '.partial'
    with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name in names:
            zi = zipfile.ZipInfo(name, FIXED_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            # The level must be given here: ZipFile's own compresslevel does not reach ZipInfo entries.
            z.writestr(zi, content[name], compresslevel=9)
    os.replace(tmp, out_abs)
    builder = f'python {sys.version.split()[0]} | zlib {zlib.ZLIB_RUNTIME_VERSION}'

    listing = out_abs + '.files.txt'
    with open(listing, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(f'package {os.path.basename(out_abs)} | commit {commit} | target {a.target or "none"} | {builder}\n')
        for name in sorted(members):
            data, note = members[name]
            fh.write(f'{hashlib.sha256(data).hexdigest()}  {len(data):>10}  {name}  <- {note}\n')
    total = sum(len(d) for d, _ in members.values())
    digest = hashlib.sha256(open(out_abs, 'rb').read()).hexdigest()
    say(f'wrote {out_abs}\n  commit {commit} | target {a.target or "none"} | members {len(names)} | '
        f'uncompressed {total} bytes | file {os.path.getsize(out_abs)} bytes\n  sha256 {digest}\n  {builder}\n  listing {listing}')


def main():
    use(Deny(early_patterns(), {}))
    try:
        build()
    except SystemExit:
        raise
    except BaseException:  # a traceback can hold a local path: it is printed masked, like every other line
        sys.exit(_deny.mask_lines('pack.py: stopped by an error\n' + traceback.format_exc()))


if __name__ == '__main__':
    main()
