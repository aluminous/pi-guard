// When network sandboxing is disabled, the seatbelt runtime config must not
// set up the sandbox-runtime proxy at all: no allowedDomains (which arms
// domain filtering and proxy env injection), no proxy-engaging extras from
// seatbelt.network overrides, and external placeholder ports so
// SandboxManager.initialize() skips starting its local proxy listeners.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSeatbeltRuntimeConfig } from "../src/backends/seatbelt.ts";
import { testConfig } from "./helpers.ts";

describe("network disabled: proxy is not set up", () => {
  it("omits allowedDomains and disables domain filtering", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig((c) => { c.network.enabled = false; }));
    const net = runtime.network as Record<string, unknown>;
    assert.equal(Object.hasOwn(net, "allowedDomains"), false, `unexpected allowedDomains in ${JSON.stringify(net)}`);
    assert.deepEqual(net.deniedDomains, []);
    assert.equal(net.strictAllowlist, false);
  });

  it("declares external proxy ports so sandbox-runtime never starts a local proxy", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig((c) => { c.network.enabled = false; }));
    const net = runtime.network as Record<string, unknown>;
    assert.equal(typeof net.httpProxyPort, "number", "httpProxyPort must be set so the local mux proxy is skipped");
    assert.equal(typeof net.socksProxyPort, "number", "socksProxyPort must be set so the local mux proxy is skipped");
  });

  it("strips proxy-engaging fields injected via seatbelt.network overrides", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig((c) => {
      c.network.enabled = false;
      c.seatbelt.network = {
        allowedDomains: ["example.com"],
        tlsTerminate: {},
        mitmProxy: { socketPath: "/tmp/mitm.sock", domains: ["example.com"] },
        filterRequest: () => ({ action: "allow" }),
        parentProxy: { http: "http://corp:3128" },
        httpProxyPort: 3128,
      };
    }));
    const net = runtime.network as Record<string, unknown>;
    for (const field of ["allowedDomains", "tlsTerminate", "mitmProxy", "filterRequest", "parentProxy"]) {
      assert.equal(Object.hasOwn(net, field), false, `${field} must not survive network.enabled=false`);
    }
    assert.notEqual(net.httpProxyPort, 3128, "override proxy port must not survive network.enabled=false");
    assert.equal(net.socksProxyPort, 9);
  });

  it("keeps proxy machinery available when network sandboxing is enabled", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig());
    const net = runtime.network as Record<string, unknown>;
    assert.ok(Array.isArray(net.allowedDomains), "enabled networking must keep allowedDomains");
    assert.equal(Object.hasOwn(net, "httpProxyPort"), false, "enabled networking must not fake external proxy ports");
    assert.equal(Object.hasOwn(net, "socksProxyPort"), false);
  });

  it("keeps an empty allowlist as deny-all when network sandboxing is enabled", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig((c) => {
      c.network.enabled = true;
      c.network.allowedDomains = [];
    }));
    const net = runtime.network as Record<string, unknown>;
    assert.deepEqual(net.allowedDomains, []);
    assert.equal(Object.hasOwn(net, "httpProxyPort"), false);
  });
});
