const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const YOUTUBE_EXTENSION_ID = 'majmclipplgfbommldfilmkmbnanjbec';
const NATIVE_HOST_NAME = 'com.resuaumis.kanaric';

function runGitRevParse(devRoot, flag) {
  try {
    return execFileSync('git', [
      '-C', devRoot, 'rev-parse', '--path-format=absolute', flag,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => path.resolve(String(value).trim());
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function resolveGitCommonRoot(devRoot, {
  fsImpl = fs,
  gitRevParseImpl = runGitRevParse,
} = {}) {
  let topLevel;
  try {
    topLevel = gitRevParseImpl(devRoot, '--show-toplevel');
  } catch {
    return null;
  }

  const topLevelRoot = typeof topLevel === 'string' ? topLevel.trim() : '';
  if (!samePath(topLevelRoot, devRoot)) return null;

  let commonDir;
  try {
    commonDir = gitRevParseImpl(devRoot, '--git-common-dir');
  } catch {
    return null;
  }
  if (typeof commonDir !== 'string' || !commonDir.trim()) return null;
  const commonGitDir = path.resolve(devRoot, commonDir.trim());
  if (path.basename(commonGitDir).toLowerCase() !== '.git') return null;
  try {
    if (!fsImpl.statSync(commonGitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.dirname(commonGitDir);
}

function resolveNativeHostExecutable({
  isPackaged,
  resourcesPath,
  devRoot,
  fsImpl = fs,
  gitRevParseImpl = runGitRevParse,
}) {
  const candidates = isPackaged
    ? [path.join(resourcesPath, 'pytools', 'pytools.exe')]
    : [path.join(devRoot, 'dist-py', 'pytools', 'pytools.exe')];

  if (!isPackaged) {
    const commonRoot = resolveGitCommonRoot(devRoot, { fsImpl, gitRevParseImpl });
    if (commonRoot) candidates.push(path.join(commonRoot, 'dist-py', 'pytools', 'pytools.exe'));
  }

  const executable = candidates.find((candidate) => fsImpl.existsSync(candidate));
  if (executable) return executable;

  const nextStep = isPackaged
    ? 'Reinstall the packaged app with its pytools resource.'
    : 'Build the development pytools executable or use a checkout that already contains it.';
  throw new Error(`Native Messaging host executable not found. Checked: ${candidates.join(', ')}. ${nextStep}`);
}

function registerNativeMessagingHost({
  executable,
  dataDir,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
}) {
  const manifestPath = path.join(dataDir, 'native-messaging-host.json');
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Kanaric YouTube Karaoke Native Messaging host',
    path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${YOUTUBE_EXTENSION_ID}/`],
  };

  try {
    fsImpl.mkdirSync(dataDir, { recursive: true });
    fsImpl.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    execFileSyncImpl('reg.exe', [
      'ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
    ], { windowsHide: true, stdio: 'ignore' });
    return manifestPath;
  } catch (error) {
    throw new Error(`Native Messaging host registration failed: ${error.message}`, { cause: error });
  }
}

function installNativeMessagingHost({
  platform = process.platform,
  isPackaged,
  resourcesPath,
  devRoot,
  dataDir,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  gitRevParseImpl = runGitRevParse,
  onError = (message, error) => console.error(message, error),
}) {
  if (platform !== 'win32') return false;

  try {
    const executable = resolveNativeHostExecutable({
      isPackaged, resourcesPath, devRoot, fsImpl, gitRevParseImpl,
    });
    registerNativeMessagingHost({ executable, dataDir, fsImpl, execFileSyncImpl });
    return true;
  } catch (error) {
    const message = `Native Messaging host setup failed (${isPackaged ? 'packaged' : 'development'}): ${error.message}`;
    onError(message, error);
    return false;
  }
}

module.exports = {
  YOUTUBE_EXTENSION_ID,
  installNativeMessagingHost,
  registerNativeMessagingHost,
  resolveGitCommonRoot,
  resolveNativeHostExecutable,
};
