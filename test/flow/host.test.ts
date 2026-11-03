import { describe, expect, it } from "vitest";
import { isPrivateHostLiteral } from "../../src/flow/core/index.js";

describe("isPrivateHostLiteral", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "app.localhost",
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "::",
    "::1",
    "[::1]",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.1.2.3",
    "2130706433",
    "0x7f.1",
    "127.1",
  ])("private: %s", (h) => {
    expect(isPrivateHostLiteral(h)).toBe(true);
  });

  it.each([
    "example.com",
    "api.example.com",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "169.253.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "[2606:4700::1111]",
    "::ffff:8.8.8.8",
    "fec0::1",
    "localhost.example.com",
  ])("public: %s", (h) => {
    expect(isPrivateHostLiteral(h)).toBe(false);
  });
});
