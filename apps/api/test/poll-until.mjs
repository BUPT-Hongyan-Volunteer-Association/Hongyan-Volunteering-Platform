import { setTimeout as delay } from 'node:timers/promises';

export async function pollUntil(read, complete, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (complete(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  throw new Error(label + '超时，最后状态 ' + (value?.data?.status ?? value?.status ?? '未知'));
}
