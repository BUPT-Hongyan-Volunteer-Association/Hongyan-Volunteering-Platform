import { randomUUID } from 'node:crypto';
import { Controller, Get, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { invalid, invisible } from '../http.js';
import { staff } from './read.js';

export function parseGroupImage(data: string | undefined) {
  if (data === undefined) return;
  const comma = data.indexOf(',');
  const prefix = data.slice(0, comma);
  const type =
    prefix === 'data:image/png;base64'
      ? 'image/png'
      : prefix === 'data:image/jpeg;base64'
        ? 'image/jpeg'
        : '';
  const encoded = data.slice(comma + 1);
  const contents = Buffer.from(encoded, 'base64');
  const size = contents.length;
  if (!type || size > 5 * 1024 * 1024 || contents.toString('base64') !== encoded)
    invalid('group_qr_id', '请选择不超过 5 MB 的 PNG 或 JPEG 图片');
  const isImage =
    type === 'image/png'
      ? size >= 45 &&
        contents.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        contents.toString('ascii', 12, 16) === 'IHDR' &&
        contents.toString('ascii', size - 8, size - 4) === 'IEND'
      : size >= 12 &&
        contents.readUIntBE(0, 3) === 0xffd8ff &&
        contents.readUInt16BE(size - 2) === 0xffd9;
  if (!isImage) invalid('group_qr_id', '图片格式无效，请重新选择 PNG 或 JPEG');
  return { id: randomUUID(), media_type: type, contents: new Uint8Array(contents) };
}

@Controller('activity-group-images')
export class GroupImageController {
  constructor(private db: Database) {}
  @Get(':id') async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: SessionRequest,
    @Res() res: Response,
  ) {
    const image = await this.db.$transaction(
      async (tx) => {
        const actor = req.actor;
        const ref = await tx.activityGroupImage.findUnique({
          where: { id },
          select: {
            activity_id: true,
            activity: {
              select: {
                published_revision: true,
                status: true,
                members: { where: { account_id: actor.account_id }, select: { account_id: true } },
                registrations: {
                  where: { student_id: actor.student?.id ?? { in: [] }, status: 'accepted' },
                  select: { id: true },
                },
              },
            },
          },
        });
        if (!ref) invisible();
        const activity = ref.activity;
        const manager =
          staff(actor) || (actor.roles.includes('organizer') && activity.members.length > 0);
        const accepted =
          activity.registrations.length > 0 &&
          actor.roles.some((r) => r === 'organizer' || r === 'student');
        if (
          !manager &&
          (!accepted ||
            !activity.published_revision ||
            !['published', 'completed', 'cancelled'].includes(activity.status))
        )
          invisible();
        const visible = await tx.activityRevision.count({
          where: {
            activity_id: ref.activity_id,
            ...(!manager && { revision: activity.published_revision!, revision_state: 'approved' }),
            content: { path: ['group_qr_id'], equals: id },
          },
        });
        if (!visible) invisible();
        return tx.activityGroupImage.findUniqueOrThrow({ where: { id } });
      },
      { isolationLevel: 'RepeatableRead' },
    );
    res
      .set({
        'Cache-Control': 'private, no-store',
        'Content-Type': image.media_type,
        'X-Content-Type-Options': 'nosniff',
      })
      .send(Buffer.from(image.contents));
  }
}
