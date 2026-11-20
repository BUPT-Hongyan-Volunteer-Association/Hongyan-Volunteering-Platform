import { Injectable } from '@nestjs/common';

// 服务端时钟。通知投递与回执时间都从这里取，测试可以整体拨动而不改业务代码。
@Injectable()
export class Clock {
  private offset = 0;

  now(): Date {
    return new Date(Date.now() + this.offset);
  }

  advance(milliseconds: number) {
    this.offset += milliseconds;
  }
}
