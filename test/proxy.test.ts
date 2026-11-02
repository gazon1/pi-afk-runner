/**
 * The proxy the runner's HTTP goes through.
 *
 * The pool may give every model a proxy of its own, and the dispatcher the
 * SDK's fetch uses is what carries it.
 */

import { EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { useProxy } from "../src/proxy.js";

describe("the proxy", () => {
  afterEach(() => {
    // The dispatcher is global: the tests must not leave one behind.
    useProxy(undefined, {});
  });

  it("routes_through_the_proxy_the_model_names", () => {
    expect(useProxy("http://127.0.0.1:8080")).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });

  it("falls_back_to_the_host_proxy_when_the_model_has_none", () => {
    expect(useProxy(undefined, { HTTPS_PROXY: "http://127.0.0.1:9090" })).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("goes_direct_when_there_is_no_proxy_at_all", () => {
    expect(useProxy(undefined, {})).toBe(false);
    expect(getGlobalDispatcher()).not.toBeInstanceOf(EnvHttpProxyAgent);
    expect(getGlobalDispatcher()).not.toBeInstanceOf(ProxyAgent);
  });
});
