const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveNativeHostExecutable,
  registerNativeMessagingHost,
  installNativeMessagingHost,
} = require('../web-app/native-messaging-host.js');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-native-host-'));
const worktreeRoot = path.join(fixtureRoot, 'linked-worktree');
const commonRoot = path.join(fixtureRoot, 'canonical-checkout');
const worktreeGitDir = path.join(commonRoot, '.git', 'worktrees', 'linked-worktree');
const commonExecutable = path.join(commonRoot, 'dist-py', 'pytools', 'pytools.exe');

fs.mkdirSync(worktreeRoot, { recursive: true });
fs.mkdirSync(worktreeGitDir, { recursive: true });
fs.mkdirSync(path.dirname(commonExecutable), { recursive: true });
fs.writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);
fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
fs.writeFileSync(commonExecutable, 'fixture');

const gitCalls = [];
const gitRevParseImpl = (root, flag) => {
  gitCalls.push([root, flag]);
  return flag === '--show-toplevel'
    ? worktreeRoot
    : path.join(commonRoot, '.git');
};

assert.equal(resolveNativeHostExecutable({
  isPackaged: false,
  devRoot: worktreeRoot,
  gitRevParseImpl,
}), commonExecutable);

const localExecutable = path.join(worktreeRoot, 'dist-py', 'pytools', 'pytools.exe');
fs.mkdirSync(path.dirname(localExecutable), { recursive: true });
fs.writeFileSync(localExecutable, 'local-fixture');
assert.equal(resolveNativeHostExecutable({
  isPackaged: false,
  devRoot: worktreeRoot,
}), localExecutable);

const packagedExecutable = path.join(fixtureRoot, 'resources', 'pytools', 'pytools.exe');
fs.mkdirSync(path.dirname(packagedExecutable), { recursive: true });
fs.writeFileSync(packagedExecutable, 'packaged-fixture');
assert.equal(resolveNativeHostExecutable({
  isPackaged: true,
  resourcesPath: path.join(fixtureRoot, 'resources'),
  devRoot: worktreeRoot,
}), packagedExecutable);

const outOfScopeRoot = path.join(fixtureRoot, 'out-of-scope-checkout');
const outOfScopeGitDir = path.join(outOfScopeRoot, '.git');
const outOfScopeWorktreeGitDir = path.join(outOfScopeGitDir, 'worktrees', 'other');
const outOfScopeExecutable = path.join(outOfScopeRoot, 'dist-py', 'pytools', 'pytools.exe');
const malformedWorktreeRoot = path.join(fixtureRoot, 'malformed-linked-worktree');
fs.mkdirSync(path.dirname(outOfScopeExecutable), { recursive: true });
fs.mkdirSync(malformedWorktreeRoot, { recursive: true });
fs.mkdirSync(outOfScopeWorktreeGitDir, { recursive: true });
fs.writeFileSync(path.join(malformedWorktreeRoot, '.git'), `gitdir: ${path.join(outOfScopeGitDir, 'worktrees', 'other')}\n`);
fs.writeFileSync(path.join(outOfScopeWorktreeGitDir, 'commondir'), '../..\n');
fs.writeFileSync(outOfScopeExecutable, 'out-of-scope-fixture');

const outOfScopeGitCalls = [];
const outOfScopeGitRevParseImpl = (root, flag) => {
  outOfScopeGitCalls.push([root, flag]);
  return flag === '--show-toplevel' ? outOfScopeRoot : outOfScopeGitDir;
};
assert.throws(() => resolveNativeHostExecutable({
  isPackaged: false,
  devRoot: malformedWorktreeRoot,
  gitRevParseImpl: outOfScopeGitRevParseImpl,
}), /Native Messaging host executable not found/);
assert.deepEqual(outOfScopeGitCalls, [
  [malformedWorktreeRoot, '--show-toplevel'],
]);

const blockedRegistryCalls = [];
const blockedErrors = [];
outOfScopeGitCalls.length = 0;
assert.equal(installNativeMessagingHost({
  platform: 'win32',
  isPackaged: false,
  devRoot: malformedWorktreeRoot,
  dataDir: path.join(fixtureRoot, 'blocked-user-data'),
  gitRevParseImpl: outOfScopeGitRevParseImpl,
  execFileSyncImpl: (...args) => blockedRegistryCalls.push(args),
  onError: (message) => blockedErrors.push(message),
}), false);
assert.equal(blockedRegistryCalls.length, 0);
assert.equal(blockedErrors.length, 1);
assert.match(blockedErrors[0], /Native Messaging host setup failed/);

const fileCommonRoot = path.join(fixtureRoot, 'file-common-checkout');
const fileCommonGitDir = path.join(fileCommonRoot, '.git');
const fileCommonExecutable = path.join(fileCommonRoot, 'dist-py', 'pytools', 'pytools.exe');
const fileCommonWorktreeRoot = path.join(fixtureRoot, 'file-common-worktree');
fs.mkdirSync(path.dirname(fileCommonExecutable), { recursive: true });
fs.mkdirSync(fileCommonWorktreeRoot, { recursive: true });
fs.writeFileSync(fileCommonGitDir, 'not-a-directory');
fs.writeFileSync(fileCommonExecutable, 'file-common-fixture');
const fileCommonGitRevParseImpl = (root, flag) => (
  flag === '--show-toplevel' ? fileCommonWorktreeRoot : fileCommonGitDir
);
assert.throws(() => resolveNativeHostExecutable({
  isPackaged: false,
  devRoot: fileCommonWorktreeRoot,
  gitRevParseImpl: fileCommonGitRevParseImpl,
}), /Native Messaging host executable not found/);
const fileCommonRegistryCalls = [];
assert.equal(installNativeMessagingHost({
  platform: 'win32',
  isPackaged: false,
  devRoot: fileCommonWorktreeRoot,
  dataDir: path.join(fixtureRoot, 'file-common-user-data'),
  gitRevParseImpl: fileCommonGitRevParseImpl,
  execFileSyncImpl: (...args) => fileCommonRegistryCalls.push(args),
  onError: () => {},
}), false);
assert.equal(fileCommonRegistryCalls.length, 0);

assert.deepEqual(gitCalls, [
  [worktreeRoot, '--show-toplevel'],
  [worktreeRoot, '--git-common-dir'],
]);

const dataDir = path.join(fixtureRoot, 'user-data');
const execCalls = [];
const manifestPath = registerNativeMessagingHost({
  executable: commonExecutable,
  dataDir,
  execFileSyncImpl: (...args) => execCalls.push(args),
});
assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
  name: 'com.resuaumis.kanaric',
  description: 'Kanaric YouTube Karaoke Native Messaging host',
  path: commonExecutable,
  type: 'stdio',
  allowed_origins: ['chrome-extension://majmclipplgfbommldfilmkmbnanjbec/'],
});
assert.deepEqual(execCalls, [[
  'reg.exe',
  [
    'ADD',
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.resuaumis.kanaric',
    '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
  ],
  { windowsHide: true, stdio: 'ignore' },
]]);

const errors = [];
assert.equal(installNativeMessagingHost({
  platform: 'win32',
  isPackaged: false,
  devRoot: path.join(fixtureRoot, 'missing-worktree'),
  dataDir: path.join(fixtureRoot, 'missing-user-data'),
  onError: (message) => errors.push(message),
}), false);
assert.equal(errors.length, 1);
assert.match(errors[0], /Native Messaging host setup failed/);
assert.match(errors[0], /pytools\.exe/);

const registrationErrors = [];
assert.equal(installNativeMessagingHost({
  platform: 'win32',
  isPackaged: false,
  devRoot: worktreeRoot,
  dataDir: path.join(fixtureRoot, 'registration-failure-user-data'),
  execFileSyncImpl: () => { throw new Error('reg.exe fixture failure'); },
  onError: (message) => registrationErrors.push(message),
}), false);
assert.equal(registrationErrors.length, 1);
assert.match(registrationErrors[0], /registration failed/);
assert.match(registrationErrors[0], /reg\.exe fixture failure/);

console.log('test_native_messaging_registration: OK');
