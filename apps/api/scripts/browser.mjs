import { chromium, firefox, webkit } from 'playwright-core';

const browsers = new Map([
  ['chromium', [chromium, undefined]],
  ['msedge', [chromium, 'msedge']],
  ['chrome', [chromium, 'chrome']],
  ['firefox', [firefox, undefined]],
  ['webkit', [webkit, undefined]],
]);

export async function launchBrowser({ headless }) {
  const name = process.env.HY_BROWSER?.trim().toLowerCase() || 'auto';
  if (name !== 'auto' && !browsers.has(name))
    throw new Error('HY_BROWSER 可选 auto、' + [...browsers.keys()].join('、'));

  const errors = [];
  const candidates = name === 'auto' ? ['chromium', 'msedge', 'chrome', 'firefox'] : [name];
  for (const key of candidates) {
    const [engine, channel] = browsers.get(key);
    try {
      const browser = await engine.launch({ channel, headless });
      console.info('已启动浏览器 ' + key + ' ' + browser.version());
      return browser;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(
    errors,
    '无法启动浏览器（' + name + '）。请按 README 安装对应引擎或选择本机可用的浏览器。',
  );
}
