import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import type { SessionRequest } from '../auth/session.guard.js';
import { ExportService } from './export.service.js';

@Controller()
export class ExportController {
  constructor(private service: ExportService) {}

  @Post('exports')
  @HttpCode(202)
  create(@Req() req: SessionRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }

  @Get('exports/:id')
  get(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(req, id);
  }

  @Get('exports/:id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.service.download(req, id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      length: file.buffer.length,
      disposition: "attachment; filename*=UTF-8''" +
        encodeURIComponent(file.fileName).replace(/'/g, '%27'),
    });
  }
}
