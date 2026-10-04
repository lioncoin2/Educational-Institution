import { parseDefaultRouteIface } from '../observe/host-base';

/** The generator samples the NIC that carries its default route, whatever it is called. */
const HEADER = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT';

describe('default-route interface', () => {
  it('picks the interface of the IPv4 default route', () => {
    const text = `${HEADER}\neth0\t00000000\t014188D5\t0003\t0\t0\t0\t00000000\t0\t0\t0\ndocker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n`;
    expect(parseDefaultRouteIface(text)).toBe('eth0');
  });

  it('prefers the lowest metric when several default routes exist', () => {
    const text = `${HEADER}\nens3\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\nens4\t00000000\t0102A8C0\t0003\t0\t0\t50\t00000000\t0\t0\t0\n`;
    expect(parseDefaultRouteIface(text)).toBe('ens4');
  });

  it('is null without a default route (never guesses)', () => {
    expect(
      parseDefaultRouteIface(
        `${HEADER}\nlo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n`,
      ),
    ).toBeNull();
    expect(parseDefaultRouteIface('')).toBeNull();
  });
});
