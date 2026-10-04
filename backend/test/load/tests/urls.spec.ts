import { checkHttpsUrl, checkWssUrl, livekitApiUrl } from '../core/urls';
import { connectOptionsFor } from '../core/identity';

describe('external URL validation', () => {
  it('accepts a public https API base', () => {
    const r = checkHttpsUrl('https://api-staging.adlink4.com');
    expect(r.ok).toBe(true);
    expect(r.host).toBe('api-staging.adlink4.com');
    expect(r.isLocal).toBe(false);
  });

  it('accepts a public wss livekit url', () => {
    const r = checkWssUrl('wss://livekit-staging.adlink4.com');
    expect(r.ok).toBe(true);
    expect(r.isLocal).toBe(false);
  });

  it('rejects the wrong scheme', () => {
    expect(checkHttpsUrl('http://x.com').ok).toBe(false);
    expect(checkWssUrl('https://x.com').ok).toBe(false);
    expect(checkWssUrl('not a url').ok).toBe(false);
    expect(checkHttpsUrl(null).ok).toBe(false);
  });

  it('flags local/private targets (off-box misconfig)', () => {
    expect(checkWssUrl('wss://localhost:7880').isLocal).toBe(true);
    expect(checkHttpsUrl('https://127.0.0.1:3000').isLocal).toBe(true);
    expect(checkHttpsUrl('https://10.0.0.5').isLocal).toBe(true);
    expect(checkHttpsUrl('https://172.30.0.1').isLocal).toBe(true);
    expect(checkHttpsUrl('https://box.local').isLocal).toBe(true);
  });

  it('derives the livekit http api url from wss', () => {
    expect(livekitApiUrl('wss://livekit-staging.adlink4.com')).toBe(
      'https://livekit-staging.adlink4.com',
    );
    expect(livekitApiUrl('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
  });
});

describe('TURN mode selection', () => {
  it('listeners subscribe, publishers do not; relay flows through unchanged', () => {
    expect(connectOptionsFor('listener', false)).toEqual({ subscribe: true, relay: false });
    expect(connectOptionsFor('speaker', false)).toEqual({ subscribe: false, relay: false });
    expect(connectOptionsFor('screen', true)).toEqual({ subscribe: false, relay: true });
    expect(connectOptionsFor('listener', true)).toEqual({ subscribe: true, relay: true });
  });
});
