import { decideGate } from '../core/safety';
import { main, plan } from '../cli/run';

describe('load harness CLI (dry-run path)', () => {
  it('lists scenarios', () => {
    const p = plan(['--list']);
    expect(p.errors).toEqual([]);
    expect(p.text).toContain('lk-listeners-3000');
  });

  it('defaults to a dry-run with no target', () => {
    const p = plan(['--scenario', 'lk-listeners-500']);
    expect(p.config).toBeDefined();
    expect(p.config?.allowLoad).toBe(false);
    expect(p.config?.target).toBeNull();
    expect(decideGate(p.config!).mode).toBe('dry-run');
    expect(p.text).toContain('MODE     : DRY-RUN');
  });

  it('reports an unknown scenario as an error', () => {
    const p = plan(['--scenario', 'does-not-exist']);
    expect(p.config).toBeUndefined();
    expect(p.errors.some((e) => e.includes('unknown scenario'))).toBe(true);
  });

  it('shows a REAL LOAD banner only when allow-load + target are present', () => {
    const p = plan([
      '--scenario',
      'lk-listeners-500',
      '--allow-load',
      '--target',
      'wss://livekit-staging.adlink4.com',
    ]);
    expect(decideGate(p.config!).mode).toBe('real-load');
    expect(p.text).toContain('REAL LOAD WILL BE GENERATED');
    expect(p.text).toContain('wss://livekit-staging.adlink4.com');
  });

  it('renders a refusal when allow-load is set without a target', () => {
    const p = plan(['--scenario', 'lk-listeners-500', '--allow-load']);
    expect(decideGate(p.config!).mode).toBe('refused');
    expect(p.text).toContain('Refused because');
  });

  it('main() returns 0 for a dry-run and never connects', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const code = await main(['--scenario', 'lk-listeners-3000']);
      expect(code).toBe(0);
      const printed = out.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('Dry-run only — no load generated');
    } finally {
      out.mockRestore();
    }
  });

  it('main() returns 2 on a malformed scenario', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const code = await main(['--scenario', 'lk-listeners-500', '--rooms', '0']);
      expect(code).toBe(2);
    } finally {
      out.mockRestore();
    }
  });

  it('main() returns 3 when a real run is refused (no target)', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const code = await main(['--scenario', 'lk-listeners-500', '--allow-load']);
      expect(code).toBe(3);
    } finally {
      out.mockRestore();
    }
  });
});
