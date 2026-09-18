import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompress, gunzip, inflate } from "node:zlib";

export interface WebAddress {
  address: string;
  family: number;
}
export type WebRequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
/** Server-owned configuration; never accept these values from an agent. */
export interface WebTransportOptions {
  lookup?: (hostname: string) => Promise<WebAddress[]>;
  request?: WebRequestFactory;
  timeoutMs?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
}

export class WebTransportError extends Error {}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PUBLIC_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
]);
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "content-length",
  "cookie",
  "cookie2",
]);

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    // Native global unicast only: no mapped/compatible IPv4, NAT64, Teredo,
    // 6to4, link-local, unique-local, multicast or documentation networks.
    if (address.includes("%")) return false;
    const [first, second = "0"] = new URL(`http://[${address}]/`).hostname
      .slice(1, -1)
      .split(":");
    const prefix = Number.parseInt(first, 16);
    const next = Number.parseInt(second || "0", 16);
    return (
      prefix >= 0x2000 &&
      prefix <= 0x3fff &&
      !(prefix === 0x2001 && (next < 0x200 || next === 0xdb8)) &&
      prefix !== 0x2002 &&
      !(prefix === 0x3fff && next < 0x1000)
    );
  }
  return false;
}

/** Syntactic/literal checks; DNS is checked and pinned at each connection. */
export function webUrl(value: unknown): URL {
  const input = value instanceof URL ? value.href : value;
  if (typeof input !== "string" || !input.trim() || input.length > 8192)
    throw new WebTransportError(
      "请输入有效的 HTTP(S) 网页地址（最长 8192 字符）。",
    );
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebTransportError("网页地址格式无效。");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new WebTransportError("网页工具仅支持 HTTP 和 HTTPS 地址。");
  if (url.username || url.password)
    throw new WebTransportError("网页地址不能包含用户名或密码。");
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw new WebTransportError(
      "网页工具仅允许访问公共互联网地址，不能访问本机或内网。",
    );
  url.hash = "";
  return url;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function requestBody(
  request: Request,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) return Buffer.concat(chunks);
      total += part.value.byteLength;
      if (total > maxBytes)
        throw new WebTransportError("网页请求内容过大，已阻止发送。");
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

async function requestOnce(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  signal: AbortSignal,
  options: WebTransportOptions,
): Promise<RawResponse> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await abortable(
        (
          options.lookup ??
          ((host) => dnsLookup(host, { all: true, verbatim: true }))
        )(hostname),
        signal,
      );
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) =>
        !publicAddress(address) || isIP(address) !== family,
    )
  )
    throw new WebTransportError(
      "域名解析到本机、内网或非公共地址，已阻止请求。",
    );
  const pinned = addresses[0];
  const lookup: RequestOptions["lookup"] = (_host, init, callback) => {
    if (init.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const request =
    options.request ??
    ((target, init, callback) =>
      (target.protocol === "https:" ? httpsRequest : httpRequest)(
        target,
        init,
        callback,
      ));
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      incoming?.destroy();
      client?.destroy();
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      fail(signal.reason);
      return;
    }
    try {
      const outgoing = Object.fromEntries(headers.entries());
      outgoing["accept-encoding"] = "identity";
      if (body) outgoing["content-length"] = String(body.length);
      client = request(
        url,
        { method, headers: outgoing, lookup, signal, agent: false },
        (response) => {
          incoming = response;
          if (settled) {
            response.destroy();
            return;
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599) {
            fail(new WebTransportError("网页服务返回了无效状态码。"));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value])
              responseHeaders.append(key, item);
          }
          const finish = (responseBody: Buffer) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
              status,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
              body: responseBody,
            });
          };
          if (
            REDIRECTS.has(status) ||
            method === "HEAD" ||
            [204, 205, 304].includes(status)
          ) {
            finish(Buffer.alloc(0));
            response.destroy();
            return;
          }
          const length = Number(response.headers["content-length"]);
          if (Number.isFinite(length) && length > maxBytes) {
            fail(new WebTransportError("网页响应超过大小限制。"));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > maxBytes) {
              fail(new WebTransportError("网页响应超过大小限制。"));
              return;
            }
            chunks.push(buffer);
          });
          response.on("error", fail);
          response.on("aborted", () =>
            fail(new WebTransportError("网页连接提前中断。")),
          );
          response.on("end", () => finish(Buffer.concat(chunks)));
        },
      );
      client.on("error", fail);
      client.end(body);
    } catch (error) {
      fail(error);
    }
  });
}

async function decodeResponse(
  response: RawResponse,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  const encoding = response.headers
    .get("content-encoding")
    ?.toLowerCase()
    .trim();
  if (!response.body.length || !encoding || encoding === "identity")
    return response.body;
  if (!["gzip", "deflate", "br"].includes(encoding))
    throw new WebTransportError("网页响应使用了不支持的压缩格式。");
  const output = await abortable(
    new Promise<Buffer>((resolve, reject) => {
      const callback = (error: Error | null, buffer: Buffer) =>
        error
          ? reject(new WebTransportError("网页压缩内容无效或超过大小限制。"))
          : resolve(buffer);
      if (encoding === "gzip")
        gunzip(response.body, { maxOutputLength: maxBytes }, callback);
      else if (encoding === "deflate")
        inflate(response.body, { maxOutputLength: maxBytes }, callback);
      else
        brotliDecompress(
          response.body,
          { maxOutputLength: maxBytes },
          callback,
        );
    }),
    signal,
  );
  response.headers.delete("content-encoding");
  response.headers.delete("content-length");
  return output;
}

/** A fetch-compatible, public-internet-only transport for isolated plugin workers.
 * No cookies, ambient proxies, custom dispatchers or reusable socket pools.
 */
export function createPublicFetch(
  options: WebTransportOptions = {},
): typeof fetch {
  return async (input, init) => {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      options.timeoutMs ?? 30_000,
    );
    let callerSignal: AbortSignal | undefined;
    try {
      let url = webUrl(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      // Copy ArrayBuffer views accepted by Node fetch to an owned buffer,
      // which is also compatible with the DOM Request constructor typings.
      let requestInit = init as RequestInit | undefined;
      if (init && ArrayBuffer.isView(init.body)) {
        requestInit = {
          ...init,
          body: new Uint8Array(
            new Uint8Array(
              init.body.buffer,
              init.body.byteOffset,
              init.body.byteLength,
            ),
          ),
        };
      }
      const request = new Request(input, requestInit);
      callerSignal = request.signal;
      const signal = AbortSignal.any([callerSignal, timeout.signal]);
      signal.throwIfAborted();
      let method = request.method.toUpperCase();
      if (!["GET", "POST", "HEAD"].includes(method))
        throw new WebTransportError("网页传输只支持 GET、HEAD 和 POST 请求。");
      let body = await requestBody(
        request,
        signal,
        options.maxRequestBytes ?? 1024 * 1024,
      );
      let headers = new Headers(request.headers);
      for (const name of FORBIDDEN_HEADERS) headers.delete(name);
      if (!headers.has("user-agent"))
        headers.set("user-agent", "Panel-Web/1.0");
      for (let redirects = 0; ; redirects++) {
        const response = await requestOnce(
          url,
          method,
          headers,
          body,
          signal,
          options,
        );
        if (REDIRECTS.has(response.status) && request.redirect !== "manual") {
          if (request.redirect === "error")
            throw new WebTransportError("请求不允许网页重定向。");
          const location = response.headers.get("location");
          if (location) {
            if (redirects >= 3)
              throw new WebTransportError("网页重定向超过 3 次，已停止请求。");
            const target = webUrl(new URL(location, url));
            if (
              (response.status === 303 && method !== "HEAD") ||
              ([301, 302].includes(response.status) && method === "POST")
            ) {
              method = "GET";
              body = undefined;
              headers.delete("content-type");
            }
            if (target.origin !== url.origin) {
              // 307/308 replay a body verbatim; that body could contain a key.
              if (body)
                throw new WebTransportError("已阻止携带请求内容的跨站重定向。");
              const publicHeaders = new Headers();
              for (const [name, value] of headers)
                if (PUBLIC_HEADERS.has(name)) publicHeaders.set(name, value);
              headers = publicHeaders;
            }
            url = target;
            continue;
          }
        }
        const decoded = await decodeResponse(
          response,
          signal,
          options.maxBytes ?? 20 * 1024 * 1024,
        );
        signal.throwIfAborted();
        const result = new Response(
          method === "HEAD" || [204, 205, 304].includes(response.status)
            ? null
            : new Uint8Array(decoded),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
        Object.defineProperties(result, {
          url: { value: url.href },
          redirected: { value: redirects > 0 },
        });
        return result;
      }
    } catch (error) {
      if (callerSignal?.aborted)
        throw new DOMException("网页操作已取消。", "AbortError");
      if (timeout.signal.aborted)
        throw new DOMException("网页请求超时。", "TimeoutError");
      if (error instanceof WebTransportError) throw error;
      // Never leak raw client/parser errors that may contain request credentials.
      throw new WebTransportError("网页请求失败，请检查网络连接或服务配置。");
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicFetch = createPublicFetch();
