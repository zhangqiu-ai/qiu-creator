import net from 'node:net';

/**
 * Address ranges a URL import must never reach. Covers loopback, private
 * networks, link-local, CGNAT (which includes Tailscale's 100.64.0.0/10),
 * multicast, documentation/benchmark/reserved ranges, and IPv6 forms that
 * embed or tunnel to IPv4 (NAT64, 6to4, Teredo). IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`) is unwrapped and checked as IPv4.
 */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT, Tailscale
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const BLOCKED_V6: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32, ORCHID)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const blockList = new net.BlockList();
for (const [addr, prefix] of BLOCKED_V4) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of BLOCKED_V6) blockList.addSubnet(addr, prefix, 'ipv6');

/** Extract the IPv4 address from `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx`, if that is what this is. */
function unmapIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

export interface AddressVerdict {
  allowed: boolean;
  /** Normalized address actually checked (IPv4 for mapped addresses). */
  address: string;
}

/** Decide whether a resolved IP may be contacted by the URL importer. Non-IP input is blocked. */
export function checkAddress(raw: string): AddressVerdict {
  const address = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(address);
  if (family === 0) return { allowed: false, address };
  if (family === 6) {
    const v4 = unmapIpv4(address);
    if (v4 !== undefined) return { allowed: !blockList.check(v4, 'ipv4'), address: v4 };
    return { allowed: !blockList.check(address, 'ipv6'), address };
  }
  return { allowed: !blockList.check(address, 'ipv4'), address };
}

export function isBlockedAddress(raw: string): boolean {
  return !checkAddress(raw).allowed;
}
