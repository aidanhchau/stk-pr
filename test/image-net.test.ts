import { describe, expect, test } from "bun:test";
import { assertPublic, isPrivateAddress } from "../src/image-net";
import { svgZoom } from "../src/svg-bounds";

describe("isPrivateAddress", () => {
  test("blocks loopback, private, link-local, CGNAT, metadata, multicast and unspecified IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "140.82.112.3", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  test("blocks loopback, unique-local, link-local and mapped/embedded private IPv6; allows global", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  test("anything that is not an IP counts as private", () => {
    expect(isPrivateAddress("localhost")).toBe(true);
  });
});

describe("assertPublic", () => {
  test("rejects http, literal private hosts and localhost", async () => {
    await expect(assertPublic(new URL("http://example.com/a.png"))).rejects.toThrow("unsupported");
    await expect(assertPublic(new URL("https://127.0.0.1/a.png"))).rejects.toThrow("blocked");
    await expect(assertPublic(new URL("https://[::1]/a.png"))).rejects.toThrow("blocked");
    await expect(assertPublic(new URL("https://169.254.169.254/latest/meta-data"))).rejects.toThrow("blocked");
    await expect(assertPublic(new URL("https://localhost/a.png"))).rejects.toThrow("blocked");
  });
});

describe("svgZoom", () => {
  test("a normal diagram renders 1.2k-2.4k px wide", () => {
    expect(svgZoom(1000, 380)).toBe(2);
    expect(svgZoom(300, 100)).toBe(4);
    expect(svgZoom(3000, 1000)).toBeCloseTo(0.8);
  });
  test("height and total pixels are bounded", () => {
    const z = svgZoom(1000, 9000)!;
    expect(1000 * z).toBeLessThan(500);
    expect(9000 * z).toBeLessThanOrEqual(2400);
    const big = svgZoom(2400, 2400)!;
    expect(2400 * big * 2400 * big).toBeLessThanOrEqual(4_000_000 * 1.001);
  });
  test("absurd or empty sizes are unrenderable", () => {
    expect(svgZoom(1, 100000)).toBeNull();
    expect(svgZoom(100000, 10)).toBeNull();
    expect(svgZoom(0, 10)).toBeNull();
    expect(svgZoom(Infinity, 10)).toBeNull();
    expect(svgZoom(NaN, 10)).toBeNull();
  });
});
