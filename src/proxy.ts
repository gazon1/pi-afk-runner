/**
 * The proxy the runner's HTTP goes through.
 *
 * The SDK installs its own dispatcher, and that one does not read the
 * environment: a provider that is only reachable through a proxy — which is
 * the usual case for a self-hosted or regional API — is simply unreachable,
 * and the request dies at the SDK's timeout with nothing in the log to say
 * why. So the runner installs a dispatcher of its own.
 *
 * The pool may give every model a proxy of its own, and the dispatcher is
 * installed per model: the model's own proxy when the file names one, the
 * host's own from the environment otherwise.
 */

import {
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

/**
 * The dispatcher the SDK's fetch used before the runner changed it.
 *
 * It is the way back: a model without a proxy of its own goes through the
 * host's own proxy, or through no proxy at all.
 */
const original = getGlobalDispatcher();

/** The proxy the environment names, when it names one. */
export function proxyFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  return proxy === undefined || proxy === "" ? undefined : proxy;
}

/**
 * Route the SDK's HTTP through a proxy.
 *
 * The proxy is the model's own when the pool's file names one, and the host's
 * own from the environment when it does not. Nothing happens when there is no
 * proxy at all: a host that reaches its provider directly keeps the SDK's own
 * dispatcher.
 *
 * The fetch goes with the dispatcher: the SDK's provider calls use the global
 * fetch, and the global fetch of Node's own does not read undici's global
 * dispatcher.
 */
export function useProxy(proxy: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (proxy !== undefined) {
    setGlobalDispatcher(new ProxyAgent(proxy));
    globalThis.fetch = undiciFetch as typeof globalThis.fetch;
    return true;
  }
  if (proxyFromEnvironment(env) === undefined) {
    setGlobalDispatcher(original);
    return false;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
  globalThis.fetch = undiciFetch as typeof globalThis.fetch;
  return true;
}
