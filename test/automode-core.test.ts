/**
 * Auto-mode policy (src/security/autonomy.ts + shell-analyze.ts): a table of shell
 * commands → verdict, run in a project at /work/proj (a path that does not exist, so the
 * policy works on the strings, not on what happens to be on this disk).
 *
 * The user's rules: inside the project everything runs; destructive actions OUTSIDE the
 * project, remote-destructive / history rewrite / irreversible publish, and system-level
 * commands ask. Unknowable values ($VARS, $(…) output) are not "outside".
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { autonomousDecision, workspaceRoots, isInsideRoots, editPathDecision, localDestructiveReason, needsHumanMessage } from '../src/security/autonomy.js';
import { analyzeShell } from '../src/security/shell-analyze.js';
import { parseShell } from '../src/security/shell-parse.js';

const CWD = '/work/proj';
const ROOTS = [CWD, '/scratch/tmp'];
const ctx = { cwd: CWD, roots: ROOTS };
const shell = (operation: string) => autonomousDecision({ tool: 'shell', operation }, ctx);
const b64 = (s: string) => Buffer.from(s).toString('base64');

const ALLOW: string[] = [
  // ordinary work
  'ls -la', 'pwd', 'npm test', 'npm install', 'npm i -D vitest', 'pnpm add zod', 'pip install -r requirements.txt',
  'npm install -g typescript', 'brew install jq', 'cargo build --release', 'make clean all', 'npx tsc --noEmit',
  'npm run build && npm test', 'docker build -t app .', 'docker compose up -d', 'docker run --rm app', 'docker rm -f old',
  'python3 -c "print(1)"', 'node -e "console.log(1)"', 'bash scripts/build.sh', './scripts/deploy-local.sh',
  // git inside the project, including the destructive-but-local ones
  'git status', 'git add -A && git commit -m "x"', 'git push', 'git push origin main', 'git push -u origin feat/x',
  'git push origin HEAD:refs/for/main', 'git push --tags', 'git push -n --force', 'git pull --rebase', 'git merge main',
  'git rebase -i HEAD~3', 'git reset --hard HEAD~1', 'git clean -fdx', 'git checkout -- .', 'git restore .',
  'git stash drop', 'git branch -D old', 'git -C sub reset --hard', 'git filter-repo --path x --invert-paths',
  // deletes / writes inside the project or the temp dir
  'rm -rf node_modules dist', 'rm -rf ./build/*', 'rm -rf *', 'rm file.txt', 'rm -f stale.txt', 'mv a.txt b.txt',
  'cp -r src backup', 'mkdir -p out && touch out/x', 'echo hi > out.txt', 'cat a | grep b > /dev/null 2>&1',
  'tee out.log', 'ln -s ../shared lib', 'ln -sf ../shared lib', 'unzip a.zip', 'tar -xzf a.tgz -C vendor',
  'sed -i "s/a/b/" src/x.ts', 'perl -pi -e "s/a/b/" src/x.ts', 'chmod +x scripts/run.sh', 'truncate -s 0 logs/app.log',
  'find . -name "*.log" -delete', 'find . -type f -exec rm {} \\;', 'git ls-files | xargs rm', 'cd sub && rm -rf build',
  'rm -rf /scratch/tmp/qodex-build', 'mv build /scratch/tmp/old-build', 'cp .env.example .env', 'rimraf dist',
  'cat <<EOF > notes.md\nrm -rf ~/x\nEOF', 'dd if=/dev/zero of=disk.img bs=1M count=1',
  // unknowable values are not "clearly outside"
  'rm -rf "$BUILD_DIR"', 'rm -rf $(cat list.txt)', 'cd "$WORK" && rm -rf out','rm -rf "$(pwd)/dist"',
  'xargs rm -rf < list.txt', '$CMD build', 'rm -rf "$PWD/$X"', 'rm -rf build/$X', 'rm -rf /work/proj/$X', 'echo ${X:-default}',
  'echo $((1 + 2))', 'rm -rf {build,dist}', "awk '{print $1,$2}' f.txt", 'bash -c "$SCRIPT"', 'git worktree remove wt', "trap 'rm -rf build' EXIT",
  // words that only LOOK dangerous (not in command position)
  'echo "shutdown -h now" > notes.txt', 'grep -rn "rm -rf /" src', 'git commit -m "drop table users; shutdown; reboot"',
  'cat shutdown.ts', 'grep -c "sudo" README.md', 'echo git push --force', 'npm run reboot-docs',
  // network reads, uploads of project files, local services
  'curl https://example.com', 'curl -o data.json https://x.example/api', 'curl -X POST -d @payload.json https://api.example.com/upload',
  'curl -T dist/app.zip https://upload.example.com', 'wget https://x.example/y.tar.gz && tar xzf y.tar.gz',
  'curl -X DELETE http://localhost:3000/api/items/1', 'curl -fsSL https://get.example.sh | sh',
  // databases on this machine
  'psql -c "DROP TABLE users"', 'dropdb mydb', 'redis-cli FLUSHALL', 'mysql -e "TRUNCATE t"', 'psql -h localhost -c "DELETE FROM t"',
  // read-only remote / cloud / cluster
  'kubectl get pods', 'terraform plan', 'aws s3 ls', 'aws s3 cp dist s3://bucket/ --recursive', 'gh pr create --fill',
  'gh repo view', 'npm publish --dry-run', 'aws --endpoint-url http://localhost:4566 s3 rm s3://b/k',
  'ssh host ls', 'ssh host "cd app && git pull"', 'vercel deploy',
  // system reads
  'systemctl status nginx', 'launchctl list', 'diskutil list', 'mount', 'crontab -l', 'command -v sudo', 'which shutdown',
];

const ASK: string[] = [
  // outside deletes / writes
  'rm -rf ~/somedir', 'rm -rf ~', 'rm -rf /etc/nginx', 'rm ~/.bashrc', 'rm -rf ../other-project', 'rm -rf ..',
  'rm -rf /scratch/tmp', 'unlink ~/link', 'shred -u ~/secret.txt',
  'echo hi > ~/.bashrc', 'echo x >> ~/.zshrc', 'cat > ~/.ssh/config <<EOF\nHost x\nEOF', 'tee -a ~/.profile',
  'cp build/app /usr/local/bin/app', 'mv ~/Downloads/x.zip .', 'mv dist ~/www', 'sed -i "s/a/b/" ~/.bashrc',
  'chmod -R 777 ~/x', 'chown -R me /opt', 'truncate -s 0 ~/log.txt', 'ln -sf "$(pwd)/bin/tool" ~/.local/bin/tool',
  'curl -o ~/bin/tool https://x.example/tool', 'wget -O /usr/local/bin/x https://x.example/x', 'tar -xzf a.tgz -C ~/apps',
  'find ~ -name "*.log" -delete', 'find /var/log -type f -exec rm {} +', 'find ~/Downloads -name "*.tmp" | xargs rm -f',
  'echo ~/old ~/older | xargs rm -rf', 'perl -pi -e "s/a/b/" ~/.gitconfig', 'rimraf ~/cache',
  // cwd tracking
  'cd ~ && rm -rf proj2', 'cd .. && rm -rf other', 'cd /etc && rm hosts', '(cd ~/x && rm -rf y)', 'pushd /opt && rm -rf app',
  'git -C ~/other reset --hard', 'git -C /srv/repo clean -fdx', 'git --work-tree=/srv/site checkout -- .',
  // every segment counts
  'ls && rm -rf ~/x', 'true; echo hi > ~/.bashrc', 'npm test || rm -rf ~/x', 'npm test & rm -rf ~/x', 'npm test | tee ~/x.log',
  'echo $(rm -rf ~/x)', 'echo `rm -rf ~/x`', 'bash -c "rm -rf ~/x"', 'sh -c "echo hi > /etc/hosts"', 'eval "rm -rf ~/x"',
  'env FOO=1 rm -rf ~/x', 'nohup rm -rf ~/x &', 'time rm -rf ~/x', 'timeout 10 rm -rf ~/x', 'xargs -I{} rm -rf ~/{} < l',
  'if [ -d ~/x ]; then rm -rf ~/x; fi', 'npx rimraf ~/x',
  // variables we can know
  'D=~/x; rm -rf $D', 'for d in ~/a ~/b; do rm -rf "$d"; done', 'export T=/etc/x && rm -f $T', 'rm -rf "$HOME/.cache"',
  'rm -rf ${HOME}/x', 'rm -rf $HOME', 'rm -rf ~/"$X"/..',
  // obfuscation we can see through
  `echo ${b64('rm -rf ~/x')} | base64 -d | sh`, `bash <<< "rm -rf ~/x"`, 'bash <<EOF\nrm -rf ~/x\nEOF', "$'\\x72\\x6d' -rf ~/x",
  'python3 -c "import shutil; shutil.rmtree(\'/etc/x\')"', 'node -e "require(\'fs\').rmSync(\'/var/data\', {recursive: true})"',
  'python3 -c "import os; os.system(\'rm -rf ~/x\')"', '$(echo rm) -rf ~/x', '"$CMD" /etc/passwd', "trap 'rm -rf ~/x' EXIT",
  'node -e "require(\'child_process\').execSync(\'rm -rf ~/x\')"', "perl -e 'unlink glob(\"~/x/*\")'", 'git worktree remove ../wt',
  'tar -czf - . | ssh host "tar -xzf - -C /srv"', 'cp -r src ~', 'echo ${X:-$(rm -rf ~/x)}', 'echo $(( $(rm -rf ~/x) + 1 ))',
  '(( n = $(rm -rf ~/x) ))', 'rm -rf {~/x,build}', 'rm -rf ~/{a,b}', 'for f in $(ls ~); do rm -rf ~/$f; done', 'rm -rf "$HOME/$X"',
  'rm -rf ~/"$X"','\\rm -rf ~/x', '"rm" -rf ~/x', "r''m -rf ~/x", 'exec > ~/log 2>&1',
  // remote history rewrite / remote deletes
  'git push --force', 'git push -f origin main', 'git push origin +main','git push origin :old-branch',
  'git push --delete origin old', 'git push origin --delete old', 'git push -d origin x', 'git push --mirror', 'git push --force-with-lease',
  'git push --force-with-lease=main:abc origin main', 'git -c core.x=y push -f', 'git -C . push --force', 'git --no-pager push -f',
  'git push --prune origin', 'git -c alias.p="push --force" p', 'git push -uf origin x', 'cd sub && git push -f',
  'gh repo delete owner/repo --yes', 'gh release delete v1', 'gh api -X DELETE /repos/o/r', 'gh api --method DELETE /x',
  // cloud / cluster / infra
  'aws s3 rm s3://b/k --recursive', 'aws s3 rb s3://b --force', 'aws ec2 terminate-instances --instance-ids i-1',
  'aws --profile prod cloudformation delete-stack --stack-name x', 'aws s3 sync . s3://b --delete', 'kubectl delete pod x',
  'kubectl -n prod delete deploy api', 'kubectl drain node1', 'helm uninstall app', 'helm delete app', 'terraform destroy',
  'terraform apply -auto-approve', 'terraform -chdir=infra apply', 'tofu destroy', 'pulumi up --yes', 'pulumi destroy',
  'gcloud compute instances delete vm1', 'az group delete -n rg', 'gsutil rm gs://b/x', 'heroku apps:destroy app',
  'cdk destroy', 'serverless remove', 'docker volume rm pgdata',
  // databases elsewhere
  'dropdb -h db.prod.example.com app', 'psql -h db.prod.example.com -c "DROP TABLE users"', 'psql postgres://u@db.prod/app -c "TRUNCATE t"',
  'mysql -h prod -e "DELETE FROM users"', 'redis-cli -h cache.prod FLUSHALL', 'echo "DROP TABLE x;" | psql -h prod.db',
  'mongosh mongodb+srv://c.example.net/db --eval "db.dropDatabase()"', 'curl -X DELETE https://api.example.com/users/1',
  // irreversible publish / prod deploy
  'npm publish', 'npm unpublish pkg@1.0.0', 'pnpm publish', 'yarn publish', 'cargo publish', 'cargo yank --version 1.0.0',
  'twine upload dist/*', 'python -m twine upload dist/*', 'gem push x.gem', 'docker push org/app:latest',
  'docker buildx build --push -t x .', 'vercel --prod', 'vercel deploy --prod', 'firebase deploy', 'netlify deploy --prod',
  'fly deploy', 'npx vercel --prod', 'npx -y vsce publish', 'poetry publish --build', 'mvn deploy', './gradlew publish',
  'dotnet nuget push x.nupkg', 'wrangler deploy',
  // copies to other machines
  'rsync -avz dist/ user@host:/var/www/', 'rsync -a --delete src/ ~/backup/', 'scp app.tar user@host:/srv/',
  'ssh host "rm -rf /var/www/app"', 'ssh prod sudo reboot', 'ssh -p 22 deploy@host "echo x > /etc/motd"',
  // system level
  'sudo apt install jq', 'sudo rm -rf /var/cache/x', 'doas reboot', 'su -c "id"', 'pkexec ls', 'shutdown -h now', 'reboot',
  'halt', 'poweroff', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sdb bs=1M', 'cat image.iso > /dev/sdb',
  'chmod -R 777 /', 'chown -R root /', 'launchctl load ~/Library/LaunchAgents/x.plist', 'systemctl restart nginx',
  'systemctl --user enable foo', 'service nginx restart', 'diskutil eraseDisk APFS X disk2', 'mount /dev/sdb1 /mnt',
  'crontab -r', 'crontab mycron.txt', 'iptables -F', 'sudo -u postgres psql', 'nvram boot-args="-v"', 'csrutil disable',
  'systemctl reboot', 'wipefs -a /dev/sdb', 'parted /dev/sdb mklabel gpt', 'kill -9 -1', 'useradd bob',
  ':(){ :|:& };:',
];

describe('autonomousDecision — shell commands (cwd /work/proj)', () => {
  it.each(ALLOW)('allow: %s', (cmd) => {
    const v = shell(cmd);
    expect(v, `${cmd} → ${v.reason}`).toEqual({ decision: 'allow' });
  });

  it.each(ASK)('ask: %s', (cmd) => {
    const v = shell(cmd);
    expect(v.decision, cmd).toBe('ask');
    expect(v.reason, cmd).toBeTruthy();
  });

  it('never returns deny (hard-deny lives in the engine)', () => {
    for (const c of [...ALLOW, ...ASK]) expect(shell(c).decision).not.toBe('deny');
  });

  it('reasons say what and where', () => {
    expect(shell('rm -rf ~/somedir').reason).toMatch(/deletes ~\/somedir \(outside the project\)/);
    expect(shell('echo hi > ~/.bashrc').reason).toMatch(/writes ~\/\.bashrc/);
    expect(shell('git push origin +main').reason).toMatch(/force push/);
    expect(shell('sudo ls').reason).toMatch(/root/);
    expect(shell('npm publish').reason).toMatch(/publish/);
    expect(shell('rm -rf ..').reason).toMatch(/parent of the project/);
    expect(shell('ssh host "rm -rf /var/www/app"').reason).toMatch(/^on host: /);
    expect(shell('psql -h db.prod.example.com -c "DROP TABLE users"').reason).toContain('db.prod.example.com');
  });

  it('a Sentinel operation on a command tool is a Sentinel operation, not a command line', () => {
    expect(autonomousDecision({ tool: 'shell', operation: 'sentinel:delete github.com shell' }, ctx).decision).toBe('ask');
    expect(autonomousDecision({ tool: 'shell', operation: 'sentinel:other - shell' }, ctx).decision).toBe('allow');
  });

  it('non-command tools never get shell parsing (no substring false prompts)', () => {
    for (const tool of ['mcp:fs:shutdown_server', 'mission_start', 'browser_click', 'todo_write']) {
      expect(autonomousDecision({ tool, operation: 'rm -rf ~ && shutdown now && git push --force' }, ctx).decision, tool).toBe('allow');
    }
  });
});

describe('autonomousDecision — file edits and Sentinel operations', () => {
  it('edits inside the roots run; outside ask with the path', () => {
    for (const p of ['src/a.ts', '/work/proj/README.md', 'deep/new/file.ts', '/scratch/tmp/x.json']) {
      expect(autonomousDecision({ tool: 'write_file', operation: p }, ctx), p).toEqual({ decision: 'allow' });
    }
    for (const tool of ['write_file', 'edit_text', 'multi_edit', 'multi_file_edit', 'edit_symbol']) {
      const v = autonomousDecision({ tool, operation: '../../etc/hosts' }, ctx);
      expect(v.decision, tool).toBe('ask');
      expect(v.reason).toMatch(/\/etc\/hosts \(outside the project\)/);
    }
    expect(autonomousDecision({ tool: 'edit_text', operation: path.join(os.homedir(), '.bashrc') }, ctx).reason).toMatch(/~\/\.bashrc/);
  });

  it('Sentinel delete/account on a remote host asks; locally or other categories run', () => {
    const s = (operation: string) => autonomousDecision({ tool: 'browser_click', operation }, ctx);
    expect(s('sentinel:delete github.com browser_click')).toMatchObject({ decision: 'ask', reason: expect.stringContaining('github.com') });
    expect(s('sentinel:account accounts.google.com browser_click').decision).toBe('ask');
    expect(s('sentinel:delete - mcp:linear:delete_issue').decision).toBe('ask');
    expect(s('sentinel:delete localhost browser_click').decision).toBe('allow');
    expect(s('sentinel:delete 127.0.0.1 browser_click').decision).toBe('allow');
    for (const cat of ['upload', 'desktop', 'navigation', 'other', 'send', 'publish', 'download']) {
      expect(s(`sentinel:${cat} example.com browser_click`).decision, cat).toBe('allow');
    }
  });
});

describe('workspace roots', () => {
  it('cwd + extra roots + temp dirs; ~ in extra roots expands', () => {
    const r = workspaceRoots('/work/proj', ['~/shared', '../lib']);
    expect(r).toContain('/work/proj');
    expect(r).toContain(path.join(os.homedir(), 'shared'));
    expect(r).toContain('/work/lib');
    expect(r).toContain(path.resolve(os.tmpdir()));
  });

  it('$(mktemp -d) is the temp dir, which is a root', () => {
    const c = { cwd: CWD, roots: workspaceRoots(CWD) };
    expect(autonomousDecision({ tool: 'shell', operation: 'rm -rf $(mktemp -d)' }, c).decision).toBe('allow');
    expect(autonomousDecision({ tool: 'shell', operation: `rm -rf ${os.tmpdir()}/qx-x` }, c).decision).toBe('allow');
    expect(autonomousDecision({ tool: 'shell', operation: `rm -rf ${os.tmpdir()}` }, c).decision).toBe('ask');
  });

  it('a cwd of /, $HOME or a parent of $HOME is not a root', () => {
    expect(workspaceRoots('/')).not.toContain('/');
    expect(workspaceRoots(os.homedir())).not.toContain(os.homedir());
    expect(workspaceRoots(path.dirname(os.homedir()))).not.toContain(path.dirname(os.homedir()));
    const home = os.homedir();
    const v = autonomousDecision({ tool: 'shell', operation: 'rm -rf Documents' }, { cwd: home, roots: workspaceRoots(home) });
    expect(v.decision).toBe('ask');
  });

  it('isInsideRoots is a pure prefix check on path segments', () => {
    expect(isInsideRoots('src/x', ctx)).toBe(true);
    expect(isInsideRoots('/work/proj', ctx)).toBe(true);
    expect(isInsideRoots('/work/proj2/x', ctx)).toBe(false);
    expect(isInsideRoots('../proj2', ctx)).toBe(false);
  });

  it('a symlink inside the project that points outside is outside', () => {
    const fs = require('fs') as typeof import('fs');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-auto-link-'));
    const proj = path.join(base, 'proj');
    const outside = fs.mkdtempSync(path.join(os.homedir(), '.qx-auto-out-'));
    try {
      fs.mkdirSync(proj);
      fs.symlinkSync(outside, path.join(proj, 'link'));
      const c = { cwd: proj, roots: [proj] };
      expect(editPathDecision('link/file.txt', c).decision).toBe('ask');
      expect(autonomousDecision({ tool: 'shell', operation: 'rm -rf link/' }, c).decision).toBe('ask');
      expect(editPathDecision('real.txt', c).decision).toBe('allow');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('local destructive commands (snapshot candidates)', () => {
  it('flags in-project irreversible commands, not ordinary ones or outside ones', () => {
    expect(localDestructiveReason('rm -rf build', ctx)).toMatch(/delete/);
    expect(localDestructiveReason('git reset --hard', ctx)).toMatch(/reset --hard/);
    expect(localDestructiveReason('git clean -fd', ctx)).toMatch(/untracked/);
    expect(localDestructiveReason('git checkout -- .', ctx)).toMatch(/discards/);
    expect(localDestructiveReason('npm test', ctx)).toBeNull();
    expect(localDestructiveReason('git -C ~/other reset --hard', ctx)).toBeNull();
  });
});

describe('parser edge cases', () => {
  it('never throws and flags malformed input', () => {
    for (const s of ['echo "unterminated', "echo 'x", 'echo $(ls', 'echo `ls', '((', ')))', '<<', '|||', '${', '\\']) {
      expect(() => parseShell(s)).not.toThrow();
      expect(() => analyzeShell(s, ctx)).not.toThrow();
    }
    expect(parseShell('echo "x').error).toBeTruthy();
    expect(parseShell('echo ok').error).toBeUndefined();
  });

  it('splits on every control operator, including newlines and subshells', () => {
    const exes = analyzeShell('a; b && c || d | e & f\ng (h) $(i) `j`', ctx).segments.map(s => s.exe).filter(Boolean).sort();
    expect(exes).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('here-doc bodies are data, not commands (unless fed to a shell)', () => {
    expect(analyzeShell('cat <<EOF > notes\nrm -rf ~\nEOF\nls', ctx).segments.map(s => s.exe)).toEqual(['cat', 'ls']);
  });

  it('needsHumanMessage names every way to approve', () => {
    const m = needsHumanMessage('rm -rf ~/x', 'deletes ~/x (outside the project)');
    expect(m).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\]/);
    expect(m).toMatch(/interactively/);
    expect(m).toMatch(/control center/);
    expect(m).toMatch(/Telegram/);
  });
});
