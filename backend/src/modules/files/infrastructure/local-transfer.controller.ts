import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';

import { FailureException } from '../../../platform/http/http-failure';
import { PublicRoute } from '../../../platform/http/public-route.decorator';
import { CLOCK, failure, type Clock } from '../../../shared';
import { normalizeContentType } from '../domain/file-policy';
import { LocalStorageProvider } from './local-storage-provider';

const LINK_INVALID = new FailureException(
  failure('forbidden', 'files.link_invalid', 'This link is invalid or has expired.'),
);

/**
 * The local storage adapter's HTTP face: what an object store would serve
 * itself. It lives beside the adapter, in infrastructure, because it IS the
 * adapter — an S3 deployment has no such routes at all.
 *
 * Both routes are public in the AccessGuard's sense: the signature in the URL
 * is the authorization, exactly as with a presigned object-store URL. Each
 * signature is purpose-bound (see LocalStorageProvider), so a download link
 * cannot upload and an upload link cannot download.
 *
 * No per-IP rate limit, on purpose. Upload URLs are only issued by the
 * authenticated, per-user-limited upload request, and each writes once.
 * Downloads are what a classroom behind one school NAT does all day; a per-IP
 * cap would throttle the whole school at once.
 */
@Controller('files/local')
export class LocalTransferController {
  constructor(
    private readonly storage: LocalStorageProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Put(':token')
  @PublicRoute()
  @HttpCode(HttpStatus.CREATED)
  async upload(@Param('token') token: string, @Req() request: Request): Promise<void> {
    const grant = this.storage.verifyUpload(token, request.query);
    if (grant === null) throw LINK_INVALID;

    // The type is bound into the signature; the request must carry it exactly.
    if (normalizeContentType(request.headers['content-type'] ?? '') !== grant.contentType) {
      throw new FailureException(
        failure(
          'validation',
          'files.content_type_mismatch',
          `The upload must be sent as ${grant.contentType}.`,
        ),
      );
    }

    // A declared length, as an object store demands: an oversized body is
    // refused before a byte of it is read. The streaming ceiling below is
    // the second line, not the first.
    const declared = request.headers['content-length'];
    if (declared === undefined || !/^\d{1,12}$/.test(declared)) {
      throw new FailureException(
        failure('validation', 'files.length_required', 'Content-Length is required.'),
      );
    }
    const length = Number(declared);
    if (length === 0 || length > grant.maxBytes) {
      throw new FailureException(
        failure(
          'validation',
          length === 0 ? 'files.empty' : 'files.too_large',
          length === 0 ? 'The file is empty.' : 'The file is larger than this upload allows.',
          { maxBytes: grant.maxBytes },
        ),
      );
    }

    const outcome = await this.storage.writeOnce(grant.storageKey, request, grant.maxBytes);
    switch (outcome) {
      case 'written':
        return;
      case 'exists':
        throw new FailureException(
          failure('conflict', 'files.already_uploaded', 'This file was already uploaded.'),
        );
      case 'too_large':
        throw new FailureException(
          failure('validation', 'files.too_large', 'The file is larger than this upload allows.', {
            maxBytes: grant.maxBytes,
          }),
        );
      case 'incomplete':
        throw new FailureException(
          failure('validation', 'files.upload_incomplete', 'The upload did not finish.'),
        );
    }
  }

  @Get(':token')
  @PublicRoute()
  async download(
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const grant = this.storage.verifyDownload(token, request.query);
    if (grant === null) throw LINK_INVALID;

    const object = await this.storage.openRead(grant.storageKey);
    if (object === null) {
      throw new FailureException(failure('not_found', 'files.asset_not_found', 'No such file.'));
    }

    const remaining = Math.max(
      0,
      Math.floor((grant.expiresAt.getTime() - this.clock.now().getTime()) / 1000),
    );
    response.setHeader('Content-Type', grant.contentType);
    response.setHeader(
      'Content-Disposition',
      contentDisposition(grant.disposition, grant.fileName),
    );
    // Stored bytes are shown as what they were verified to be, never sniffed
    // into something else, and never run as a page.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // The URL dies at expiry; so does any cached copy of what it served.
    response.setHeader('Cache-Control', `private, max-age=${remaining}`);
    response.setHeader('Accept-Ranges', 'bytes');

    // Audio players (AVPlayer, Safari) will not play without byte ranges.
    const range = parseRange(request.headers.range, object.byteSize);
    if (range === 'unsatisfiable') {
      await object.close();
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      response.setHeader('Content-Range', `bytes */${object.byteSize}`);
      response.end();
      return;
    }
    if (range === null) {
      response.status(HttpStatus.OK);
      response.setHeader('Content-Length', String(object.byteSize));
    } else {
      response.status(HttpStatus.PARTIAL_CONTENT);
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${object.byteSize}`);
      response.setHeader('Content-Length', String(range.end - range.start + 1));
    }

    try {
      await pipeline(object.stream(range ?? undefined), response);
    } catch {
      // The client went away mid-transfer. The stream closed the file; there
      // is no one left to answer.
    }
  }
}

/**
 * One `bytes=` range, inclusive. Null means "serve everything" — no header, a
 * malformed one, or several ranges (which a server may ignore, RFC 9110
 * §14.2). Unsatisfiable only when the range starts past the end.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;

  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

/**
 * RFC 6266: an ASCII fallback for old clients, and the exact name as UTF-8 —
 * names here are often Arabic. The name was sanitized at upload (no control
 * characters, quotes or separators) and is signed into the URL; the fallback
 * is made safe again regardless, because it goes into a header.
 */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
