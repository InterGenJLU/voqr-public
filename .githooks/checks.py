"""Commit checks for this repository, run by .githooks/pre-commit and .githooks/commit-msg.

Setup, once per clone:  git config core.hooksPath .githooks
The hooks run:          python -I .githooks/checks.py pre-commit
                        python -I .githooks/checks.py commit-msg <message file>
Python 3.8 or newer, standard library only. Nothing is written. Exit 0 when every check
passes; 1 when a check fails or cannot run, with the fix named.

pre-commit reads what the commit adds (git diff --cached -M) to the files that
scripts/publish/publish.sh would copy to the public repository. Its rsync --exclude list
decides which files those are; staged paths it excludes are listed as not scanned.
  control  Before the scan, every deny pattern is planted in a text line, in a path name and
           in three binary encodings, and an email-shaped string in text and in a binary;
           each planting must be found, and each exemption must hold only for its file name.
  deny     The patterns of scripts/publish/verify_patterns.txt (fixed strings, any letter
           case; the union of its working-tree, staged and HEAD versions) in every added
           line, in every new path name, and in the whole of every changed binary blob, read
           as UTF-8 and as UTF-16LE at both byte alignments. A file that enters the public
           set with this commit (renamed or copied from an excluded path, or released by a
           change to the exclude list) is read whole. No redaction is applied, so this is
           stricter than publish.sh. The only exemptions are publish.sh's own (one pattern in
           files of one name); each one applied is printed.
  email    Email-shaped strings (publish.sh's expression) in the same text, except those
           its allow list passes.
  tsc, eslint  When the commit touches src/, tsconfig.json, eslint.config.mjs, package.json
           or package-lock.json: the project's type check, and ESLint on the staged
           src/**/*.ts files (all of src/ when one of those configuration files changed).
           Both read the working tree, so they refuse to run while those inputs have
           unstaged changes or src/ holds untracked or ignored files.
  python   Every staged .py file compiles under this Python, without warnings.
commit-msg reads the message for the same patterns and email shapes: every line, except the
verbose diff git places below a scissors line and cuts off itself.

A hit is named by its place (file:line, path name, binary encoding, message line) and the
first 16 hex digits of the pattern's sha256 (of the address's, for an email shape). Every
line printed has each pattern and email shape in it masked: a tool's install path, git's
messages and tracebacks can hold one (a home folder's name) as well as the repository.
In the public repository, which has neither the pattern list nor the publish script, the
deny and email scans do not run, and the output says so.
Not covered: commits made with --no-verify; the content of merges git completes by itself
(they run pre-merge-commit, which is not set here); rebases and cherry-picks. The publish
step checks the whole copy again.
"""
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import traceback
import warnings

PATTERNS = 'scripts/publish/verify_patterns.txt'
PUBLISH = 'scripts/publish/publish.sh'
LINT_CONFIG = ('tsconfig.json', 'eslint.config.mjs', 'package.json', 'package-lock.json')
CUT_LINE = re.compile(r'\S+ -{24} >8 -{24}')
TOOL_TIMEOUT = 600  # seconds, for each external program
MARGIN = ' ' * 20


class Refused(Exception):
    """A check cannot run; the message names the cause."""


class Result:
    def __init__(self, name, status, summary, details=(), fix=None):
        self.name, self.status, self.summary = name, status, summary
        self.details, self.fix = list(details), fix


def run(args, env=None):
    try:
        return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                              timeout=TOOL_TIMEOUT)
    except FileNotFoundError:
        raise Refused('%s was not found on PATH' % args[0])
    except subprocess.TimeoutExpired:
        raise Refused('%s did not finish within %d seconds' % (' '.join(args[:2]), TOOL_TIMEOUT))


def git(*args):
    r = run(['git'] + list(args))
    if r.returncode != 0:
        raise Refused('git %s failed (exit %d): %s'
                      % (args[0], r.returncode, r.stderr.decode('utf-8', 'replace').strip()))
    return r.stdout


def blob(sha):
    return git('cat-file', 'blob', sha)


def key(text):
    """First 16 hex digits of the sha256 of the text: how a pattern or an address is named."""
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def as_text(data):
    return data.decode('utf-8', 'replace').replace('\r\n', '\n')


def as_path(data):
    return data.decode('utf-8', 'surrogateescape')


def is_zero(sha):
    return set(sha) == {'0'}


def looks_binary(data):
    """git's own test: a NUL byte in the first 8000 bytes."""
    return b'\0' in data[:8000]


def versions(path, has_head):
    """The file's bytes in the working tree, the index and HEAD, as (where, bytes) pairs;
    a version that does not exist is left out."""
    found = []
    if os.path.isfile(path):
        with open(path, 'rb') as fh:
            found.append(('working tree', fh.read()))
    want = path.encode('utf-8')
    for rec in git('ls-files', '-s', '-z', '--', path).split(b'\0'):
        meta, _, name = rec.partition(b'\t')
        if rec and name == want:
            found.append(('index', blob(meta.split()[1].decode('ascii'))))
    if has_head:
        for rec in git('ls-tree', '-z', 'HEAD', '--', path).split(b'\0'):
            meta, _, name = rec.partition(b'\t')
            if rec and name == want and meta.split()[1] == b'blob':
                found.append(('HEAD', blob(meta.split()[2].decode('ascii'))))
    return found


# --- what publish.sh says ------------------------------------------------------------------

class Exclude:
    """One rsync --exclude pattern, in the forms publish.sh uses: a name or a path with * and ?,
    anchored to the top of the copy by a leading /, limited to directories by a trailing /.
    rsync matches a pattern without a / against the last part of a path, and one with a /
    against the end of the path at any directory boundary; an excluded directory takes
    everything under it."""

    def __init__(self, pattern):
        if (not pattern.strip('/') or pattern[:2] in ('+ ', '- ') or pattern.startswith('!')
                or '**' in pattern or '//' in pattern or any(c in pattern for c in '[]\\')):
            raise Refused('%s: the --exclude form %r is not one this reader supports' % (PUBLISH, pattern))
        self.pattern = pattern
        self.dir_only = pattern.endswith('/')
        body = pattern.rstrip('/')
        anchored = body.startswith('/')
        body = body.lstrip('/')
        rx = ''.join('[^/]*' if c == '*' else '[^/]' if c == '?' else re.escape(c) for c in body)
        if anchored:
            self.whole, self.rx = True, re.compile(rx + r'\Z')
        elif '/' in body:
            self.whole, self.rx = True, re.compile(r'(?:.*/)?' + rx + r'\Z')
        else:
            self.whole, self.rx = False, re.compile(rx + r'\Z')

    def matches(self, path, is_dir):
        if self.dir_only and not is_dir:
            return False
        return self.rx.match(path if self.whole else path.rsplit('/', 1)[-1]) is not None


def excluded(path, excludes):
    parts = path.split('/')
    for n in range(1, len(parts) + 1):
        sub, is_dir = '/'.join(parts[:n]), n < len(parts)
        if any(e.matches(sub, is_dir) for e in excludes):
            return True
    return False


def read_excludes(text):
    lines = text.split('\n')
    commands = []
    i = 0
    while i < len(lines):
        if re.match(r'\s*rsync\s', lines[i]):
            parts = [lines[i]]
            while parts[-1].rstrip().endswith('\\') and i + 1 < len(lines):
                i += 1
                parts.append(lines[i])
            commands.append(' '.join(p.rstrip().rstrip('\\') for p in parts))
        i += 1
    if len(commands) != 1:
        raise Refused('%s holds %d rsync commands; this reader expects exactly one' % (PUBLISH, len(commands)))
    try:
        words = shlex.split(commands[0])
    except ValueError as e:
        raise Refused('%s: its rsync command could not be split into words (%s)' % (PUBLISH, e))
    excludes, places = [], []
    for w in words[1:]:
        if w.startswith('--exclude='):
            excludes.append(Exclude(w[len('--exclude='):]))
        elif w in ('-a', '--delete'):
            continue
        elif w.startswith('-'):
            raise Refused('%s: rsync option %r is not one this reader knows (it reads -a, --delete '
                          'and --exclude=)' % (PUBLISH, w))
        else:
            places.append(w)
    if places != ['$DEV_REPO/', '$PUBLIC_REPO/']:
        raise Refused('%s: rsync copies %r; this reader expects "$DEV_REPO/" to "$PUBLIC_REPO/"'
                      % (PUBLISH, places))
    if not excludes:
        raise Refused('%s: its rsync command has no --exclude' % PUBLISH)
    return excludes


def read_email_rule(text):
    m = re.search(r'email_leaks=\$\((.*?)\|\| true\)', text, re.S)
    if not m:
        raise Refused('%s: its email check (email_leaks=$(...)) was not found' % PUBLISH)
    block = m.group(1)
    e = re.search(r"grep -rEoh[^']*'([^']*)'", block)
    if not e or '@' not in e.group(1):
        raise Refused('%s: the expression of its email check was not found' % PUBLISH)
    expr = e.group(1)
    if not re.fullmatch(r"[A-Za-z0-9._%+@{},\\\[\]-]+", expr):
        raise Refused('%s: its email expression uses a form this reader does not translate' % PUBLISH)
    try:
        compiled = re.compile(expr)
    except re.error as err:
        raise Refused('%s: its email expression does not compile here (%s)' % (PUBLISH, err))
    allow = []
    for a in re.findall(r"grep -v '([^']*)'", block):
        if not a or re.search(r'[*\[\]\\^$]', a):
            raise Refused('%s: an email allow-list entry uses a form this reader does not translate' % PUBLISH)
        # grep -v takes a basic regular expression: of the characters used, only . is special.
        allow.append(re.compile(''.join('.' if c == '.' else re.escape(c) for c in a)))
    if not allow:
        raise Refused('%s: its email allow list (grep -v) was not found' % PUBLISH)
    return compiled, allow


EXEMPTION = re.compile(r'\[\[ "\$pattern" == "([^"$`\\]+)" && '
                       r'"\$\(basename "\$match_file"\)" == "([^"$`\\]+)" \]\]')


class PublishRules:
    def __init__(self, text):
        self.excludes = read_excludes(text)
        self.email, self.allow = read_email_rule(text)
        self.exempt = set((key(p), name) for p, name in EXEMPTION.findall(text))


# --- the scanner ---------------------------------------------------------------------------

class Findings:
    def __init__(self):
        self.deny, self.email, self.exempted = [], [], []


class Scanner:
    def __init__(self, patterns, rules):
        self.plain = [(p, key(p)) for p in patterns]
        self.folded = [(p.casefold(), k) for p, k in self.plain]
        self.exprs = []
        for r in rules:
            if r.email.pattern not in [x.pattern for x in self.exprs]:
                self.exprs.append(r.email)
        self.allow_sets = [r.allow for r in rules]
        self.exempt = set.intersection(*[r.exempt for r in rules]) if rules else set()

    def deny_keys(self, text):
        low = text.casefold()
        return [k for p, k in self.folded if p in low]

    def allowed(self, address):
        """An address passes only if every version of publish.sh read lets it pass."""
        return all(any(a.search(address) for a in allow) for allow in self.allow_sets)

    def email_hits(self, text):
        return [m.group(0) for rx in self.exprs for m in rx.finditer(text) if not self.allowed(m.group(0))]

    def mask(self, text):
        out = text
        for p, k in self.plain:
            out = re.sub(re.escape(p), '[pattern %s]' % k, out, flags=re.IGNORECASE)
        for rx in self.exprs:
            out = rx.sub(lambda m: '[email %s]' % key(m.group(0)), out)
        return '[withheld: the text holds a deny pattern]' if self.deny_keys(out) else out

    def line(self, f, place, text, name):
        for k in self.deny_keys(text):
            (f.exempted if (k, name) in self.exempt else f.deny).append((place, k))
        for address in self.email_hits(text):
            f.email.append((place, key(address)))

    def path(self, f, path):
        self.line(f, '%s (path name)' % self.mask(path), path, None)

    def binary(self, f, path, data):
        name, shown = path.rsplit('/', 1)[-1], self.mask(path)
        for label, text in (('utf-8', data.decode('utf-8', 'replace')),
                            ('utf-16le', data.decode('utf-16-le', 'replace')),
                            ('utf-16le, odd offset', data[1:].decode('utf-16-le', 'replace'))):
            self.line(f, '%s (binary, %s)' % (shown, label), text, name)

    def whole(self, f, path, data):
        if looks_binary(data):
            self.binary(f, path, data)
            return 0
        name, shown = path.rsplit('/', 1)[-1], self.mask(path)
        lines = data.split(b'\n')
        for n, raw in enumerate(lines, 1):
            self.line(f, '%s:%d' % (shown, n), raw.decode('utf-8', 'replace'), name)
        return len(lines)


def control(sc):
    """Plant every pattern, and an email shape, where the scan looks; each must be found."""
    planted, missing = 0, []
    for p, k in sc.plain:
        cases = (
            ('text', '', lambda f: sc.line(f, 'control', 'x ' + p.upper() + ' y', 'control.txt')),
            ('path', '(path name)', lambda f: sc.path(f, 'control/' + p.swapcase() + '.txt')),
            ('utf-8', '(binary, utf-8)',
             lambda f: sc.binary(f, 'control.bin', b'\x00\xff' + p.encode('utf-8') + b'\x00')),
            ('utf-16le', '(binary, utf-16le)',
             lambda f: sc.binary(f, 'control.bin', b'\x00\x00' + p.upper().encode('utf-16-le'))),
            ('utf-16le odd', '(binary, utf-16le, odd offset)',
             lambda f: sc.binary(f, 'control.bin', b'\x00' + p.encode('utf-16-le'))),
        )
        for label, where, plant in cases:
            f = Findings()
            plant(f)
            planted += 1
            if not any(hk == k and where in place for place, hk in f.deny):
                missing.append('pattern %s not found in %s' % (k, label))
    held = 0
    for k, name in sorted(sc.exempt):
        for p, pk in sc.plain:
            if pk != k:
                continue
            inside, outside = Findings(), Findings()
            sc.line(inside, 'control', p, name)
            sc.line(outside, 'control', p, 'not-' + name)
            keys = lambda hits: [hk for _, hk in hits]
            if (k in keys(inside.exempted) and k not in keys(inside.deny)
                    and k in keys(outside.deny) and k not in keys(outside.exempted)):
                held += 1
            else:
                missing.append('exemption %s for files named %s does not hold to that name' % (k, name))
    address = 'q7k' + chr(64) + 'w4x.qv'
    email_found = 0
    if sc.allowed(address):
        missing.append('the control address is on the allow list; it cannot prove the email scan')
    else:
        for plant in (lambda f: sc.line(f, 'control', 'mail ' + address + ' here', 'control.txt'),
                      lambda f: sc.binary(f, 'control.bin', b'\x00' + address.encode('utf-16-le'))):
            f = Findings()
            plant(f)
            if f.email:
                email_found += 1
            else:
                missing.append('the planted email shape was not found')
    found = planted - sum(1 for m in missing if m.startswith('pattern '))
    summary = ('%d patterns x 5 placements (text, path name, binary as UTF-8 and as UTF-16LE at both '
               'alignments): %d of %d found; %d exemption(s) held to their file name; email shape: '
               '%d of 2 found' % (len(sc.plain), found, planted, held, email_found))
    return Result('control', 'FAIL' if missing else 'PASS', summary, missing,
                  'the scan cannot be trusted; correct .githooks/checks.py before committing')


def scan_results(f, scope):
    deny = Result('deny', 'FAIL' if f.deny else 'PASS', '%s: %d hit(s)' % (scope, len(f.deny)),
                  ['%s pattern %s' % hit for hit in f.deny]
                  + ['exempted: %s pattern %s (publish.sh exempts it in files of this name)' % x
                     for x in f.exempted],
                  'remove or reword the text at each place named (a key is the first 16 hex digits of '
                  'the sha256 of a line of %s), or move the file under a path publish.sh excludes' % PATTERNS)
    email = Result('email', 'FAIL' if f.email else 'PASS',
                   '%d email-shaped string(s) outside publish.sh\'s allow list' % len(f.email),
                   ['%s email-shaped string %s' % hit for hit in f.email],
                   'remove the address, or use one on publish.sh\'s allow list (for example one at example.com)')
    return [deny, email]


# --- the repository's rules ----------------------------------------------------------------

def parse_patterns(blobs):
    """The union of the patterns in each (where, bytes) version: one a line, '#' starts a comment."""
    patterns = []
    for _, data in blobs:
        for raw in as_text(data).split('\n'):
            s = raw.strip()
            if s and not s.startswith('#') and s not in patterns:
                patterns.append(s)
    return patterns


class Context:
    """The pattern list and publish.sh, read as the commit and the working tree hold them."""

    def __init__(self, results):
        self.has_head = run(['git', 'rev-parse', '--verify', '-q', 'HEAD']).returncode == 0
        self.mode, self.rules, self.by_where = 'private', [], {}
        self.sc = Scanner([], [])
        pv, sv = versions(PATTERNS, self.has_head), versions(PUBLISH, self.has_head)
        if not pv and not sv:
            self.mode = 'public'
            results.append(Result('rules', 'INFO', 'no %s and no %s in this repository: every path is '
                                  'public; the deny and email scans do not run' % (PATTERNS, PUBLISH)))
            return
        if not pv or not sv:
            self.mode = 'broken'
            results.append(Result('rules', 'FAIL', '%s is %s but %s is %s' % (
                PATTERNS, 'present' if pv else 'absent', PUBLISH, 'present' if sv else 'absent'), (),
                'both are present in the private repository and both absent in the public one; '
                'restore the missing one'))
            return
        patterns = parse_patterns(pv)
        self.sc = Scanner(patterns, [])
        use_masker(self.sc)
        if not patterns:
            self.mode = 'broken'
            results.append(Result('rules', 'FAIL', '%s holds no pattern' % PATTERNS, (), 'restore the pattern list'))
            return
        by_text = {}
        try:
            for where, data in sv:
                text = as_text(data)
                if text not in by_text:
                    by_text[text] = PublishRules(text)
                self.by_where[where] = by_text[text]
        except Refused as e:
            self.mode = 'broken'
            results.append(Result('rules', 'FAIL', str(e), (),
                                  'keep publish.sh in the forms this reader supports, or extend the reader '
                                  'in .githooks/checks.py and prove it'))
            return
        self.rules = list(by_text.values())
        self.sc = Scanner(patterns, self.rules)
        use_masker(self.sc)
        results.append(Result('rules', 'INFO', '%d patterns from %s (%s); publish.sh (%s, %d distinct): %s '
                              'excludes, an email allow list of %s, %d exemption(s)' % (
                                  len(patterns), PATTERNS, ', '.join(w for w, _ in pv), ', '.join(w for w, _ in sv),
                                  len(self.rules), '/'.join(str(len(r.excludes)) for r in self.rules),
                                  '/'.join(str(len(r.allow)) for r in self.rules), len(self.sc.exempt))))

    def public_bound(self, path):
        """A path is public-bound unless every version of publish.sh read excludes it."""
        return self.mode == 'public' or any(not excluded(path, r.excludes) for r in self.rules)

    def entering_public(self):
        """Index files that HEAD's publish.sh excludes and the staged one copies: {path: sha}."""
        head, index = self.by_where.get('HEAD'), self.by_where.get('index')
        if head is None or index is None or head is index:
            return {}
        found = {}
        for rec in git('ls-files', '-s', '-z').split(b'\0'):
            meta, _, name = rec.partition(b'\t')
            if not rec:
                continue
            mode, sha = meta.split()[0], meta.split()[1].decode('ascii')
            path = as_path(name)
            if mode != b'160000' and excluded(path, head.excludes) and not excluded(path, index.excludes):
                found[path] = sha
        return found


# --- what the commit adds ------------------------------------------------------------------

class Entry:
    def __init__(self, old_mode, new_mode, old, new, status, src, dst):
        self.old_mode, self.new_mode, self.old, self.new = old_mode, new_mode, old, new
        self.status, self.src, self.dst = status, src, dst


def staged_entries():
    out = git('diff', '--cached', '--raw', '-z', '-M', '--no-abbrev', '--no-relative')
    parts = out.split(b'\0')
    entries, i = [], 0
    while i < len(parts) and parts[i]:
        meta = parts[i].decode('ascii')
        if not meta.startswith(':'):
            raise Refused('unexpected record from git diff --raw: %r' % meta[:60])
        old_mode, new_mode, old, new, status = meta[1:].split()
        if status[0] in 'UX':
            raise Refused('the index holds an unmerged or unknown path (status %s)' % status)
        if status[0] in 'RC':
            src, dst, i = as_path(parts[i + 1]), as_path(parts[i + 2]), i + 3
        else:
            src = dst = as_path(parts[i + 1])
            i += 2
        entries.append(Entry(old_mode, new_mode, old, new, status[0], src, dst))
    return entries


HUNK = re.compile(rb'@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
INDEX_LINE = re.compile(rb'index ([0-9a-f]+)\.\.([0-9a-f]+)')


def parse_patch(data):
    """{(old blob, new blob): {'binary': bool, 'added': [(new line number, bytes)]}} from a
    git diff -U0 --full-index patch; hunks are read by their line counts."""
    sections, cur, lines, i = {}, None, data.split(b'\n'), 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if line.startswith(b'diff --git '):
            cur = {'binary': False, 'added': []}
        elif cur is None:
            if line:
                raise Refused('unexpected line before the first file of the staged patch')
        elif line.startswith(b'index ') and INDEX_LINE.match(line):
            m = INDEX_LINE.match(line)
            sections.setdefault((m.group(1).decode('ascii'), m.group(2).decode('ascii')), cur)
        elif line.startswith(b'Binary files ') and line.endswith(b' differ'):
            cur['binary'] = True
        elif line.startswith(b'@@ '):
            m = HUNK.match(line)
            if not m:
                raise Refused('unreadable hunk header in the staged patch')
            old_n = int(m.group(1)) if m.group(1) is not None else 1
            n = int(m.group(2))
            new_n = int(m.group(3)) if m.group(3) is not None else 1
            while old_n > 0 or new_n > 0:
                if i >= len(lines):
                    raise Refused('the staged patch ends inside a hunk')
                body = lines[i]
                i += 1
                if body.startswith(b'\\'):
                    continue
                if body.startswith(b'-'):
                    old_n -= 1
                elif body.startswith(b'+'):
                    cur['added'].append((n, body[1:]))
                    n, new_n = n + 1, new_n - 1
                elif body.startswith(b' '):
                    n, old_n, new_n = n + 1, old_n - 1, new_n - 1
                else:
                    raise Refused('unexpected line inside a hunk of the staged patch')
    return sections


def pre_commit():
    results = []
    ctx = Context(results)
    sc = ctx.sc
    entries = staged_entries()
    live = [e for e in entries if e.status != 'D']
    deleted = len(entries) - len(live)
    if ctx.mode == 'broken':
        for name in ('control', 'deny', 'email'):
            results.append(Result(name, 'NOT RUN', 'the rules above could not be read'))
    else:
        public = [e for e in live if ctx.public_bound(e.dst)]
        private = [e for e in live if not ctx.public_bound(e.dst)]
        results.append(Result('scope', 'INFO', '%d staged path(s): %d public-bound, scanned; %d private-only, '
                              'not scanned; %d deleted' % (len(entries), len(public), len(private), deleted),
                              ['not scanned (publish.sh excludes it): %s' % sc.mask(e.dst) for e in private]))
        if ctx.mode == 'public':
            results.append(Result('deny', 'NOT RUN', 'no pattern list in this repository'))
            results.append(Result('email', 'NOT RUN', 'no publish script in this repository (it holds the allow list)'))
        else:
            results.append(control(sc))
            results.extend(scan_commit(ctx, public))
    results.extend(lint_checks(entries, sc))
    results.append(python_check(live, sc))
    return results


def scan_commit(ctx, public):
    sc, f = ctx.sc, Findings()
    patch = parse_patch(git('diff', '--cached', '-M', '-U0', '--full-index', '--no-color', '--no-ext-diff',
                            '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'))
    entering = ctx.entering_public()
    counts = {'lines': 0, 'binary': 0, 'whole': 0, 'paths': 0}
    notes, seen = [], set()
    for e in public:
        seen.add(e.dst)
        if e.status in 'ARC':
            sc.path(f, e.dst)
            counts['paths'] += 1
        if e.new_mode == '160000':
            continue
        whole = (e.status in 'RC' and not ctx.public_bound(e.src)) or e.dst in entering
        if not whole:
            if e.old == e.new:
                continue
            section = patch.get(('0' * len(e.new) if e.status == 'T' else e.old, e.new))
            if section is None:
                whole = True
                notes.append('no patch section for %s: read whole' % sc.mask(e.dst))
            elif section['binary']:
                sc.binary(f, e.dst, blob(e.new))
                counts['binary'] += 1
                continue
            else:
                name, shown = e.dst.rsplit('/', 1)[-1], sc.mask(e.dst)
                for n, raw in section['added']:
                    sc.line(f, '%s:%d' % (shown, n), raw.decode('utf-8', 'replace'), name)
                counts['lines'] += len(section['added'])
                continue
        counts['lines'] += sc.whole(f, e.dst, blob(e.new))
        counts['whole'] += 1
    for path, sha in sorted(entering.items()):
        if path not in seen:
            counts['lines'] += sc.whole(f, path, blob(sha))
            counts['whole'] += 1
    scope = ('%d added line(s) in %d public-bound file(s), %d binary blob(s), %d file(s) read whole, '
             '%d new path name(s)' % (counts['lines'], len(public), counts['binary'], counts['whole'],
                                      counts['paths']))
    out = scan_results(f, scope)
    out[0].details.extend(notes)
    return out


# --- lint, type check, compile -------------------------------------------------------------

def node_tool(package, command, env):
    script = ("var p=require.resolve(process.argv[1]+'/package.json',{paths:[process.cwd()]});"
              "var j=require(p);process.stdout.write(JSON.stringify({p:p,v:j.version,b:j.bin}))")
    r = run(['node', '-e', script, package], env)
    if r.returncode != 0:
        raise Refused('%s is not installed for this checkout' % package)
    info = json.loads(r.stdout.decode('utf-8'))
    rel = info['b'].get(command) if isinstance(info['b'], dict) else info['b']
    if not rel:
        raise Refused('%s names no %s program' % (package, command))
    home = os.path.dirname(info['p'])
    return os.path.normpath(os.path.join(home, rel)), info['v'], home


def lint_checks(entries, sc):
    touched = [e for e in entries if any(p.startswith('src/') or p in LINT_CONFIG for p in (e.src, e.dst))]
    if not touched:
        why = 'no staged change touches src/, ' + ', '.join(LINT_CONFIG)
        return [Result('tsc', 'NOT RUN', why), Result('eslint', 'NOT RUN', why)]
    inputs = ['src'] + list(LINT_CONFIG)
    unstaged = [as_path(p) for p in git('diff', '--name-only', '-z', '--no-relative', '--', *inputs).split(b'\0') if p]
    others = [as_path(p) for p in git('ls-files', '--others', '-z', '--', 'src').split(b'\0') if p]
    if unstaged or others:
        details = (['unstaged change: %s' % sc.mask(p) for p in unstaged]
                   + ['untracked or ignored: %s' % sc.mask(p) for p in others])
        fix = ('stage or stash the unstaged changes and move untracked or ignored files out of src/: '
               'these checks read the working tree, which must equal the commit')
        why = 'cannot run: the working tree differs from the commit in src/ or its configuration'
        return [Result('tsc', 'FAIL', why, details, fix), Result('eslint', 'FAIL', why, (), fix)]
    env = dict(os.environ)
    env.pop('NODE_OPTIONS', None)
    env.pop('NODE_PATH', None)
    results = []
    try:
        tsc, version, where = node_tool('typescript', 'tsc', env)
        t0 = time.time()
        r = run(['node', tsc, '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], env)
        ms = int((time.time() - t0) * 1000)
        lines = [sc.mask(l) for l in (r.stdout + r.stderr).decode('utf-8', 'replace').splitlines() if l.strip()]
        summary = 'typescript %s (%s), exit %d, %d ms' % (version, where, r.returncode, ms)
        results.append(Result('tsc', 'PASS' if r.returncode == 0 else 'FAIL', summary, lines,
                              'correct the type errors named'))
    except Refused as e:
        results.append(Result('tsc', 'FAIL', 'cannot run: %s' % e, (), 'install the dependencies (npm ci)'))
    if any(p in LINT_CONFIG for e in touched for p in (e.src, e.dst)):
        targets, what = ['src/'], 'all of src/ (a configuration file changed)'
    else:
        targets = sorted(set(e.dst for e in touched if e.status != 'D' and e.dst.startswith('src/')
                             and e.dst.endswith('.ts')))
        what = '%d staged .ts file(s)' % len(targets)
    if not targets:
        results.append(Result('eslint', 'NOT RUN', 'no staged .ts file under src/'))
        return results
    try:
        eslint, version, where = node_tool('eslint', 'eslint', env)
        r = run(['node', eslint, '--no-warn-ignored', '-f', 'json'] + targets, env)
        try:
            report = json.loads(r.stdout.decode('utf-8'))
        except ValueError:
            report = None
        if r.returncode not in (0, 1) or not isinstance(report, list):
            lines = [sc.mask(l) for l in r.stderr.decode('utf-8', 'replace').splitlines() if l.strip()]
            results.append(Result('eslint', 'FAIL', 'eslint %s could not run (exit %d)' % (version, r.returncode),
                                  lines, 'correct the cause named'))
            return results
        problems, errors, warns = [], 0, 0
        for res in report:
            rel = os.path.relpath(res.get('filePath', '?')).replace(os.sep, '/')
            for msg in res.get('messages', []):
                error = msg.get('severity') == 2 or msg.get('fatal')
                errors, warns = errors + (1 if error else 0), warns + (0 if error else 1)
                problems.append('%s:%s:%s %s %s (%s)' % (sc.mask(rel), msg.get('line'), msg.get('column'),
                                                        'error' if error else 'warning',
                                                        sc.mask(str(msg.get('message'))), msg.get('ruleId')))
        summary = 'eslint %s (%s) on %s: %d file(s) linted, %d error(s), %d warning(s)' % (
            version, where, what, len(report), errors, warns)
        results.append(Result('eslint', 'FAIL' if errors or r.returncode else 'PASS', summary, problems,
                              'correct the errors named (npm run lint shows the same)'))
    except Refused as e:
        results.append(Result('eslint', 'FAIL', 'cannot run: %s' % e, (), 'install the dependencies (npm ci)'))
    return results


def python_check(live, sc):
    files = [e for e in live if e.dst.endswith('.py') and e.new_mode in ('100644', '100755')]
    if not files:
        return Result('python', 'NOT RUN', 'no staged .py file')
    problems = []
    for e in files:
        shown = sc.mask(e.dst)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            try:
                compile(blob(e.new), e.dst, 'exec', dont_inherit=True)
            except (SyntaxError, ValueError) as err:
                problems.append('%s:%s %s: %s' % (shown, getattr(err, 'lineno', '?'), type(err).__name__,
                                                  sc.mask(str(getattr(err, 'msg', err)))))
        for w in caught:
            problems.append('%s:%s %s: %s' % (shown, w.lineno, w.category.__name__, sc.mask(str(w.message))))
    summary = '%d staged .py file(s) compiled with python %s: %d problem(s)' % (
        len(files), sys.version.split()[0], len(problems))
    return Result('python', 'FAIL' if problems else 'PASS', summary, problems,
                  'correct the syntax error or warning named')


# --- commit-msg ----------------------------------------------------------------------------

def kept_lines(lines):
    """How many lines of the message file to read. git cuts the message at a scissors line
    only in verbose mode (git 2.39: a message given with -F keeps the text below the line,
    with the default cleanup and with --cleanup=scissors alike). So the scan stops only at a
    scissors line that git's own verbose diff follows; otherwise it reads every line."""
    for i, line in enumerate(lines):
        if CUT_LINE.fullmatch(line.rstrip('\r')):
            mark, j = line.split(' ', 1)[0], i + 1
            while j < len(lines) and lines[j].startswith(mark):
                j += 1
            if j < len(lines) and lines[j].startswith('diff --git '):
                return i
    return len(lines)


def commit_msg(path):
    with open(path, 'rb') as fh:
        lines = fh.read().decode('utf-8', 'replace').split('\n')
    cut = kept_lines(lines)
    results = []
    ctx = Context(results)
    if ctx.mode == 'broken':
        return results + [Result(n, 'NOT RUN', 'the rules above could not be read')
                          for n in ('control', 'deny', 'email')]
    if ctx.mode == 'public':
        return results + [Result('deny', 'NOT RUN', 'no pattern list in this repository'),
                          Result('email', 'NOT RUN', 'no publish script in this repository (it holds the allow list)')]
    results.append(control(ctx.sc))
    f = Findings()
    for n, line in enumerate(lines[:cut], 1):
        ctx.sc.line(f, 'message:%d' % n, line.rstrip('\r'), None)
    scope = 'the message, %d line(s)%s' % (cut, ' (up to the verbose diff git cuts off)' if cut < len(lines) else '')
    return results + scan_results(f, scope)


# --- output --------------------------------------------------------------------------------
# Every line printed passes through the mask: tool paths, git's messages and tracebacks can
# hold a pattern (a home folder's name, for one) even when the repository's text does not.

_masker = None


def use_masker(scanner):
    global _masker
    _masker = scanner


def say(text):
    print(_masker.mask(text) if _masker is not None else text)


def early_masker():
    """Before git is asked anything: the working tree's pattern list, read beside this file."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, *PATTERNS.split('/'))
    try:
        with open(path, 'rb') as fh:
            use_masker(Scanner(parse_patterns([('working tree', fh.read())]), []))
    except OSError:
        pass


def emit(hook, results):
    say('%s checks (.githooks/checks.py, python %s)' % (hook, sys.version.split()[0]))
    for r in results:
        say('  %-8s %-8s %s' % (r.name, r.status, r.summary))
        for d in r.details:
            say(MARGIN + d)
        if r.status == 'FAIL' and r.fix:
            say(MARGIN + 'fix: ' + r.fix)
    failed = [r.name for r in results if r.status == 'FAIL']
    if failed:
        say('%s: FAIL (%s): the commit was not made' % (hook, ', '.join(failed)))
        return 1
    say('%s: PASS (%d passed, %d not run)' % (hook, sum(1 for r in results if r.status == 'PASS'),
                                              sum(1 for r in results if r.status == 'NOT RUN')))
    return 0


def main(argv):
    try:
        sys.stdout.reconfigure(errors='replace')
    except AttributeError:
        pass
    if not argv or argv[0] not in ('pre-commit', 'commit-msg') or len(argv) != (2 if argv[0] == 'commit-msg' else 1):
        print(__doc__)
        return 2
    hook = argv[0]
    early_masker()
    try:
        message = os.path.abspath(argv[1]) if hook == 'commit-msg' else None
        os.chdir(as_path(git('rev-parse', '--show-toplevel')).strip())
        results = pre_commit() if hook == 'pre-commit' else commit_msg(message)
    except Refused as e:
        results = [Result('checks', 'FAIL', 'cannot run: %s' % e, (), 'correct the cause named')]
    except Exception:
        say(traceback.format_exc())
        results = [Result('checks', 'FAIL', 'internal error (the traceback is above)', (),
                          'correct .githooks/checks.py')]
    sys.stdout.flush()
    return emit(hook, results)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
