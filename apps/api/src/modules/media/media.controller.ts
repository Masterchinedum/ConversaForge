import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/decorators';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';

/**
 * Serves local-driver media through HMAC-signed, expiring URLs issued by StorageService.signedUrl()
 * after an authorization check. (With the S3 driver, presigned bucket URLs are used instead.)
 * Supports HTTP Range requests so <audio>/<video> can seek.
 */
@ApiExcludeController()
@Controller('media')
export class MediaController {
  constructor(
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('signed/:token')
  async signed(@Param('token') token: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const data = this.crypto.verifyPayload<{ a: string; k: string; w: string }>(token);
    if (!data) throw Errors.forbidden('This link has expired');
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: data.a, workspaceId: data.w, storageKey: data.k, deletedAt: null } });
    if (!asset) throw Errors.notFound('Media');
    const buf = await this.storage.get(asset.storageKey);
    const total = buf.length;
    reply.header('Content-Type', asset.mimeType);
    reply.header('Cache-Control', 'private, max-age=300');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (asset.fileName) reply.header('Content-Disposition', `inline; filename="${asset.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      if (start >= total || start > end) {
        reply.status(416).header('Content-Range', `bytes */${total}`).send();
        return;
      }
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', end - start + 1);
      reply.send(buf.subarray(start, end + 1));
      return;
    }
    reply.header('Content-Length', total).send(buf);
  }
}
