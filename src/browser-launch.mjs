import { spawn } from 'node:child_process';
import process from 'node:process';

export function browserLaunchCommand(url, { platform = process.platform } = {}) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, {
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  log = message => console.log(message),
} = {}) {
  if (environment.FIELDWORK_NO_BROWSER) return Object.freeze({ requested: false, reason: 'disabled' });

  const [command, args] = browserLaunchCommand(url, { platform });
  let reported = false;
  const showFallback = () => {
    if (reported) return;
    reported = true;
    log(`Open this in your browser: ${url}`);
  };

  try {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', showFallback);
    child.once('exit', code => { if (code !== 0) showFallback(); });
    child.unref();
    return Object.freeze({ requested: true, command });
  } catch {
    showFallback();
    return Object.freeze({ requested: false, reason: 'launch-failed' });
  }
}
