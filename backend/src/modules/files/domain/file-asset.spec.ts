import { markAvailable, markRejected, pendingAsset, type FileAssetId } from './file-asset';

const AT = new Date('2026-09-01T08:00:00Z');

const pending = () =>
  pendingAsset({
    id: 'asset-1' as FileAssetId,
    ownerUserId: 'user-1',
    storageKey: 'image/2026/09/asset-1',
    upload: {
      kind: 'IMAGE',
      contentType: 'image/png',
      byteSize: 10,
      displayName: 'a.png',
      durationMs: null,
      width: null,
      height: null,
    },
    at: AT,
  });

describe('file asset lifecycle', () => {
  it('starts pending, with nothing completed', () => {
    expect(pending()).toMatchObject({ status: 'PENDING', completedAt: null });
  });

  it('becomes available once, and only from pending', () => {
    const available = markAvailable(pending(), AT);
    expect(available.ok && available.value.status).toBe('AVAILABLE');
    if (!available.ok) return;
    const again = markAvailable(available.value, AT);
    expect(!again.ok && again.error.code).toBe('files.upload_already_completed');
    expect(markAvailable(markRejected(pending(), AT), AT).ok).toBe(false);
  });
});
