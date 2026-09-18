// JSDOM's declarations load lib.dom, whose fetch body type excludes Node's
// ArrayBuffer views. Keep the Node-only server overload used by Pi's binary
// request encoder; this declaration does not alter browser types or runtime.
export {};

declare global {
  function fetch(
    input: string | URL | Request,
    init?: Omit<RequestInit, "body"> & {
      body?: RequestInit["body"] | NodeJS.ArrayBufferView;
    },
  ): Promise<Response>;
}
